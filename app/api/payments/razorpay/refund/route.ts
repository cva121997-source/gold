import { NextRequest, NextResponse } from "next/server";
import { createClient as createSessionClient } from "@/lib/supabase/server";
import { createClient as createSupabaseClient } from "@supabase/supabase-js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

type JsonObject = Record<string, unknown>;
type RefundCandidate = { id?: string; status?: string; amount?: number; currency?: string; payment_id?: string; receipt?: string | null; notes?: JsonObject; acquirer_data?: JsonObject; error?: JsonObject };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const object = (value: unknown): JsonObject | null => value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : null;
const fail = (message: string, status: number) => NextResponse.json({ error: message }, { status, headers: { "Cache-Control": "no-store" } });

function adminClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!url || !key) throw new Error("Server database access is not configured.");
  return createSupabaseClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });
}

function providerStatus(item: RefundCandidate) {
  const status = (item.status ?? "").toLowerCase();
  if (status === "processed") return "processed";
  if (status === "failed") return "failed";
  return "pending";
}

async function saveProviderOutcome(
  tenantId: string, refundId: string, candidate: RefundCandidate | null,
  status: "pending" | "processed" | "failed", safeError: string | null = null
) {
  const admin = adminClient();
  const acquirer = object(candidate?.acquirer_data);
  const { data, error } = await admin.rpc("record_razorpay_gateway_refund_result", {
    p_tenant_id: tenantId,
    p_refund_id: refundId,
    p_provider_ref: typeof candidate?.id === "string" ? candidate.id : null,
    p_provider_status: status,
    p_external_reference: typeof acquirer?.arn === "string" ? acquirer.arn : typeof acquirer?.rrn === "string" ? acquirer.rrn : null,
    p_safe_error: safeError?.slice(0, 240) ?? null
  });
  if (error) throw new Error("The provider outcome could not be securely saved.");
  const row = object(data);
  return typeof row?.status === "string" ? row.status : status === "processed" ? "completed" : status === "failed" ? "failed" : "processing";
}

function findMatchingRefund(items: unknown, refundId: string, receipt: string, paymentRef: string, amountPaise: number): RefundCandidate | null {
  if (!Array.isArray(items)) return null;
  for (const itemValue of items) {
    const item = object(itemValue) as RefundCandidate | null;
    if (!item) continue;
    const notes = object(item.notes);
    if (item.payment_id !== paymentRef || item.amount !== amountPaise) continue;
    if (item.receipt !== receipt && notes?.gold_refund_id !== refundId) continue;
    if (typeof item.id !== "string" || !/^rfnd_[A-Za-z0-9]+$/.test(item.id)) continue;
    return item;
  }
  return null;
}

async function fetchExistingRefund(
  paymentRef: string, receipt: string, refundId: string, amountPaise: number, auth: string
): Promise<{ candidate: RefundCandidate | null; lookupSucceeded: boolean }> {
  try {
    const response = await fetch("https://api.razorpay.com/v1/payments/" + encodeURIComponent(paymentRef) + "/refunds?count=100", {
      method: "GET",
      headers: { Authorization: "Basic " + auth },
      cache: "no-store",
      signal: AbortSignal.timeout(12000)
    });
    if (!response.ok) return { candidate: null, lookupSucceeded: false };
    const parsed: unknown = await response.json().catch(() => null);
    const root = object(parsed);
    return { candidate: findMatchingRefund(root?.items, refundId, receipt, paymentRef, amountPaise), lookupSucceeded: !!root };
  } catch {
    return { candidate: null, lookupSucceeded: false };
  }
}

export async function POST(request: NextRequest) {
  let session;
  try { session = await createSessionClient(); }
  catch { return fail("Supabase authentication is not configured.", 503); }

  const { data: { user }, error: authError } = await session.auth.getUser();
  if (authError || !user) return fail("Sign in to start a gateway refund.", 401);

  let body: JsonObject;
  try {
    const parsed = object(await request.json());
    if (!parsed) return fail("Request body must be a JSON object.", 400);
    body = parsed;
  } catch { return fail("Request body must be valid JSON.", 400); }

  const tenantId = typeof body.tenantId === "string" ? body.tenantId : "";
  const refundId = typeof body.refundId === "string" ? body.refundId : "";
  if (!UUID.test(tenantId) || !UUID.test(refundId)) return fail("A valid shop and refund identifier are required.", 400);

  const keyId = process.env.RAZORPAY_KEY_ID?.trim();
  const keySecret = process.env.RAZORPAY_KEY_SECRET?.trim();
  if (!keyId || !keySecret) return fail("Razorpay refund processing is not configured on the server. The approved refund has not been submitted.", 503);

  // This authenticated RPC checks shop role and locks the approved refund. It explicitly
  // permits only one POST submission; later calls reconcile against Razorpay's refund list.
  const { data: startData, error: startError } = await session.rpc("begin_razorpay_gateway_refund", {
    p_tenant_id: tenantId, p_refund_id: refundId
  });
  if (startError) {
    const message = startError.message ?? "";
    const status = /permission denied|authentication required/i.test(message) ? 403 : /not found/i.test(message) ? 404 : 409;
    return fail(message && message.length < 240 ? message : "Refund is not approved for Razorpay processing.", status);
  }
  const started = object(startData);
  const providerPaymentRef = typeof started?.provider_payment_ref === "string" ? started.provider_payment_ref : "";
  const receipt = typeof started?.receipt === "string" ? started.receipt : "";
  const idempotencyKey = typeof started?.idempotency_key === "string" ? started.idempotency_key : "";
  const amountPaise = typeof started?.amount_paise === "number" ? started.amount_paise : Number(started?.amount_paise);
  const submissionAllowed = started?.submission_allowed === true;
  if (!/^pay_[A-Za-z0-9]+$/.test(providerPaymentRef) || !/^goldr[a-f0-9]{32}$/i.test(receipt)
    || !/^[A-Za-z0-9_-]{10,150}$/.test(idempotencyKey)
    || !Number.isSafeInteger(amountPaise) || amountPaise < 100) {
    return fail("The reserved refund record did not contain a valid provider payment, amount or reference.", 500);
  }

  const auth = Buffer.from(keyId + ":" + keySecret, "utf8").toString("base64");
  if (!submissionAllowed) {
    // Do not blindly POST a second time: the Refunds API does not document the
    // X-Refund-Idempotency header. A receipt + note is reconciled before any manual action.
    const existing = await fetchExistingRefund(providerPaymentRef, receipt, refundId, amountPaise, auth);
    if (!existing.lookupSucceeded) {
      return NextResponse.json({ ok: false, status: "processing", retryable: true,
        message: "Could not reconcile the existing refund with Razorpay. No second refund was submitted." },
        { status: 202, headers: { "Cache-Control": "no-store" } });
    }
    if (!existing.candidate) {
      return NextResponse.json({ ok: false, status: "processing", retryable: true,
        message: "No matching refund is visible yet. Gold will not submit another payout automatically; retry reconciliation or check the Razorpay Dashboard." },
        { status: 202, headers: { "Cache-Control": "no-store" } });
    }
    try {
      const status = await saveProviderOutcome(tenantId, refundId, existing.candidate, providerStatus(existing.candidate),
        providerStatus(existing.candidate) === "failed" ? "Razorpay reports this refund failed." : null);
      return NextResponse.json({ ok: true, status, providerRefundReference: existing.candidate.id,
        message: status === "completed" ? "Razorpay confirms this refund is processed." :
          status === "failed" ? "Razorpay reports the refund failed." : "Existing Razorpay refund found and reconciled." },
        { headers: { "Cache-Control": "no-store" } });
    } catch {
      return NextResponse.json({ ok: false, status: "processing", retryable: true,
        message: "Razorpay refund was found, but Gold could not save the result. Reconcile again; no new refund was sent." },
        { status: 202, headers: { "Cache-Control": "no-store" } });
    }
  }

  let response: Response;
  let providerBody: JsonObject | null;
  try {
    response = await fetch("https://api.razorpay.com/v1/payments/" + encodeURIComponent(providerPaymentRef) + "/refund", {
      method: "POST",
      headers: { Authorization: "Basic " + auth, "Content-Type": "application/json" },
      body: JSON.stringify({
        amount: amountPaise,
        receipt,
        notes: { gold_refund_id: refundId, gold_tenant_id: tenantId }
      }),
      cache: "no-store",
      signal: AbortSignal.timeout(20000)
    });
    providerBody = object(await response.json().catch(() => null));
  } catch {
    return NextResponse.json({ ok: false, status: "processing", retryable: true,
      message: "Razorpay did not return a conclusive response. Retry to reconcile by receipt; Gold will not send a second refund automatically." },
      { status: 202, headers: { "Cache-Control": "no-store" } });
  }

  if (!response.ok) {
    // First reconcile before declaring an API error terminal: a duplicate receipt or a
    // provider-side race can still mean the refund exists.
    const existing = await fetchExistingRefund(providerPaymentRef, receipt, refundId, amountPaise, auth);
    if (existing.candidate) {
      try {
        const status = await saveProviderOutcome(tenantId, refundId, existing.candidate, providerStatus(existing.candidate));
        return NextResponse.json({ ok: true, status, providerRefundReference: existing.candidate.id,
          message: "Existing Razorpay refund was reconciled after the response." },
          { headers: { "Cache-Control": "no-store" } });
      } catch {
        return NextResponse.json({ ok: false, status: "processing", retryable: true,
          message: "The refund may exist but could not be synchronized. Reconcile again; no second refund was sent." },
          { status: 202, headers: { "Cache-Control": "no-store" } });
      }
    }
    const errorBody = object(providerBody?.error);
    const code = typeof errorBody?.code === "string" ? errorBody.code : "";
    const description = typeof errorBody?.description === "string" ? errorBody.description : "";
    if (response.status === 409 || response.status === 429 || response.status >= 500 || !existing.lookupSucceeded) {
      return NextResponse.json({ ok: false, status: "processing", retryable: true,
        message: "Razorpay has not returned a conclusive refund outcome. Reconcile before any further submission." },
        { status: 202, headers: { "Cache-Control": "no-store" } });
    }
    try {
      await saveProviderOutcome(tenantId, refundId, null, "failed",
        description || code || "Razorpay rejected the refund request.");
    } catch {
      return fail("Razorpay rejected the request but Gold could not save the provider outcome. Reconcile manually.", 502);
    }
    return NextResponse.json({ ok: false, status: "failed",
      message: description && description.length < 240 ? description : "Razorpay rejected the refund request. Review the gateway details before requesting again." },
      { status: 422, headers: { "Cache-Control": "no-store" } });
  }

  const candidate = providerBody as RefundCandidate | null;
  const resultStatus = candidate ? providerStatus(candidate) : "pending";
  const reference = typeof candidate?.id === "string" && /^rfnd_[A-Za-z0-9]+$/.test(candidate.id);
  if (!candidate || !reference || candidate.payment_id !== providerPaymentRef || candidate.amount !== amountPaise) {
    return NextResponse.json({ ok: false, status: "processing", retryable: true,
      message: "Razorpay returned a response that could not be matched safely. Reconcile by receipt before taking action." },
      { status: 202, headers: { "Cache-Control": "no-store" } });
  }
  try {
    const status = await saveProviderOutcome(tenantId, refundId, candidate, resultStatus,
      resultStatus === "failed" ? "Razorpay returned a failed refund status." : null);
    return NextResponse.json({ ok: true, status, providerRefundReference: candidate.id,
      message: status === "completed" ? "Razorpay confirmed the refund as processed." :
        status === "failed" ? "Razorpay reported a failed refund." : "Razorpay accepted the refund request; its current status is processing." },
      { headers: { "Cache-Control": "no-store" } });
  } catch {
    return NextResponse.json({ ok: false, status: "processing", retryable: true,
      message: "The provider response was received but could not yet be synchronized with Gold. Reconcile the existing refund; do not create another." },
      { status: 202, headers: { "Cache-Control": "no-store" } });
  }
}
