import { createClient as createSupabaseClient } from "@supabase/supabase-js";
import { createClient as createSessionClient } from "@/lib/supabase/server";
import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

type Plan = {
  id: string; code: string; name: string; description: string | null;
  monthly_price_inr: number; annual_price_inr: number; trial_days: number;
  entitlements: Record<string, unknown>;
  provider_monthly_plan_ref: string | null; provider_annual_plan_ref: string | null;
};
type ExistingSubscription = {
  id: string; status: string; plan_id: string | null; trial_ends_at: string | null;
  provider: string | null; provider_subscription_ref: string | null;
};

function adminClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("SERVER_CONFIG_MISSING");
  return createSupabaseClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });
}
function addInterval(base: Date, interval: "monthly" | "annual") {
  const result = new Date(base);
  if (interval === "annual") result.setUTCFullYear(result.getUTCFullYear() + 1);
  else result.setUTCMonth(result.getUTCMonth() + 1);
  return result;
}
async function saveEntitlements(admin: ReturnType<typeof adminClient>, tenantId: string, plan: Plan) {
  const rows = Object.entries(plan.entitlements ?? {}).map(([feature_key, value]) => {
    let enabled = false;
    let limit_value: number | null = null;
    if (typeof value === "boolean") enabled = value;
    else if (typeof value === "number" && Number.isFinite(value)) {
      enabled = value > 0;
      limit_value = Number.isInteger(value) && value >= 0 ? value : null;
    } else if (value === null) enabled = true;
    return {
      tenant_id: tenantId, feature_key, enabled, limit_value,
      configuration: { source: "subscription_plan", plan_id: plan.id, plan_value: value },
      updated_by: null, updated_at: new Date().toISOString()
    };
  });
  if (!rows.length) return;
  const { error } = await admin.from("feature_entitlements").upsert(rows, { onConflict: "tenant_id,feature_key" });
  if (error) throw new Error("Could not apply plan feature entitlements.");
}
async function razorpayFetch<T>(path: string, method: "GET" | "POST", keyId: string, keySecret: string, body?: unknown): Promise<T> {
  const response = await fetch("https://api.razorpay.com/v1" + path, {
    method, cache: "no-store", redirect: "error", signal: AbortSignal.timeout(15000),
    headers: {
      authorization: "Basic " + Buffer.from(keyId + ":" + keySecret).toString("base64"),
      accept: "application/json", "content-type": "application/json"
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  });
  const payload = await response.json().catch(() => ({})) as T & { error?: { description?: string; code?: string } };
  if (!response.ok) {
    const e = new Error("RAZORPAY_API_ERROR");
    (e as Error & { status?: number; providerCode?: string }).status = response.status;
    (e as Error & { status?: number; providerCode?: string }).providerCode = payload.error?.code;
    throw e;
  }
  return payload;
}

export async function POST(request: NextRequest) {
  let session;
  try { session = await createSessionClient(); }
  catch { return NextResponse.json({ error: "Authentication is not configured." }, { status: 503 }); }
  const { data: { user }, error: userError } = await session.auth.getUser();
  if (userError || !user) return NextResponse.json({ error: "Sign in as the shop owner to manage billing." }, { status: 401 });

  let body: { tenantId?: unknown; planId?: unknown; interval?: unknown };
  try { body = await request.json(); } catch { return NextResponse.json({ error: "Request body must be valid JSON." }, { status: 400 }); }
  const tenantId = typeof body.tenantId === "string" ? body.tenantId.trim() : "";
  const planId = typeof body.planId === "string" ? body.planId.trim() : "";
  const interval = body.interval === "annual" ? "annual" : body.interval === "monthly" ? "monthly" : null;
  if (!tenantId || !planId || !interval) return NextResponse.json({ error: "Choose a shop, plan and monthly/annual billing interval." }, { status: 400 });

  const { data: membership, error: membershipError } = await session.from("tenant_memberships")
    .select("tenant_id,role,is_active").eq("tenant_id", tenantId).eq("user_id", user.id).eq("is_active", true).maybeSingle();
  if (membershipError) return NextResponse.json({ error: "Could not verify the selected shop membership." }, { status: 500 });
  if (!membership || membership.role !== "owner") return NextResponse.json({ error: "Only the active shop owner can start or change a subscription." }, { status: 403 });

  let admin: ReturnType<typeof adminClient>;
  try { admin = adminClient(); } catch { return NextResponse.json({ error: "Server database configuration is missing." }, { status: 503 }); }
  const [tenantResult, planResult, currentResult] = await Promise.all([
    admin.from("tenants").select("id,status,display_name").eq("id", tenantId).maybeSingle(),
    admin.from("subscription_plans").select("id,code,name,description,monthly_price_inr,annual_price_inr,trial_days,entitlements,provider_monthly_plan_ref,provider_annual_plan_ref")
      .eq("id", planId).eq("is_active", true).maybeSingle(),
    admin.from("tenant_subscriptions").select("id,status,plan_id,trial_ends_at,provider,provider_subscription_ref").eq("tenant_id", tenantId).maybeSingle()
  ]);
  if (tenantResult.error || planResult.error || currentResult.error) return NextResponse.json({ error: "Could not read the current shop or billing plan." }, { status: 500 });
  if (!tenantResult.data || !["active", "trial"].includes(tenantResult.data.status)) return NextResponse.json({ error: "This shop is not currently eligible for a plan change." }, { status: 409 });
  if (!planResult.data) return NextResponse.json({ error: "The selected plan is not active or could not be found." }, { status: 404 });

  const plan = planResult.data as Plan;
  const current = currentResult.data as ExistingSubscription | null;
  if (current && ["active", "pending", "past_due", "suspended"].includes(current.status)) {
    return NextResponse.json({ error: "This shop already has an active, pending or unresolved subscription. Cancel/resolve it before creating another checkout." }, { status: 409 });
  }
  const price = Number(interval === "annual" ? plan.annual_price_inr : plan.monthly_price_inr);
  if (!Number.isFinite(price) || price < 0) return NextResponse.json({ error: "The selected plan has an invalid price configuration." }, { status: 500 });

  if (price === 0) {
    if (current?.trial_ends_at && plan.trial_days > 0) {
      return NextResponse.json({ error: "A trial has already been granted to this shop. Choose a zero-cost plan without a trial or configure paid billing." }, { status: 409 });
    }
    if (current?.status === "trial" && current.trial_ends_at && new Date(current.trial_ends_at).getTime() > Date.now()) {
      return NextResponse.json({ error: "A trial is already active for this shop." }, { status: 409 });
    }
    const now = new Date();
    const trialEnd = plan.trial_days > 0 && !current?.trial_ends_at
      ? new Date(now.getTime() + plan.trial_days * 86400000)
      : null;
    const status = trialEnd ? "trial" : "active";
    const periodEnd = trialEnd ?? addInterval(now, interval);
    const { data: saved, error: saveError } = await admin.from("tenant_subscriptions").upsert({
      tenant_id: tenantId, plan_id: plan.id, status,
      trial_ends_at: trialEnd?.toISOString() ?? null,
      current_period_start: now.toISOString(), current_period_end: periodEnd.toISOString(),
      billing_interval: interval, cancel_at_period_end: false,
      provider: null, provider_customer_ref: null, provider_subscription_ref: null,
      latest_provider_event_at: null, updated_at: now.toISOString()
    }, { onConflict: "tenant_id" }).select("id,status,trial_ends_at,current_period_start,current_period_end").single();
    if (saveError || !saved) return NextResponse.json({ error: "The free plan/trial could not be activated." }, { status: 500 });
    try { await saveEntitlements(admin, tenantId, plan); }
    catch { return NextResponse.json({ subscription: saved, warning: "The plan was saved, but its feature entitlements could not be fully refreshed. Contact support before relying on feature limits." }, { status: 207 }); }
    await admin.from("audit_logs").insert({
      tenant_id: tenantId, actor_user_id: user.id, event_name: trialEnd ? "subscription.trial_started" : "subscription.free_plan_activated",
      entity_type: "tenant_subscription", entity_id: saved.id,
      details: { plan_id: plan.id, plan_code: plan.code, interval, trial_ends_at: trialEnd?.toISOString() ?? null }
    });
    return NextResponse.json({ ok: true, checkoutRequired: false, subscription: saved, message: trialEnd ? "Free trial activated." : "Free plan activated." });
  }

  if (price * 100 <= 100) return NextResponse.json({ error: "Paid plans must be priced above ₹1.00 per billing period for Razorpay subscriptions." }, { status: 400 });
  const keyId = process.env.RAZORPAY_KEY_ID?.trim() ?? "";
  const keySecret = process.env.RAZORPAY_KEY_SECRET?.trim() ?? "";
  if (!keyId || !keySecret) return NextResponse.json({ error: "Razorpay billing is not configured on the server. Free plans can still be activated." }, { status: 503 });

  const refColumn = interval === "annual" ? "provider_annual_plan_ref" : "provider_monthly_plan_ref";
  let providerPlanRef = interval === "annual" ? plan.provider_annual_plan_ref : plan.provider_monthly_plan_ref;
  try {
    if (!providerPlanRef) {
      const planPayload = await razorpayFetch<{ id?: string }>("/plans", "POST", keyId, keySecret, {
        period: interval === "annual" ? "yearly" : "monthly", interval: 1,
        item: {
          name: (plan.name + (interval === "annual" ? " Annual" : " Monthly")).slice(0, 120),
          description: (plan.description || plan.name).slice(0, 250),
          amount: Math.round(price * 100), currency: "INR"
        },
        notes: { application: "Gold Jewellery SaaS", plan_code: plan.code, billing_interval: interval }
      });
      if (!planPayload.id) throw new Error("PLAN_REFERENCE_MISSING");
      const { data: savedPlan } = await admin.from("subscription_plans").update({ [refColumn]: planPayload.id, updated_at: new Date().toISOString() })
        .eq("id", plan.id).is(refColumn, null).select(refColumn).maybeSingle();
      if (savedPlan) providerPlanRef = (savedPlan as Record<string, string>)[refColumn];
      if (!providerPlanRef) {
        const { data: refreshed, error: readError } = await admin.from("subscription_plans").select(refColumn).eq("id", plan.id).maybeSingle();
        if (readError) throw new Error("PLAN_REFERENCE_SAVE_FAILED");
        providerPlanRef = ((refreshed ?? {}) as Record<string, string | null>)[refColumn] ?? planPayload.id;
      }
    }

    const totalCount = interval === "annual" ? 10 : 120;
    const providerSubscription = await razorpayFetch<{
      id?: string; short_url?: string; status?: string; customer_id?: string;
      created_at?: number; current_start?: number; current_end?: number;
    }>("/subscriptions", "POST", keyId, keySecret, {
      plan_id: providerPlanRef, total_count: totalCount, customer_notify: 1,
      notes: { tenant_id: tenantId, plan_id: plan.id, plan_code: plan.code, billing_interval: interval, owner_user_id: user.id }
    });
    if (!providerSubscription.id || !providerSubscription.short_url) throw new Error("SUBSCRIPTION_CHECKOUT_REFERENCE_MISSING");
    const { data: saved, error: saveError } = await admin.from("tenant_subscriptions").upsert({
      tenant_id: tenantId, plan_id: plan.id, status: "pending", trial_ends_at: null,
      current_period_start: null, current_period_end: null,
      billing_interval: interval, cancel_at_period_end: false, provider: "razorpay",
      provider_customer_ref: providerSubscription.customer_id ?? null,
      provider_subscription_ref: providerSubscription.id, latest_provider_event_at: null, updated_at: new Date().toISOString()
    }, { onConflict: "tenant_id" }).select("id,status,provider_subscription_ref").single();
    if (saveError || !saved) {
      await admin.from("audit_logs").insert({
        tenant_id: tenantId, actor_user_id: user.id, event_name: "subscription.provider_checkout_orphaned",
        entity_type: "tenant", entity_id: tenantId,
        details: { provider_subscription_ref: providerSubscription.id, plan_id: plan.id, reason: "local_subscription_persist_failed" }
      });
      return NextResponse.json({ error: "Provider checkout was created but the local subscription record could not be saved. Do not create another checkout; contact support with subscription ID " + providerSubscription.id + "." }, { status: 500 });
    }
    await admin.from("audit_logs").insert({
      tenant_id: tenantId, actor_user_id: user.id, event_name: "subscription.checkout_created",
      entity_type: "tenant_subscription", entity_id: saved.id,
      details: { plan_id: plan.id, plan_code: plan.code, billing_interval: interval, provider_subscription_ref: providerSubscription.id }
    });
    return NextResponse.json({ ok: true, checkoutRequired: true, checkoutUrl: providerSubscription.short_url, subscription: saved });
  } catch (e) {
    const status = (e as Error & { status?: number }).status;
    if (status === 401) return NextResponse.json({ error: "Razorpay rejected the server credentials. Check test/live keys." }, { status: 503 });
    if (status === 400) return NextResponse.json({ error: "Razorpay rejected the configured plan or price. Review the plan price/currency and provider account settings." }, { status: 502 });
    return NextResponse.json({ error: "Could not create Razorpay subscription checkout. No subscription was marked active." }, { status: 502 });
  }
}
