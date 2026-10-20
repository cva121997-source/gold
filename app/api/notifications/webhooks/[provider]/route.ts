import { createHmac, timingSafeEqual } from "node:crypto";
import { createClient as createSupabaseClient } from "@supabase/supabase-js";
import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Provider = "resend" | "twilio" | "whatsapp";
type MappedStatus = "delivered" | "failed" | null;
type EventInput = {
  providerEventId: string;
  eventType: string;
  messageRef: string | null;
  status: MappedStatus;
  failureReason?: string | null;
};

function adminClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!url || !key) throw new Error("Server database configuration is missing.");
  return createSupabaseClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });
}

function equalText(left: string, right: string) {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length > 0 && a.length === b.length && timingSafeEqual(a, b);
}

function constantConfiguredSecret(left: string | undefined, right: string | undefined) {
  return Boolean(left?.trim() && right?.trim() && equalText(left.trim(), right.trim()));
}

function callbackUrl(provider: Provider) {
  if (provider === "twilio") {
    const exact = process.env.TWILIO_STATUS_CALLBACK_URL?.trim();
    if (exact) return exact;
  }
  const base = process.env.NOTIFICATION_PUBLIC_BASE_URL?.trim().replace(/\/+$/, "");
  if (!base) return "";
  try {
    const parsed = new URL(base);
    if (parsed.protocol !== "https:") return "";
    return base + "/api/notifications/webhooks/" + provider;
  } catch {
    return "";
  }
}

function decodeResendSecret(secret: string) {
  if (!secret.startsWith("whsec_")) return null;
  const key = Buffer.from(secret.slice("whsec_".length), "base64");
  return key.length ? key : null;
}

function verifyResend(request: NextRequest, rawBody: string) {
  const secret = process.env.RESEND_WEBHOOK_SECRET?.trim() ?? "";
  const key = decodeResendSecret(secret);
  if (!key) return { configured: false, valid: false };
  const id = request.headers.get("svix-id") ?? "";
  const timestamp = request.headers.get("svix-timestamp") ?? "";
  const signatures = request.headers.get("svix-signature") ?? "";
  const parsedTimestamp = Number(timestamp);
  if (!id || !Number.isInteger(parsedTimestamp) || Math.abs(Date.now() / 1000 - parsedTimestamp) > 300 || !signatures) {
    return { configured: true, valid: false };
  }
  const expected = createHmac("sha256", key).update(id + "." + timestamp + "." + rawBody, "utf8").digest("base64");
  const valid = signatures.split(/\s+/).some((part) => {
    const separator = part.indexOf(",");
    return separator > 0 && part.slice(0, separator) === "v1" && equalText(part.slice(separator + 1), expected);
  });
  return { configured: true, valid };
}

function verifyTwilio(request: NextRequest, params: URLSearchParams) {
  const secret = process.env.TWILIO_AUTH_TOKEN?.trim() ?? "";
  const signature = request.headers.get("x-twilio-signature") ?? "";
  const exactUrl = callbackUrl("twilio");
  if (!secret || !exactUrl) return { configured: false, valid: false };
  if (!signature) return { configured: true, valid: false };
  // Twilio signs the exact callback URL followed by form parameter names and values sorted by name.
  const keys = [...new Set([...params.keys()])].sort();
  let signed = exactUrl;
  for (const key of keys) {
    const values = params.getAll(key).sort();
    for (const value of values) signed += key + value;
  }
  const expected = createHmac("sha1", secret).update(signed, "utf8").digest("base64");
  return { configured: true, valid: equalText(signature, expected) };
}

function verifyWhatsApp(request: NextRequest, rawBody: string) {
  const secret = process.env.WHATSAPP_APP_SECRET?.trim() ?? "";
  if (!secret) return { configured: false, valid: false };
  const signature = request.headers.get("x-hub-signature-256") ?? "";
  if (!signature.startsWith("sha256=")) return { configured: true, valid: false };
  const expected = "sha256=" + createHmac("sha256", secret).update(rawBody, "utf8").digest("hex");
  return { configured: true, valid: equalText(signature, expected) };
}

function mapResend(type: string): MappedStatus {
  if (type === "email.delivered") return "delivered";
  if (["email.bounced", "email.complained", "email.failed", "email.suppressed"].includes(type)) return "failed";
  return null;
}

function mapTwilio(status: string): MappedStatus {
  if (status === "delivered" || status === "read") return "delivered";
  if (["undelivered", "failed"].includes(status)) return "failed";
  return null;
}

function mapWhatsApp(status: string): MappedStatus {
  if (["delivered", "read"].includes(status)) return "delivered";
  if (status === "failed") return "failed";
  return null;
}

async function writeEvent(admin: ReturnType<typeof adminClient>, provider: Provider, input: EventInput) {
  const baseEvent = {
    provider,
    provider_event_id: input.providerEventId.slice(0, 500),
    event_type: input.eventType.slice(0, 160),
    provider_message_ref: input.messageRef?.slice(0, 500) ?? null,
    mapped_status: input.status
  };
  let event: { id: string; processed_at: string | null } | null = null;
  const inserted = await admin.from("notification_provider_events").insert(baseEvent).select("id,processed_at").single();
  if (!inserted.error) {
    event = inserted.data as { id: string; processed_at: string | null };
  } else if (inserted.error.code === "23505") {
    const existing = await admin.from("notification_provider_events").select("id,processed_at")
      .eq("provider", provider).eq("provider_event_id", baseEvent.provider_event_id).maybeSingle();
    if (existing.error || !existing.data) throw new Error("Provider event ledger could not be read.");
    event = existing.data as { id: string; processed_at: string | null };
  } else {
    throw new Error("Provider event could not be recorded.");
  }

  if (event.processed_at) return { duplicate: true, matched: true };

  if (!input.messageRef || !input.status) {
    const saved = await admin.from("notification_provider_events").update({ processed_at: new Date().toISOString(), processing_error: null })
      .eq("id", event.id);
    if (saved.error) throw new Error("Provider event could not be marked processed.");
    return { duplicate: false, matched: true };
  }

  const channel = provider === "resend" ? "email" : provider === "twilio" ? "sms" : "whatsapp";
  const query = await admin.from("notifications").select("id,status,attempt_count,max_attempts")
    .eq("provider_message_ref", input.messageRef).eq("channel", channel).limit(20);
  if (query.error) {
    await admin.from("notification_provider_events").update({ processing_error: "Notification lookup failed." }).eq("id", event.id);
    throw new Error("Could not look up the matching notification.");
  }
  const rows = (query.data ?? []) as Array<{ id: string; status: string; attempt_count: number; max_attempts: number }>;
  if (rows.length === 0) {
    await admin.from("notification_provider_events").update({ processing_error: "Waiting for the outbound provider message reference to be saved." }).eq("id", event.id);
    return { duplicate: false, matched: false };
  }

  for (const row of rows) {
    // Do not let late callbacks overwrite a delivered, cancelled, or already terminal notification.
    if (!["sent", "processing"].includes(row.status)) continue;
    const change = input.status === "delivered"
      ? { status: "delivered", delivered_at: new Date().toISOString(), failure_reason: null, next_retry_at: null }
      : {
          status: "failed",
          failure_reason: (input.failureReason || ("Provider reported terminal delivery failure (" + input.eventType + ").")).slice(0, 240),
          next_retry_at: null,
          // This was accepted by the provider and failed downstream; do not re-enqueue and send a duplicate.
          attempt_count: Math.max(Number(row.attempt_count) || 0, Number(row.max_attempts) || 1)
        };
    const saved = await admin.from("notifications").update(change).eq("id", row.id).in("status", ["sent", "processing"]);
    if (saved.error) {
      await admin.from("notification_provider_events").update({ processing_error: "Notification status could not be updated." }).eq("id", event.id);
      throw new Error("Delivery status could not be saved.");
    }
  }

  const completed = await admin.from("notification_provider_events").update({ processed_at: new Date().toISOString(), processing_error: null }).eq("id", event.id);
  if (completed.error) throw new Error("Provider event could not be marked processed.");
  return { duplicate: false, matched: true };
}

function jsonObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

async function verifyWhatsAppChallenge(request: NextRequest) {
  const params = request.nextUrl.searchParams;
  const mode = params.get("hub.mode") ?? "";
  const token = params.get("hub.verify_token") ?? "";
  const challenge = params.get("hub.challenge") ?? "";
  const expected = process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN?.trim() ?? "";
  if (!expected) return new NextResponse("WhatsApp webhook verification is not configured.", { status: 503 });
  if (mode !== "subscribe" || !challenge || !constantConfiguredSecret(token, expected)) {
    return new NextResponse("Webhook verification failed.", { status: 403 });
  }
  return new NextResponse(challenge, { status: 200, headers: { "content-type": "text/plain; charset=utf-8" } });
}

async function handlePost(request: NextRequest, provider: Provider) {
  if (provider === "whatsapp") {
    let rawBody = "";
    try { rawBody = await request.text(); } catch { return NextResponse.json({ error: "Invalid webhook body." }, { status: 400 }); }
    const verification = verifyWhatsApp(request, rawBody);
    if (!verification.configured) return NextResponse.json({ error: "WhatsApp webhook verification is not configured." }, { status: 503 });
    if (!verification.valid) return NextResponse.json({ error: "Invalid WhatsApp webhook signature." }, { status: 401 });
    let parsed: unknown;
    try { parsed = JSON.parse(rawBody); } catch { return NextResponse.json({ error: "Invalid JSON payload." }, { status: 400 }); }
    const root = jsonObject(parsed);
    const entries = Array.isArray(root?.entry) ? root.entry : [];
    const admin = adminClient();
    let checked = 0;
    for (const entryValue of entries) {
      const entry = jsonObject(entryValue);
      const changes = Array.isArray(entry?.changes) ? entry.changes : [];
      for (const changeValue of changes) {
        const change = jsonObject(changeValue);
        const value = jsonObject(change?.value);
        const statuses = Array.isArray(value?.statuses) ? value.statuses : [];
        for (const statusValue of statuses) {
          const row = jsonObject(statusValue);
          const messageRef = typeof row?.id === "string" ? row.id : "";
          const status = typeof row?.status === "string" ? row.status : "unknown";
          const timestamp = typeof row?.timestamp === "string" ? row.timestamp : "unknown";
          if (!messageRef) continue;
          const mapped = mapWhatsApp(status);
          const eventId = "whatsapp:" + messageRef + ":" + status + ":" + timestamp;
          const result = await writeEvent(admin, "whatsapp", {
            providerEventId: eventId,
            eventType: "whatsapp.message.status." + status,
            messageRef,
            status: mapped,
            failureReason: status === "failed" ? "WhatsApp Cloud API reported a failed message delivery." : null
          });
          checked++;
          if (!result.matched) return NextResponse.json({ error: "Message reference is not available yet; retry the callback." }, { status: 503 });
        }
      }
    }
    return NextResponse.json({ ok: true, provider: "whatsapp", eventsChecked: checked });
  }

  if (provider === "resend") {
    const rawBody = await request.text();
    const verification = verifyResend(request, rawBody);
    if (!verification.configured) return NextResponse.json({ error: "Resend webhook verification is not configured." }, { status: 503 });
    if (!verification.valid) return NextResponse.json({ error: "Invalid Resend webhook signature." }, { status: 401 });
    let root: Record<string, unknown> | null = null;
    try { root = jsonObject(JSON.parse(rawBody)); } catch { /* handled below */ }
    if (!root) return NextResponse.json({ error: "Invalid JSON payload." }, { status: 400 });
    const eventType = typeof root.type === "string" ? root.type : "unknown";
    const data = jsonObject(root.data);
    const messageRef = typeof data?.email_id === "string" ? data.email_id : typeof data?.id === "string" ? data.id : "";
    const eventId = request.headers.get("svix-id") ?? "";
    if (!eventId) return NextResponse.json({ error: "Missing Resend event ID." }, { status: 400 });
    const mapped = mapResend(eventType);
    try {
      const result = await writeEvent(adminClient(), "resend", {
        providerEventId: eventId,
        eventType,
        messageRef: messageRef || null,
        status: mapped,
        failureReason: mapped === "failed" ? "Resend reported a terminal email delivery event (" + eventType + ")." : null
      });
      if (!result.matched) return NextResponse.json({ error: "Email reference is not available yet; retry the callback." }, { status: 503 });
      return NextResponse.json({ ok: true, provider: "resend", duplicate: result.duplicate });
    } catch (error) {
      return NextResponse.json({ error: error instanceof Error ? error.message : "Webhook could not be processed." }, { status: 500 });
    }
  }

  const form = new URLSearchParams();
  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().includes("application/x-www-form-urlencoded")) {
    return NextResponse.json({ error: "Twilio status callbacks must use form encoding." }, { status: 415 });
  }
  const formData = await request.formData();
  for (const [key, value] of formData.entries()) {
    if (typeof value !== "string") return NextResponse.json({ error: "Invalid Twilio callback parameters." }, { status: 400 });
    form.append(key, value);
  }
  const verification = verifyTwilio(request, form);
  if (!verification.configured) return NextResponse.json({ error: "Twilio callback URL or auth token is not configured." }, { status: 503 });
  if (!verification.valid) return NextResponse.json({ error: "Invalid Twilio webhook signature." }, { status: 401 });
  const messageRef = form.get("MessageSid") ?? "";
  const status = (form.get("MessageStatus") ?? form.get("SmsStatus") ?? "").toLowerCase();
  if (!messageRef || !status) return NextResponse.json({ error: "Missing Twilio message ID or status." }, { status: 400 });
  const mapped = mapTwilio(status);
  const errorCode = form.get("ErrorCode") ?? "";
  const eventId = "twilio:" + messageRef + ":" + status + ":" + errorCode;
  try {
    const result = await writeEvent(adminClient(), "twilio", {
      providerEventId: eventId,
      eventType: "twilio.message.status." + status,
      messageRef,
      status: mapped,
      failureReason: mapped === "failed" ? "Twilio reported terminal SMS delivery status " + status + (errorCode ? " (code " + errorCode + ")." : ".") : null
    });
    if (!result.matched) return NextResponse.json({ error: "SMS reference is not available yet; retry the callback." }, { status: 503 });
    return new NextResponse(null, { status: 204 });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Webhook could not be processed." }, { status: 500 });
  }
}

export async function GET(request: NextRequest, context: { params: Promise<{ provider: string }> }) {
  const { provider: rawProvider } = await context.params;
  if (rawProvider !== "whatsapp") return new NextResponse("Method not allowed.", { status: 405 });
  return verifyWhatsAppChallenge(request);
}

export async function POST(request: NextRequest, context: { params: Promise<{ provider: string }> }) {
  const { provider: rawProvider } = await context.params;
  if (!["resend", "twilio", "whatsapp"].includes(rawProvider)) return NextResponse.json({ error: "Unknown notification provider." }, { status: 404 });
  return handlePost(request, rawProvider as Provider);
}
