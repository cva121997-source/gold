import { createClient as createSupabaseClient } from "@supabase/supabase-js";
import { createClient as createSessionClient } from "@/lib/supabase/server";
import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function adminClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("SERVER_CONFIG_MISSING");
  return createSupabaseClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });
}

export async function POST(request: NextRequest) {
  let session;
  try { session = await createSessionClient(); }
  catch { return NextResponse.json({ error: "Authentication is not configured." }, { status: 503 }); }
  const { data: { user }, error: userError } = await session.auth.getUser();
  if (userError || !user) return NextResponse.json({ error: "Sign in as the shop owner to manage billing." }, { status: 401 });

  let body: { tenantId?: unknown };
  try { body = await request.json(); } catch { return NextResponse.json({ error: "Request body must be valid JSON." }, { status: 400 }); }
  const tenantId = typeof body.tenantId === "string" ? body.tenantId.trim() : "";
  if (!tenantId) return NextResponse.json({ error: "Choose a shop before cancelling billing." }, { status: 400 });
  const { data: membership, error: membershipError } = await session.from("tenant_memberships")
    .select("tenant_id,role,is_active").eq("tenant_id", tenantId).eq("user_id", user.id).eq("is_active", true).maybeSingle();
  if (membershipError) return NextResponse.json({ error: "Could not verify the selected shop membership." }, { status: 500 });
  if (!membership || membership.role !== "owner") return NextResponse.json({ error: "Only the active shop owner can cancel a subscription." }, { status: 403 });

  let admin: ReturnType<typeof adminClient>;
  try { admin = adminClient(); } catch { return NextResponse.json({ error: "Server database configuration is missing." }, { status: 503 }); }
  const { data: subscription, error: readError } = await admin.from("tenant_subscriptions")
    .select("id,status,provider,provider_subscription_ref,cancel_at_period_end,plan_id")
    .eq("tenant_id", tenantId).maybeSingle();
  if (readError) return NextResponse.json({ error: "Could not read the current subscription." }, { status: 500 });
  if (!subscription) return NextResponse.json({ error: "This shop has no subscription to cancel." }, { status: 404 });
  if (subscription.status === "cancelled") return NextResponse.json({ ok: true, message: "The subscription is already cancelled." });
  if (subscription.cancel_at_period_end) return NextResponse.json({ ok: true, message: "Cancellation is already scheduled for the end of the current period." });

  if (subscription.provider === "razorpay" && subscription.provider_subscription_ref) {
    const keyId = process.env.RAZORPAY_KEY_ID?.trim() ?? "";
    const keySecret = process.env.RAZORPAY_KEY_SECRET?.trim() ?? "";
    if (!keyId || !keySecret) return NextResponse.json({ error: "Razorpay cancellation credentials are not configured." }, { status: 503 });
    const response = await fetch("https://api.razorpay.com/v1/subscriptions/" + encodeURIComponent(subscription.provider_subscription_ref) + "/cancel", {
      method: "POST", cache: "no-store", redirect: "error", signal: AbortSignal.timeout(15000),
      headers: {
        authorization: "Basic " + Buffer.from(keyId + ":" + keySecret).toString("base64"),
        accept: "application/json", "content-type": "application/json"
      },
      body: JSON.stringify({ cancel_at_cycle_end: true })
    });
    if (!response.ok) return NextResponse.json({ error: "Razorpay could not schedule cancellation. The local subscription remains unchanged." }, { status: 502 });
    const { error: updateError } = await admin.from("tenant_subscriptions")
      .update({ cancel_at_period_end: true, updated_at: new Date().toISOString() })
      .eq("tenant_id", tenantId).eq("provider_subscription_ref", subscription.provider_subscription_ref);
    if (updateError) return NextResponse.json({ error: "Cancellation was scheduled with Razorpay but the local flag did not save; reconcile the subscription before retrying." }, { status: 207 });
    await admin.from("audit_logs").insert({
      tenant_id: tenantId, actor_user_id: user.id, event_name: "subscription.cancel_scheduled",
      entity_type: "tenant_subscription", entity_id: subscription.id,
      details: { provider: "razorpay", provider_subscription_ref: subscription.provider_subscription_ref, cancel_at_period_end: true }
    });
    return NextResponse.json({ ok: true, message: "Subscription cancellation is scheduled for the end of the current billing period. Access stays active until the provider confirms cancellation." });
  }

  const { error: updateError } = await admin.from("tenant_subscriptions").update({
    status: "cancelled", cancel_at_period_end: false, updated_at: new Date().toISOString()
  }).eq("tenant_id", tenantId);
  if (updateError) return NextResponse.json({ error: "The subscription could not be cancelled." }, { status: 500 });
  const { error: entitlementError } = await admin.from("feature_entitlements")
    .update({ enabled: false, updated_by: null, updated_at: new Date().toISOString() }).eq("tenant_id", tenantId);
  await admin.from("audit_logs").insert({
    tenant_id: tenantId, actor_user_id: user.id, event_name: "subscription.cancelled",
    entity_type: "tenant_subscription", entity_id: subscription.id, details: { provider: "none", plan_id: subscription.plan_id }
  });
  if (entitlementError) return NextResponse.json({ ok: true, warning: "The free subscription was cancelled, but feature entitlements need a manual review." }, { status: 207 });
  return NextResponse.json({ ok: true, message: "Free plan/trial cancelled." });
}
