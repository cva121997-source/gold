import { timingSafeEqual } from "node:crypto";
import { createClient as createSupabaseClient } from "@supabase/supabase-js";
import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

type Notification = {
  id: string; tenant_id: string; customer_id: string | null; recipient_user_id: string | null;
  channel: "sms" | "whatsapp" | "email" | "in_app"; notification_type: string; status: string;
  destination_snapshot: string | null; template_key: string | null; language_code: string;
  safe_payload: Record<string, unknown>; attempt_count: number; max_attempts: number;
};
type Template = { subject: string | null; body: string; provider_template_ref: string | null; language_code: string };
type Customer = { id: string; customer_code: string; full_name: string; mobile_e164: string; email: string | null; communication_consent: Record<string, unknown> };
type Json = Record<string, unknown>;

const str = (value: unknown) => typeof value === "string" ? value : "";
const normalize = (value: string) => value.trim();

function sameSecret(got: string, expected: string) {
  const a = Buffer.from(got); const b = Buffer.from(expected);
  return a.length > 0 && a.length === b.length && timingSafeEqual(a, b);
}
function adminClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("Server Supabase configuration is missing.");
  return createSupabaseClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });
}
function escapeHtml(value: string) {
  return value.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char] ?? char);
}
function interpolate(template: string, payload: Json, customer?: Customer) {
  const data: Json = { ...payload, customer_name: customer?.full_name ?? "", customer_code: customer?.customer_code ?? "" };
  return template.replace(/\{\{\s*([a-zA-Z0-9_.-]{1,80})\s*\}\}/g, (_match, key: string) => {
    const value = key.split(".").reduce<unknown>((cur, part) =>
      cur && typeof cur === "object" ? (cur as Record<string, unknown>)[part] : undefined, data);
    if (value === null || value === undefined || typeof value === "object") return "";
    return String(value).slice(0, 2000);
  }).slice(0, 12000);
}
function emailAddress(value: string) {
  const v = value.trim();
  return v.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v) ? v : "";
}
function e164(value: string) {
  const v = value.trim().replace(/[\s()-]/g, "");
  return /^\+[1-9]\d{7,14}$/.test(v) ? v : "";
}
function marketingType(value: string) {
  return /(marketing|promotion|promotional|campaign|newsletter|special_offer|offers)/i.test(value);
}

async function findTemplate(admin: ReturnType<typeof adminClient>, row: Notification): Promise<Template | null> {
  if (!row.template_key) return null;
  const fields = "subject,body,provider_template_ref,language_code";
  const specific = await admin.from("notification_templates").select(fields).eq("tenant_id", row.tenant_id)
    .eq("template_key", row.template_key).eq("channel", row.channel).eq("language_code", row.language_code)
    .eq("is_active", true).limit(1).maybeSingle();
  if (specific.error) throw new Error("Could not load the active shop message template.");
  if (specific.data) return specific.data as Template;
  const fallback = await admin.from("notification_templates").select(fields).is("tenant_id", null)
    .eq("template_key", row.template_key).eq("channel", row.channel).eq("language_code", row.language_code)
    .eq("is_active", true).limit(1).maybeSingle();
  if (fallback.error) throw new Error("Could not load the active default message template.");
  return fallback.data as Template | null;
}

async function contactAndConsent(admin: ReturnType<typeof adminClient>, row: Notification) {
  let customer: Customer | null = null;
  let destination = normalize(row.destination_snapshot ?? "");
  if (row.customer_id) {
    const { data, error } = await admin.from("tenant_customers")
      .select("id,customer_code,full_name,mobile_e164,email,communication_consent")
      .eq("tenant_id", row.tenant_id).eq("id", row.customer_id).maybeSingle();
    if (error || !data) throw new Error("Customer contact is not available for this shop.");
    customer = data as Customer;
  }
  let userEmail: string | null = null;
  let userPhone: string | null = null;
  if (!destination && row.recipient_user_id) {
    const { data, error } = await admin.auth.admin.getUserById(row.recipient_user_id);
    if (error || !data.user) throw new Error("Notification recipient contact is unavailable.");
    userEmail = data.user.email ?? null;
    userPhone = typeof data.user.phone === "string" ? data.user.phone : null;
  }
  if (!destination) {
    if (row.channel === "email") destination = customer?.email ?? userEmail ?? "";
    else if (row.channel === "sms" || row.channel === "whatsapp") destination = customer?.mobile_e164 ?? userPhone ?? "";
  }
  if (row.channel === "in_app") return { customer, destination, consentOk: true, consentReason: null };

  const customerPreference = customer?.communication_consent?.[row.channel];
  const explicitPreference = typeof customerPreference === "boolean" ? customerPreference : null;
  let channelConsent: boolean | null = null;
  let promotionConsent: boolean | null = null;
  if (row.customer_id) {
    const { data: channelRows, error: channelError } = await admin.from("customer_consents")
      .select("consented,withdrawn_at,captured_at").eq("tenant_id", row.tenant_id).eq("customer_id", row.customer_id)
      .eq("consent_type", row.channel).order("captured_at", { ascending: false }).limit(1);
    if (channelError) throw new Error("Could not verify the customer's latest communication consent.");
    if (channelRows?.length) channelConsent = channelRows[0].consented === true && !channelRows[0].withdrawn_at;
    if (marketingType(row.notification_type)) {
      const { data: promoRows, error: promoError } = await admin.from("customer_consents")
        .select("consented,withdrawn_at,captured_at").eq("tenant_id", row.tenant_id).eq("customer_id", row.customer_id)
        .eq("consent_type", "promotional").order("captured_at", { ascending: false }).limit(1);
      if (promoError) throw new Error("Could not verify promotional consent.");
      if (promoRows?.length) promotionConsent = promoRows[0].consented === true && !promoRows[0].withdrawn_at;
    }
  }
  if (explicitPreference === false || channelConsent === false || promotionConsent === false) {
    return { customer, destination, consentOk: false, consentReason: "Delivery suppressed because current communication consent is withdrawn or disabled." };
  }
  const transactional = /(receipt|payment|transaction|otp|security|account_activation|password_reset|scheme_enrolment|due_reminder|installment_reminder)/i.test(row.notification_type);
  const hasChannelConsent = explicitPreference === true || channelConsent === true;
  const hasPromoConsent = !marketingType(row.notification_type) || promotionConsent === true;
  const consentOk = marketingType(row.notification_type)
    ? hasChannelConsent && promotionConsent === true
    : hasChannelConsent || (transactional && channelConsent !== false && explicitPreference !== false);
  return {
    customer, destination, consentOk,
    consentReason: consentOk ? null : "Delivery suppressed because required channel/promotional consent is not recorded."
  };
}

async function sendEmail(to: string, subject: string, body: string) {
  const key = process.env.RESEND_API_KEY?.trim() ?? "";
  const from = process.env.RESEND_FROM_EMAIL?.trim() ?? "";
  if (!key || !from) throw new Error("Email provider credentials or sender are not configured.");
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST", redirect: "error", cache: "no-store", signal: AbortSignal.timeout(15000),
    headers: { authorization: "Bearer " + key, "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ from, to: [to], subject: subject.slice(0, 200), text: body })
  });
  if (!response.ok) throw new Error("Email provider returned HTTP " + response.status + ".");
  const data = await response.json() as { id?: unknown };
  return typeof data.id === "string" ? data.id : null;
}

async function sendSms(to: string, body: string) {
  const sid = process.env.TWILIO_ACCOUNT_SID?.trim() ?? "";
  const token = process.env.TWILIO_AUTH_TOKEN?.trim() ?? "";
  const from = process.env.TWILIO_PHONE_NUMBER?.trim() ?? "";
  if (!sid || !token || !from) throw new Error("SMS provider credentials or sender are not configured.");
  const form = new URLSearchParams({ To: to, From: from, Body: body.slice(0, 1500) });
  const auth = Buffer.from(sid + ":" + token).toString("base64");
  const response = await fetch("https://api.twilio.com/2010-04-01/Accounts/" + encodeURIComponent(sid) + "/Messages.json", {
    method: "POST", redirect: "error", cache: "no-store", signal: AbortSignal.timeout(15000),
    headers: { authorization: "Basic " + auth, "content-type": "application/x-www-form-urlencoded" }, body: form.toString()
  });
  if (!response.ok) throw new Error("SMS provider returned HTTP " + response.status + ".");
  const data = await response.json() as { sid?: unknown };
  return typeof data.sid === "string" ? data.sid : null;
}

async function sendWhatsApp(to: string, templateName: string, language: string, payload: Json) {
  const token = process.env.WHATSAPP_ACCESS_TOKEN?.trim() ?? "";
  const phoneId = process.env.WHATSAPP_PHONE_NUMBER_ID?.trim() ?? "";
  const apiVersion = process.env.WHATSAPP_API_VERSION?.trim() || "v22.0";
  if (!token || !phoneId || !/^v\d+\.\d+$/.test(apiVersion) || !/^[a-zA-Z0-9_-]{1,512}$/.test(templateName)) {
    throw new Error("WhatsApp credentials or approved provider template are not configured.");
  }
  const rawVariables = Array.isArray(payload.variables) ? payload.variables : [];
  const components = rawVariables.length ? [{ type: "body", parameters: rawVariables.slice(0, 20).map((value) => ({
    type: "text", text: String(value ?? "").slice(0, 1024)
  })) }] : [];
  const response = await fetch("https://graph.facebook.com/" + apiVersion + "/" + encodeURIComponent(phoneId) + "/messages", {
    method: "POST", redirect: "error", cache: "no-store", signal: AbortSignal.timeout(15000),
    headers: { authorization: "Bearer " + token, "content-type": "application/json" },
    body: JSON.stringify({ messaging_product: "whatsapp", to: to.replace(/^\+/, ""), type: "template",
      template: { name: templateName, language: { code: language }, ...(components.length ? { components } : {}) } })
  });
  if (!response.ok) throw new Error("WhatsApp provider returned HTTP " + response.status + ".");
  const data = await response.json() as { messages?: Array<{ id?: unknown }> };
  return typeof data.messages?.[0]?.id === "string" ? data.messages[0].id : null;
}

async function processOne(admin: ReturnType<typeof adminClient>, row: Notification) {
  try {
    const { customer, destination, consentOk, consentReason } = await contactAndConsent(admin, row);
    if (!consentOk) {
      await admin.from("notifications").update({
        status: "cancelled", failure_reason: consentReason, next_retry_at: null,
        provider_configuration_snapshot: { suppressed: true, consent_checked_at: new Date().toISOString() }
      }).eq("id", row.id).eq("status", "processing");
      return "cancelled";
    }
    if (row.channel === "in_app") {
      const { error } = await admin.from("notifications").update({
        status: "delivered", sent_at: new Date().toISOString(), delivered_at: new Date().toISOString(),
        provider_message_ref: "in_app", failure_reason: null, provider_configuration_snapshot: { provider: "in_app" }
      }).eq("id", row.id).eq("status", "processing");
      if (error) throw new Error("Could not mark in-app notification delivered.");
      return "sent";
    }

    const template = await findTemplate(admin, row);
    if (!template) throw new Error("An active message template for this channel and language is required.");
    let target = "";
    let messageRef: string | null = null;
    if (row.channel === "email") {
      target = emailAddress(destination);
      if (!target) throw new Error("Recipient email address is invalid or missing.");
      const subject = interpolate(template.subject || "A message from your jewellery shop", row.safe_payload ?? {}, customer);
      const body = interpolate(template.body, row.safe_payload ?? {}, customer);
      messageRef = await sendEmail(target, subject, body);
    } else if (row.channel === "sms") {
      target = e164(destination);
      if (!target) throw new Error("SMS recipient must be a valid E.164 phone number.");
      const body = interpolate(template.body, row.safe_payload ?? {}, customer);
      messageRef = await sendSms(target, body);
    } else if (row.channel === "whatsapp") {
      target = e164(destination);
      if (!target) throw new Error("WhatsApp recipient must be a valid E.164 phone number.");
      if (!template.provider_template_ref) throw new Error("WhatsApp requires a provider-approved template name.");
      messageRef = await sendWhatsApp(target, template.provider_template_ref, row.language_code, row.safe_payload ?? {});
    }
    const { error: updateError } = await admin.from("notifications").update({
      status: "sent", sent_at: new Date().toISOString(), provider_message_ref: messageRef,
      failure_reason: null, next_retry_at: null,
      provider_configuration_snapshot: { provider: row.channel, template_key: row.template_key, sent_at: new Date().toISOString() }
    }).eq("id", row.id).eq("status", "processing");
    if (updateError) throw new Error("Message was sent but queue status could not be saved; inspect provider delivery and reconcile.");
    return "sent";
  } catch (error) {
    const safeFailure = error instanceof Error ? error.message.slice(0, 240) : "Notification delivery failed.";
    const delaySeconds = Math.min(21600, 30 * Math.pow(2, Math.max(0, row.attempt_count - 1)));
    const retryAt = row.attempt_count < row.max_attempts ? new Date(Date.now() + delaySeconds * 1000).toISOString() : null;
    const { error: updateError } = await admin.from("notifications").update({
      status: "failed", failure_reason: safeFailure, next_retry_at: retryAt,
      provider_configuration_snapshot: { provider: row.channel, last_failure_at: new Date().toISOString() }
    }).eq("id", row.id).eq("status", "processing");
    if (updateError) console.error("Could not record notification failure", { notificationId: row.id, code: updateError.code });
    return "failed";
  }
}

async function run(request: NextRequest) {
  const expected = process.env.CRON_SECRET?.trim() || process.env.NOTIFICATION_DELIVERY_SECRET?.trim();
  const provided = (request.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!expected || !sameSecret(provided, expected)) return NextResponse.json({ error: "Unauthorized notification worker request." }, { status: 401 });
  let admin: ReturnType<typeof adminClient>;
  try { admin = adminClient(); } catch { return NextResponse.json({ error: "Server database configuration is missing." }, { status: 503 }); }
  const { data, error } = await admin.rpc("claim_notification_batch", { p_limit: 50 });
  if (error) return NextResponse.json({ error: "Could not claim notifications for delivery." }, { status: 500 });
  const rows = (data ?? []) as Notification[];
  const counts = { claimed: rows.length, sent: 0, failed: 0, cancelled: 0 };
  for (const row of rows) {
    const status = await processOne(admin, row);
    if (status === "sent") counts.sent++;
    if (status === "failed") counts.failed++;
    if (status === "cancelled") counts.cancelled++;
  }
  return NextResponse.json({ ok: true, checkedAt: new Date().toISOString(), ...counts });
}

export async function GET(request: NextRequest) { return run(request); }
export async function POST(request: NextRequest) { return run(request); }
