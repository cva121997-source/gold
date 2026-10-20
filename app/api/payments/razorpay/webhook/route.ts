import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { createClient as createSupabaseClient } from "@supabase/supabase-js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type JsonObject = Record<string, unknown>;
const isObject = (value: unknown): value is JsonObject => !!value && typeof value === "object" && !Array.isArray(value);
const getObject = (value: unknown): JsonObject => isObject(value) ? value : {};

function adminClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceKey) throw new Error("Supabase server access is not configured.");
  return createSupabaseClient(url, serviceKey, { auth: { autoRefreshToken: false, persistSession: false } });
}

function safeEqualHex(provided: string, expected: string) {
  if (!/^[0-9a-f]{64}$/i.test(provided) || !/^[0-9a-f]{64}$/i.test(expected)) return false;
  const providedBuffer = Buffer.from(provided, "hex");
  const expectedBuffer = Buffer.from(expected, "hex");
  return providedBuffer.length === expectedBuffer.length && timingSafeEqual(providedBuffer, expectedBuffer);
}

export async function POST(request: NextRequest) {
  const webhookSecret = process.env.RAZORPAY_WEBHOOK_SECRET;
  if (!webhookSecret) {
    // Provider retries are preferable to silently accepting captures without signature verification.
    return NextResponse.json({ error: "Razorpay webhook is not configured on this server." }, { status: 503 });
  }

  const rawBody = Buffer.from(await request.arrayBuffer());
  const signature = request.headers.get("x-razorpay-signature") ?? "";
  const expectedSignature = createHmac("sha256", webhookSecret).update(rawBody).digest("hex");
  if (!safeEqualHex(signature, expectedSignature)) {
    return NextResponse.json({ error: "Invalid Razorpay webhook signature." }, { status: 401 });
  }

  let payload: JsonObject;
  try {
    const parsed: unknown = JSON.parse(rawBody.toString("utf8"));
    if (!isObject(parsed)) return NextResponse.json({ error: "Webhook payload must be a JSON object." }, { status: 400 });
    payload = parsed;
  } catch {
    return NextResponse.json({ error: "Webhook payload must be valid JSON." }, { status: 400 });
  }

  const eventType = typeof payload.event === "string" ? payload.event : "";
  if (!eventType) return NextResponse.json({ error: "Webhook event type is missing." }, { status: 400 });

  const paymentEntity = getObject(getObject(getObject(payload.payload).payment).entity);
  const orderEntity = getObject(getObject(getObject(payload.payload).order).entity);
  const paymentId = typeof paymentEntity.id === "string" ? paymentEntity.id : null;
  const providerOrderRef =
    (typeof paymentEntity.order_id === "string" ? paymentEntity.order_id : null) ??
    (typeof orderEntity.id === "string" ? orderEntity.id : null);
  const amountPaise = typeof paymentEntity.amount === "number" ? Math.trunc(paymentEntity.amount) : null;
  const currency = typeof paymentEntity.currency === "string" ? paymentEntity.currency : null;

  // Razorpay supplies x-razorpay-event-id. Hash fallback is deterministic for safe duplicate handling.
  const providerEventId = request.headers.get("x-razorpay-event-id")?.trim() ||
    createHash("sha256").update(rawBody).digest("hex");
  const payloadHash = createHash("sha256").update(rawBody).digest("hex");
  const safePayload = {
    event: eventType,
    account_id: typeof payload.account_id === "string" ? payload.account_id : null,
    payment_id: paymentId,
    order_id: providerOrderRef,
    amount_paise: amountPaise,
    currency,
    payment_status: typeof paymentEntity.status === "string" ? paymentEntity.status : null,
    captured: paymentEntity.captured === true,
    created_at: typeof payload.created_at === "number" ? payload.created_at : null,
  };

  if (eventType === "payment.captured" && (!paymentId || !providerOrderRef || amountPaise === null || !currency)) {
    return NextResponse.json({ error: "Captured payment event is missing required provider fields." }, { status: 400 });
  }

  let admin;
  try {
    admin = adminClient();
  } catch {
    return NextResponse.json({ error: "Gold server database access is not configured." }, { status: 503 });
  }

  if (["refund.created", "refund.processed", "refund.failed", "refund.speed_changed"].includes(eventType)) {
    const refundEntity = getObject(getObject(getObject(payload.payload).refund).entity);
    const refundPaymentEntity = getObject(getObject(getObject(payload.payload).payment).entity);
    const refundId = typeof refundEntity.id === "string" ? refundEntity.id : "";
    const refundPaymentId = typeof refundEntity.payment_id === "string"
      ? refundEntity.payment_id
      : typeof refundPaymentEntity.id === "string" ? refundPaymentEntity.id : "";
    const refundAmount = typeof refundEntity.amount === "number" && Number.isInteger(refundEntity.amount)
      ? refundEntity.amount : null;
    const refundCurrency = typeof refundEntity.currency === "string"
      ? refundEntity.currency
      : typeof refundPaymentEntity.currency === "string" ? refundPaymentEntity.currency : "";
    const refundStatus = typeof refundEntity.status === "string" ? refundEntity.status : "";
    const acquirerData = getObject(refundEntity.acquirer_data);
    const refundArn = typeof acquirerData.arn === "string" ? acquirerData.arn : null;
    const failureReason = typeof refundEntity.error_description === "string"
      ? refundEntity.error_description
      : typeof refundEntity.error_reason === "string" ? refundEntity.error_reason : null;
    if (!/^rfnd_[A-Za-z0-9]+$/.test(refundId) || !/^pay_[A-Za-z0-9]+$/.test(refundPaymentId)
      || refundAmount === null || refundAmount <= 0 || refundCurrency !== "INR") {
      return NextResponse.json({ error: "Refund event is missing valid refund/payment references, amount or INR currency." }, { status: 400 });
    }
    const refundSafePayload = {
      event: eventType,
      refund_id: refundId,
      payment_id: refundPaymentId,
      amount_paise: refundAmount,
      currency: refundCurrency,
      refund_status: refundStatus || null,
      arn: refundArn,
      failure_reason: failureReason ? failureReason.slice(0, 240) : null,
      created_at: typeof payload.created_at === "number" ? payload.created_at : null
    };
    const result = await admin.rpc("process_razorpay_refund_webhook_event", {
      p_provider_event_id: providerEventId,
      p_event_type: eventType,
      p_refund_ref: refundId,
      p_payment_ref: refundPaymentId,
      p_amount_paise: refundAmount,
      p_currency: refundCurrency,
      p_refund_status: refundStatus,
      p_payload_hash: payloadHash,
      p_safe_payload: refundSafePayload
    });
    if (result.error) {
      console.error("Razorpay refund webhook processing failed", { message: result.error.message, code: result.error.code });
      return NextResponse.json({ error: "Verified refund event could not be processed. The provider should retry." }, { status: 500 });
    }
    const outcome = result.data && typeof result.data === "object" && "status" in result.data
      ? String((result.data as { status: unknown }).status) : "processed";
    if (["unmatched_refund", "ambiguous_refund", "refund_reference_conflict"].includes(outcome)) {
      return NextResponse.json({ error: "Refund event could not yet be safely matched to one approved Gold refund.", result: result.data }, { status: 503 });
    }
    return NextResponse.json({ received: true, result: result.data });
  }

  const { data, error } = await admin.rpc("process_razorpay_webhook_event", {
    p_provider_event_id: providerEventId,
    p_event_type: eventType,
    p_order_ref: providerOrderRef,
    p_payment_ref: paymentId,
    p_amount_paise: amountPaise,
    p_currency: currency,
    p_payload_hash: payloadHash,
    p_safe_payload: safePayload,
  });

  if (error) {
    // Return a retryable error only when the database could not atomically record/process the signed event.
    console.error("Razorpay webhook processing failed", { message: error.message, code: error.code });
    return NextResponse.json({ error: "Verified event could not be processed. The provider should retry." }, { status: 500 });
  }

  return NextResponse.json({ received: true, result: data });
}
