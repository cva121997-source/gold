import { NextRequest, NextResponse } from "next/server";
import { createClient as createSessionClient } from "@/lib/supabase/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

type JsonObject = Record<string, unknown>;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const object = (value: unknown): JsonObject | null =>
  value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : null;
const fail = (message: string, status: number) =>
  NextResponse.json({ error: message }, { status, headers: { "Cache-Control": "no-store" } });

export async function POST(request: NextRequest) {
  let session;
  try { session = await createSessionClient(); }
  catch { return fail("Supabase authentication is not configured.", 503); }

  const { data: { user }, error: authError } = await session.auth.getUser();
  if (authError || !user) return fail("Sign in to start a gateway refund.", 401);

  let body: JsonObject;
  try {
    const parsed: unknown = await request.json();
    const parsedObject = object(parsed);
    if (!parsedObject) return fail("Request body must be a JSON object.", 400);
    body = parsedObject;
  } catch { return fail("Request body must be valid JSON.", 400); }

  const tenantId = typeof body.tenantId === "string" ? body.tenantId : "";
  const refundId = typeof body.refundId === "string" ? body.refundId : "";
  if (!UUID.test(tenantId) || !UUID.test(refundId)) return fail("A valid shop and refund identifier are required.", 400);

  const keyId = process.env.RAZORPAY_KEY_ID?.trim();
  const keySecret = process.env.RAZORPAY_KEY_SECRET?.trim();
  if (!keyId || !keySecret) {
    return fail("Razorpay refund processing is not configured on the server. The approved refund has not been submitted.", 503);
  }

  // This database RPC verifies the caller's role and locks the approved refund.
  // Repeated requests return the same idempotency key and exact request amount.
  const { data: startData, error: startError } = await session.rpc("begin_razorpay_gateway_refund", {
    p_tenant_id: tenantId,
    p_refund_id: refundId
  });
  if (startError) {
    const message = startError.message ?? "";
    const status = /permission denied|authentication required/i.test(message) ? 403 : /not found/i.test(message) ? 404 : 409;
    return fail(message && message.length < 240 ? message : "Refund is not approved for Razorpay processing.", status);
  }
  const started = object(startData);
  const providerPaymentRef = typeof started?.provider_payment_ref === "string" ? started.provider_payment_ref : "";
  const idempotencyKey = typeof started?.idempotency_key === "string" ? started.idempotency_key : "";
  const amountPaise = typeof started?.amount_paise === "number" ? started.amount_paise : Number(started?.amount_paise);
  if (!/^pay_[A-Za-z0-9]+$/.test(providerPaymentRef)
    || !/^[A-Za-z0-9_-]{10,150}$/.test(idempotencyKey)
    || !Number.isSafeInteger(amountPaise) || amountPaise < 100) {
    return fail("The reserved refund record did not contain a valid provider payment, amount or idempotency key.", 500);
  }

  const auth = Buffer.from(keyId + ":" + keySecret, "utf8").toString("base64");
  const receipt = "goldr" + refundId.replaceAll("-", "");
  let response: Response;
  let providerBody: JsonObject | null;
  try {
    response = await fetch("https://api.razorpay.com/v1/payments/" + encodeURIComponent(providerPaymentRef) + "/refund", {
      method: "POST",
      headers: {
        Authorization: "Basic " + auth,
        "Content-Type": "application/json",
        "X-Refund-Idempotency": idempotencyKey
      },
      body: JSON.stringify({
        amount: amountPaise,
        receipt,
        notes: { gold_refund_id: refundId, gold_tenant_id: tenantId }
      }),
      cache: "no-store",
      signal: AbortSignal.timeout(20000)
    });
    const parsed: unknown = await response.json().catch(() => null);
    providerBody = object(parsed);
  } catch {
    // Network timeout is an unknown outcome. Leave the request processing so a retry
    // reuses the same provider idempotency key and cannot issue a second payout.
    return NextResponse.json({
      ok: false,
      status: "processing",
      retryable: true,
      message: "Razorpay did not return a conclusive response. Retry safely; the same idempotency key will be reused."
    }, { status: 202, headers: { "Cache-Control": "no-store" } });
  }

  const providerRefundRef = typeof providerBody?.id === "string" ? providerBody.id : "";
  const providerStatus = typeof providerBody?.status === "string" ? providerBody.status.toLowerCase() : "";
  const acquirer = object(providerBody?.acquirer_data);
  const arn = typeof acquirer?.arn === "string" ? acquirer.arn : null;

  if (!response.ok) {
    const errorBody = object(providerBody?.error);
    const code = typeof errorBody?.code === "string" ? errorBody.code : "";
    const description = typeof errorBody?.description === "string" ? errorBody.description : "";
    // A 409 can mean the first identical request is still running. Do not mark it failed.
    if (response.status === 409 || response.status === 429 || response.status >= 500) {
      return NextResponse.json({
        ok: false,
        status: "processing",
        retryable: true,
        message: response.status === 409
          ? "Razorpay is still processing the idempotent refund request. Retry using the same request."
          : "Razorpay has not returned a final result. Retry safely with the same request."
      }, { status: 202, headers: { "Cache-Control": "no-store" } });
    }
    // Definite provider rejection is terminal; release the reservation so staff can
    // review the rejection and raise a new request if appropriate.
    const { error: recordError } = await session.rpc("record_razorpay_gateway_refund_result", {
      p_tenant_id: tenantId,
      p_refund_id: refundId,
      p_provider_ref: null,
      p_provider_status: "failed",
      p_external_reference: null,
      p_safe_error: (description || code || "Razorpay rejected the refund request.") .slice(0, 240)
    });
    if (recordError) {
      return fail("Razorpay rejected the refund and the outcome could not be reconciled. Keep the request for manual review.", 502);
    }
    return NextResponse.json({
      ok: false,
      status: "failed",
      message: description && description.length < 240 ? description : "Razorpay rejected the refund request. Review the gateway details before requesting again."
    }, { status: 422, headers: { "Cache-Control": "no-store" } });
  }

  if (!/^rfnd_[A-Za-z0-9]+$/.test(providerRefundRef) || !["pending", "processed", "failed"].includes(providerStatus)) {
    // An unexpected 2xx payload is not proof of a refund. Leave as processing for reconciliation.
    return NextResponse.json({
      ok: false,
      status: "processing",
      retryable: true,
      message: "Razorpay accepted a response, but its refund reference/status was incomplete. Check the provider dashboard and retry safely."
    }, { status: 202, headers: { "Cache-Control": "no-store" } });
  }

  const { data: finalData, error: finalError } = await session.rpc("record_razorpay_gateway_refund_result", {
    p_tenant_id: tenantId,
    p_refund_id: refundId,
    p_provider_ref: providerRefundRef,
    p_provider_status: providerStatus,
    p_external_reference: arn,
    p_safe_error: providerStatus === "failed" ? "Razorpay returned failed status." : null
  });
  if (finalError) {
    // A signed webhook may have raced this response. Do not falsely say it failed or
    // mark it complete here; leave it for webhook/ledger reconciliation.
    return NextResponse.json({
      ok: false,
      status: "processing",
      retryable: true,
      message: "The provider response was received but could not yet be synchronized with Gold. Check the refund queue before retrying."
    }, { status: 202, headers: { "Cache-Control": "no-store" } });
  }
  const final = object(finalData);
  const status = typeof final?.status === "string" ? final.status : providerStatus === "processed" ? "completed" : providerStatus === "failed" ? "failed" : "processing";
  return NextResponse.json({
    ok: true,
    status,
    providerRefundReference: providerRefundRef,
    message: status === "completed"
      ? "Razorpay confirmed the refund as processed."
      : status === "failed"
        ? "Razorpay reported a failed refund. The reservation is released; review the details before creating another request."
        : "Razorpay accepted the refund request. Gold will mark it completed only after provider confirmation."
  }, { headers: { "Cache-Control": "no-store" } });
}
