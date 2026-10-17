import { NextRequest, NextResponse } from "next/server";
import { getPlatformAdminContext } from "@/lib/supabase/platform-admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const context = await getPlatformAdminContext();
  if ("response" in context) return context.response;
  const { data, error } = await context.admin.from("subscription_plans")
    .select("id,code,name,description,monthly_price_inr,annual_price_inr,trial_days,entitlements,is_active,provider_monthly_plan_ref,provider_annual_plan_ref,created_at,updated_at")
    .order("monthly_price_inr", { ascending: true }).order("name");
  if (error) return NextResponse.json({ error: "Could not load subscription plans." }, { status: 500 });
  return NextResponse.json({ adminRole: context.adminRole, plans: data ?? [] });
}

export async function PATCH(request: NextRequest) {
  const context = await getPlatformAdminContext();
  if ("response" in context) return context.response;
  if (!["platform_owner", "platform_admin"].includes(context.adminRole)) {
    return NextResponse.json({ error: "Your platform role is read-only." }, { status: 403 });
  }
  let body: {
    planId?: unknown; description?: unknown; monthlyPriceInr?: unknown; annualPriceInr?: unknown;
    trialDays?: unknown; isActive?: unknown; entitlements?: unknown;
  };
  try { body = await request.json(); } catch { return NextResponse.json({ error: "Request body must be valid JSON." }, { status: 400 }); }

  const planId = typeof body.planId === "string" ? body.planId.trim() : "";
  const monthly = typeof body.monthlyPriceInr === "number" ? body.monthlyPriceInr : NaN;
  const annual = typeof body.annualPriceInr === "number" ? body.annualPriceInr : NaN;
  const trialDays = typeof body.trialDays === "number" ? body.trialDays : NaN;
  const description = typeof body.description === "string" ? body.description.trim() : null;
  if (!planId || !Number.isFinite(monthly) || monthly < 0 || monthly > 100_000_000 ||
      !Number.isFinite(annual) || annual < 0 || annual > 1_000_000_000 ||
      !Number.isInteger(trialDays) || trialDays < 0 || trialDays > 90 ||
      typeof body.isActive !== "boolean" || description !== null && description.length > 1000) {
    return NextResponse.json({ error: "Provide valid non-negative INR prices, trial days (0–90), status and a short description." }, { status: 400 });
  }
  if (!body.entitlements || typeof body.entitlements !== "object" || Array.isArray(body.entitlements)) {
    return NextResponse.json({ error: "Entitlements must be a JSON object." }, { status: 400 });
  }
  const entitlements = body.entitlements as Record<string, unknown>;
  const entries = Object.entries(entitlements);
  if (entries.length > 100 || entries.some(([key, value]) =>
    !/^[a-z][a-z0-9_]{0,79}$/.test(key) ||
    !(value === null || typeof value === "boolean" || typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1_000_000 && (value === 0 || value >= 1)))) {
    return NextResponse.json({ error: "Entitlements may contain up to 100 snake_case keys with boolean, non-negative integer limit, or null (unlimited) values." }, { status: 400 });
  }
  if (entries.some(([, value]) => typeof value === "number" && !Number.isInteger(value))) {
    return NextResponse.json({ error: "Numeric entitlement limits must be whole numbers." }, { status: 400 });
  }

  const { data: before, error: readError } = await context.admin.from("subscription_plans")
    .select("id,code,name,monthly_price_inr,annual_price_inr,trial_days,is_active,entitlements,provider_monthly_plan_ref,provider_annual_plan_ref")
    .eq("id", planId).maybeSingle();
  if (readError) return NextResponse.json({ error: "Could not read the selected plan." }, { status: 500 });
  if (!before) return NextResponse.json({ error: "Plan not found." }, { status: 404 });

  const monthlyChanged = Number(before.monthly_price_inr) !== monthly;
  const annualChanged = Number(before.annual_price_inr) !== annual;
  const patch: Record<string, unknown> = {
    description, monthly_price_inr: monthly, annual_price_inr: annual, trial_days: trialDays,
    is_active: body.isActive, entitlements, updated_at: new Date().toISOString()
  };
  // Razorpay plan resources are immutable; changed prices create a new provider plan at the next checkout.
  if (monthlyChanged && before.provider_monthly_plan_ref) patch.provider_monthly_plan_ref = null;
  if (annualChanged && before.provider_annual_plan_ref) patch.provider_annual_plan_ref = null;

  const { data: updated, error: updateError } = await context.admin.from("subscription_plans")
    .update(patch).eq("id", planId)
    .select("id,code,name,description,monthly_price_inr,annual_price_inr,trial_days,entitlements,is_active,provider_monthly_plan_ref,provider_annual_plan_ref,updated_at")
    .single();
  if (updateError || !updated) return NextResponse.json({ error: "Plan settings could not be saved." }, { status: 500 });

  const { error: auditError } = await context.admin.from("platform_audit_logs").insert({
    actor_user_id: context.user.id, event_name: "platform.subscription_plan_updated", entity_type: "subscription_plan", entity_id: planId,
    details: {
      code: before.code, old_monthly_price_inr: before.monthly_price_inr, new_monthly_price_inr: monthly,
      old_annual_price_inr: before.annual_price_inr, new_annual_price_inr: annual,
      monthly_provider_plan_reset: monthlyChanged && Boolean(before.provider_monthly_plan_ref),
      annual_provider_plan_reset: annualChanged && Boolean(before.provider_annual_plan_ref),
      actor_role: context.adminRole
    }
  });
  if (auditError) return NextResponse.json({ plan: updated, warning: "Plan was saved but platform audit logging failed; inspect server logs." }, { status: 207 });
  return NextResponse.json({ plan: updated });
}
