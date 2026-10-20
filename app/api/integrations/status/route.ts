import { NextRequest, NextResponse } from "next/server";
import { createClient as createSessionClient } from "@/lib/supabase/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RunRow = { status: string; started_at: string; completed_at: string | null };
type NotificationRow = { channel: string; status: string; created_at: string; sent_at: string | null; delivered_at: string | null };
type PaymentRow = { status: string; created_at: string; confirmed_at: string | null; provider: string | null };
type SubscriptionRow = { status: string; updated_at: string; latest_provider_event_at: string | null };
type Activity = { lastSuccessfulAt: string | null; lastFailureAt: string | null; recentFailures: number; pendingCount: number; sampleSize: number };
const emptyActivity = (): Activity => ({ lastSuccessfulAt: null, lastFailureAt: null, recentFailures: 0, pendingCount: 0, sampleSize: 0 });
function summarize<T>(
  rows: T[],
  stateOf: (row: T) => string,
  timeOf: (row: T, state: string) => string | null,
  successStates: string[],
  failureStates: string[],
  pendingStates: string[]
): Activity {
  const out = emptyActivity();
  out.sampleSize = rows.length;
  for (const row of rows) {
    const state = stateOf(row);
    const time = timeOf(row, state);
    if (successStates.includes(state) && time && (!out.lastSuccessfulAt || time > out.lastSuccessfulAt)) out.lastSuccessfulAt = time;
    if (failureStates.includes(state)) {
      out.recentFailures++;
      if (time && (!out.lastFailureAt || time > out.lastFailureAt)) out.lastFailureAt = time;
    }
    if (pendingStates.includes(state)) out.pendingCount++;
  }
  return out;
}

export async function GET(request: NextRequest) {
  let session;
  try { session = await createSessionClient(); }
  catch { return NextResponse.json({ error: "Authentication service is not configured." }, { status: 503 }); }
  const { data: { user }, error } = await session.auth.getUser();
  if (error || !user) return NextResponse.json({ error: "Sign in to inspect integration status." }, { status: 401 });

  const tenantId = request.nextUrl.searchParams.get("tenantId")?.trim() ?? "";
  if (!tenantId) return NextResponse.json({ error: "Choose a shop to inspect its integration readiness." }, { status: 400 });
  const { data: membership, error: membershipError } = await session.from("tenant_memberships")
    .select("tenant_id,role,is_active").eq("tenant_id", tenantId).eq("user_id", user.id).eq("is_active", true).maybeSingle();
  if (membershipError) return NextResponse.json({ error: "Could not verify shop membership." }, { status: 500 });
  if (!membership) return NextResponse.json({ error: "You do not have access to this shop." }, { status: 403 });
  if (!["owner", "manager"].includes(membership.role)) return NextResponse.json({ error: "Integration activity is limited to shop owners and managers." }, { status: 403 });

  // Activity queries are scoped by the already verified tenant and return no payloads,
  // provider event IDs, customer identifiers or raw failure messages.
  const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  const [rateResult, notificationResult, paymentResult, subscriptionResult] = await Promise.all([
    session.from("rate_provider_runs").select("status,started_at,completed_at").eq("tenant_id", tenantId)
      .gte("created_at", since).order("created_at", { ascending: false }).limit(100),
    session.from("notifications").select("channel,status,created_at,sent_at,delivered_at").eq("tenant_id", tenantId)
      .gte("created_at", since).order("created_at", { ascending: false }).limit(500),
    session.from("payments").select("status,created_at,confirmed_at,provider").eq("tenant_id", tenantId)
      .eq("provider", "razorpay").gte("created_at", since).order("created_at", { ascending: false }).limit(200),
    session.from("tenant_subscriptions").select("status,updated_at,latest_provider_event_at").eq("tenant_id", tenantId)
      .order("updated_at", { ascending: false }).limit(20)
  ]);
  const rates = (rateResult.error ? [] : rateResult.data ?? []) as RunRow[];
  const notifications = (notificationResult.error ? [] : notificationResult.data ?? []) as NotificationRow[];
  const payments = (paymentResult.error ? [] : paymentResult.data ?? []) as PaymentRow[];
  const subscriptions = (subscriptionResult.error ? [] : subscriptionResult.data ?? []) as SubscriptionRow[];

  const rateActivity = summarize(rates, r => r.status, (r, state) =>
    state === "failed" ? r.completed_at ?? r.started_at : r.completed_at ?? r.started_at,
    ["succeeded", "partial"], ["failed"], []);
  const paymentActivity = summarize(payments, p => p.status, (p, state) =>
    state === "confirmed" ? p.confirmed_at ?? p.created_at : p.created_at,
    ["confirmed"], ["failed", "error"], ["pending", "created", "processing"]);
  const subscriptionActivity = summarize(subscriptions, p => p.status, p => p.latest_provider_event_at ?? p.updated_at,
    ["active", "trial"], ["past_due", "failed", "incomplete_expired"], ["pending", "incomplete"]);
  const notificationActivity = (channel: string) => summarize(
    notifications.filter(n => n.channel === channel),
    n => n.status,
    (n, state) => state === "delivered" ? n.delivered_at ?? n.created_at :
      state === "sent" ? n.sent_at ?? n.created_at : n.created_at,
    ["delivered"], ["failed"], ["queued", "processing"]
  );

  const has = (...keys: string[]) => keys.every((key) => Boolean(process.env[key]?.trim()));
  const integrations = [
    { key: "supabase", name: "Supabase", category: "Database & authentication", configured: has("NEXT_PUBLIC_SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_ANON_KEY", "SUPABASE_SERVICE_ROLE_KEY"), workflow: "Authentication, database and server-side admin access", activity: emptyActivity(), activityAvailable: false },
    { key: "razorpay", name: "Razorpay payments", category: "Online payments", configured: has("RAZORPAY_KEY_ID", "RAZORPAY_KEY_SECRET", "RAZORPAY_WEBHOOK_SECRET"), workflow: "Invoice/scheme checkout and signature-verified capture webhook are implemented; test credentials, gateway refunds and settlement reconciliation still need end-to-end verification", activity: paymentActivity, activityAvailable: !paymentResult.error },
    { key: "razorpay-subscriptions", name: "Razorpay subscription billing", category: "SaaS billing", configured: has("RAZORPAY_KEY_ID", "RAZORPAY_KEY_SECRET") && (has("RAZORPAY_SUBSCRIPTION_WEBHOOK_SECRET") || has("RAZORPAY_WEBHOOK_SECRET")), workflow: "Plan configuration, hosted subscription checkout, scheduled cancellation and signed webhook status updates are connected. Set actual plan prices in Platform Admin and test with Razorpay test credentials before enabling live billing.", activity: subscriptionActivity, activityAvailable: !subscriptionResult.error },
    { key: "gold-rate", name: "Approved gold-rate provider", category: "Rate engine", configured: has("GOLD_RATE_PROVIDER_URL", "GOLD_RATE_PROVIDER_HOST", "GOLD_RATE_PROVIDER_API_KEY") && (has("GOLD_RATE_REFRESH_SECRET") || has("CRON_SECRET")), workflow: "Configured JSON feed importer and daily refresh endpoint are wired. Imported rates remain indicative/private until a shop reviews them; provider contract and test feed must be verified.", activity: rateActivity, activityAvailable: !rateResult.error },
    { key: "email", name: "Email provider", category: "Notifications", configured: has("RESEND_API_KEY", "RESEND_FROM_EMAIL"), workflow: "Consent-aware queued email delivery worker is connected; active shop/default templates and sender-domain verification are still required", activity: notificationActivity("email"), activityAvailable: !notificationResult.error },
    { key: "sms", name: "SMS provider", category: "Notifications", configured: has("TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN", "TWILIO_PHONE_NUMBER"), workflow: "Consent-aware queued SMS delivery worker is connected; Twilio number, messaging compliance, active templates and callbacks must be configured and tested", activity: notificationActivity("sms"), activityAvailable: !notificationResult.error },
    { key: "whatsapp", name: "WhatsApp Business", category: "Notifications", configured: has("WHATSAPP_ACCESS_TOKEN", "WHATSAPP_PHONE_NUMBER_ID"), workflow: "Queued template delivery is implemented; approved template references, consent and end-to-end test sending are required", activity: notificationActivity("whatsapp"), activityAvailable: !notificationResult.error },
    { key: "email-callbacks", name: "Email delivery callbacks", category: "Notifications", configured: has("RESEND_WEBHOOK_SECRET"), workflow: "Signed Resend delivery, bounce, complaint and failure callbacks are processed idempotently. Register /api/notifications/webhooks/resend with the Resend signing secret and test callbacks.", activity: notificationActivity("email"), activityAvailable: !notificationResult.error },
    { key: "sms-callbacks", name: "SMS delivery callbacks", category: "Notifications", configured: has("TWILIO_AUTH_TOKEN") && (has("TWILIO_STATUS_CALLBACK_URL") || has("NOTIFICATION_PUBLIC_BASE_URL")), workflow: "Signed Twilio status callbacks update accepted, delivered and terminal-failure states. Configure the exact HTTPS callback URL and test against Twilio.", activity: notificationActivity("sms"), activityAvailable: !notificationResult.error },
    { key: "whatsapp-callbacks", name: "WhatsApp delivery callbacks", category: "Notifications", configured: has("WHATSAPP_APP_SECRET", "WHATSAPP_WEBHOOK_VERIFY_TOKEN"), workflow: "Meta challenge verification and signed status callbacks are implemented. Subscribe the app to WhatsApp message-status webhooks and test against a verified WABA.", activity: notificationActivity("whatsapp"), activityAvailable: !notificationResult.error }
  ];
  return NextResponse.json({ tenantId, checkedAt: new Date().toISOString(), activityWindowDays: 30, integrations });
}
