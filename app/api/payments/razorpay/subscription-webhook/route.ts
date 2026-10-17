import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { createClient as createSupabaseClient } from "@supabase/supabase-js";
import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 20;

type Json = Record<string, unknown>;
function object(value: unknown): Json | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Json : null;
}
function epoch(value: unknown): string | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return null;
  const date = new Date(value * 1000);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}
function adminClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("Server Supabase configuration is missing.");
  return createSupabaseClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });
}
function validSignature(body: string, signature: string, secret: string) {
  const expected = createHmac("sha256", secret).update(body, "utf8").digest();
  let received: Buffer;
  try { received = Buffer.from(signature, "hex"); } catch { return false; }
  return expected.length === received.length && received.length > 0 && timingSafeEqual(expected, received);
}
function mapStatus(eventType: string, entity: Json): "pending" | "active" | "past_due" | "cancelled" | "suspended" | null {
  if (eventType === "subscription.activated" || eventType === "subscription.charged" || eventType === "subscription.resumed") return "active";
  if (eventType === "subscription.cancelled" || eventType === "subscription.completed") return "cancelled";
  if (eventType === "subscription.halted") return "past_due";
  if (eventType === "subscription.paused") return "suspended";
  if (eventType === "subscription.created" || eventType === "subscription.pending" || eventType === "subscription.authenticated") return "pending";
  const state = typeof entity.status === "string" ? entity.status : "";
  if (state === "active") return "active";
  if (state === "halted") return "past_due";
  if (state === "paused") return "suspended";
  if (state === "cancelled" || state === "completed" || state === "expired") return "cancelled";
  if (state === "created" || state === "authenticated" || state === "pending") return "pending";
  return null;
}

export async function POST(request: NextRequest) {
  const secret = process.env.RAZORPAY_SUBSCRIPTION_WEBHOOK_SECRET?.trim()
    || process.env.RAZORPAY_WEBHOOK_SECRET?.trim();
  if (!secret) return NextResponse.json({ error: "Subscription webhook secret is not configured." }, { status: 503 });
  const rawBody = await request.text();
  const signature = request.headers.get("x-razorpay-signature") ?? "";
  if (!signature || !validSignature(rawBody, signature, secret)) {
    return NextResponse.json({ error: "Invalid webhook signature." }, { status: 401 });
  }

  let payload: Json;
  try {
    const parsed = object(JSON.parse(rawBody));
    if (!parsed) throw new Error("Body must be an object.");
    payload = parsed;
  } catch {
    return NextResponse.json({ error: "Webhook body must be a valid JSON object." }, { status: 400 });
  }

  let admin: ReturnType<typeof adminClient>;
  try { admin = adminClient(); } catch {
    return NextResponse.json({ error: "Server database configuration is missing." }, { status: 503 });
  }
  const eventType = typeof payload.event === "string" ? payload.event : "";
  const payloads = object(payload.payload);
  const subscriptionBlock = object(payloads?.subscription);
  const entity = object(subscriptionBlock?.entity);
  const subscriptionRef = typeof entity?.id === "string" ? entity.id : null;
  const eventTime = epoch(payload.created_at) ?? new Date().toISOString();
  const bodyHash = createHash("sha256").update(rawBody, "utf8").digest("hex");
  const headerEventId = request.headers.get("x-razorpay-event-id")?.trim() ?? "";
  const eventId = /^[a-zA-Z0-9_-]{1,150}$/.test(headerEventId) ? headerEventId : bodyHash;

  const inserted = await admin.from("subscription_webhook_events").insert({
    event_id: eventId, event_type: eventType || "unknown", provider_subscription_ref: subscriptionRef,
    status: "processing", body_sha256: bodyHash, updated_at: new Date().toISOString()
  });
  if (inserted.error) {
    if (inserted.error.code !== "23505") {
      return NextResponse.json({ error: "Could not persist subscription webhook event." }, { status: 500 });
    }
    const { data: prior, error: priorError } = await admin.from("subscription_webhook_events")
      .select("event_id,status,updated_at").or("event_id.eq." + eventId + ",body_sha256.eq." + bodyHash).limit(1).maybeSingle();
    if (priorError) return NextResponse.json({ error: "Could not inspect duplicate webhook event." }, { status: 500 });
    if (prior?.status === "processed" || prior?.status === "ignored") {
      return NextResponse.json({ ok: true, duplicate: true });
    }
    const isStaleProcessing = prior?.status === "processing" && Date.now() - new Date(prior.updated_at).getTime() > 5 * 60 * 1000;
    if (prior?.status === "processing" && !isStaleProcessing) {
      return NextResponse.json({ ok: true, duplicate: true, processing: true }, { status: 202 });
    }
    const { error: retryError } = await admin.from("subscription_webhook_events").update({
      status: "processing", safe_error: null, updated_at: new Date().toISOString()
    }).eq("event_id", prior?.event_id ?? eventId);
    if (retryError) return NextResponse.json({ error: "Could not resume webhook processing." }, { status: 500 });
  }

  const status = entity ? mapStatus(eventType, entity) : null;
  if (!subscriptionRef || !entity || !status) {
    await admin.from("subscription_webhook_events").update({
      status: "ignored", safe_error: subscriptionRef ? "Unsupported subscription event." : "No subscription reference in event.",
      processed_at: new Date().toISOString(), updated_at: new Date().toISOString()
    }).eq("event_id", eventId);
    return NextResponse.json({ ok: true, ignored: true });
  }

  const cancelAtPeriodEnd = typeof entity.cancel_at_cycle_end === "boolean"
    ? entity.cancel_at_cycle_end
    : typeof entity.cancel_at_period_end === "boolean" ? entity.cancel_at_period_end : null;
  const customerRef = typeof entity.customer_id === "string" ? entity.customer_id : null;
  const { data: subscriptionId, error: applyError } = await admin.rpc("apply_razorpay_subscription_event", {
    p_subscription_ref: subscriptionRef,
    p_status: status,
    p_event_at: eventTime,
    p_period_start: epoch(entity.current_start),
    p_period_end: epoch(entity.current_end) ?? epoch(entity.charge_at) ?? epoch(entity.end_at),
    p_cancel_at_period_end: cancelAtPeriodEnd,
    p_customer_ref: customerRef
  });
  if (applyError) {
    await admin.from("subscription_webhook_events").update({
      status: "failed", safe_error: "Database subscription state processor failed.",
      updated_at: new Date().toISOString()
    }).eq("event_id", eventId);
    return NextResponse.json({ error: "Could not apply subscription event; provider may retry." }, { status: 500 });
  }

  const finalStatus = subscriptionId ? "processed" : "ignored";
  await admin.from("subscription_webhook_events").update({
    status: finalStatus, safe_error: subscriptionId ? null : "No local subscription matched this provider subscription reference.",
    processed_at: new Date().toISOString(), updated_at: new Date().toISOString()
  }).eq("event_id", eventId);
  return NextResponse.json({ ok: true, status: finalStatus });
}

export async function GET() {
  return NextResponse.json({ error: "POST a signature-verified Razorpay subscription webhook." }, { status: 405 });
}
