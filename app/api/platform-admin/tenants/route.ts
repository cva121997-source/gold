import { NextRequest, NextResponse } from "next/server";
import { getPlatformAdminContext } from "@/lib/supabase/platform-admin";

export const runtime = "nodejs";

export async function GET() {
  const context = await getPlatformAdminContext();
  if ("response" in context) return context.response;
  const { data, error } = await context.admin.from("tenants")
    .select("id,code,slug,legal_name,display_name,status,state,district,city,locality,created_at,tenant_subscriptions(status,trial_ends_at,current_period_start,current_period_end,cancel_at_period_end,subscription_plans(code,name,monthly_price_inr,annual_price_inr))")
    .order("created_at", { ascending: false }).limit(500);
  if (error) return NextResponse.json({ error: "Could not load tenant records." }, { status: 500 });
  const rows = data ?? [];
  return NextResponse.json({
    adminRole: context.adminRole, tenants: rows,
    stats: {
      total: rows.length,
      active: rows.filter((t) => t.status === "active").length,
      trial: rows.filter((t) => t.status === "trial").length,
      suspended: rows.filter((t) => t.status === "suspended").length,
      cancelled: rows.filter((t) => t.status === "cancelled").length
    }
  });
}

export async function PATCH(request: NextRequest) {
  const context = await getPlatformAdminContext();
  if ("response" in context) return context.response;
  if (!["platform_owner", "platform_admin"].includes(context.adminRole)) return NextResponse.json({ error: "Your platform role is read-only." }, { status: 403 });
  let body: { tenantId?: unknown; status?: unknown };
  try { body = await request.json(); } catch { return NextResponse.json({ error: "Request body must be valid JSON." }, { status: 400 }); }
  const tenantId = typeof body.tenantId === "string" ? body.tenantId : "";
  const status = typeof body.status === "string" ? body.status : "";
  if (!tenantId || !["trial", "active", "suspended", "cancelled"].includes(status)) return NextResponse.json({ error: "A valid tenant ID and status are required." }, { status: 400 });
  const { data: before, error: readError } = await context.admin.from("tenants").select("id,status,display_name").eq("id", tenantId).maybeSingle();
  if (readError) return NextResponse.json({ error: "Could not read the current tenant status." }, { status: 500 });
  if (!before) return NextResponse.json({ error: "Tenant not found." }, { status: 404 });
  const { data, error } = await context.admin.from("tenants").update({ status, updated_at: new Date().toISOString() }).eq("id", tenantId).select("id,status,display_name").single();
  if (error) return NextResponse.json({ error: "Tenant status could not be updated." }, { status: 500 });
  const { error: auditError } = await context.admin.from("audit_logs").insert({
    tenant_id: tenantId, actor_user_id: context.user.id, event_name: "platform.tenant_status_changed",
    entity_type: "tenant", entity_id: tenantId, details: { old_status: before.status, new_status: status, actor_role: context.adminRole }
  });
  if (auditError) return NextResponse.json({ tenant: data, warning: "Status changed, but the platform audit record could not be written. Review database service logs." }, { status: 207 });
  return NextResponse.json({ tenant: data });
}

export async function POST(request: NextRequest) {
  const context = await getPlatformAdminContext();
  if ("response" in context) return context.response;
  if (!["platform_owner", "platform_admin"].includes(context.adminRole)) return NextResponse.json({ error: "Your platform role cannot create shops." }, { status: 403 });
  let body: { shopName?: unknown; legalName?: unknown; ownerName?: unknown; ownerEmail?: unknown; slug?: unknown; state?: unknown; district?: unknown; city?: unknown; locality?: unknown };
  try { body = await request.json(); } catch { return NextResponse.json({ error: "Request body must be valid JSON." }, { status: 400 }); }
  const shopName = typeof body.shopName === "string" ? body.shopName.trim() : "";
  const legalName = typeof body.legalName === "string" ? body.legalName.trim() : "";
  const ownerName = typeof body.ownerName === "string" ? body.ownerName.trim() : "";
  const ownerEmail = typeof body.ownerEmail === "string" ? body.ownerEmail.trim().toLowerCase() : "";
  const slug = typeof body.slug === "string" ? body.slug.trim().toLowerCase() : "";
  const state = typeof body.state === "string" ? body.state.trim() : "Tamil Nadu";
  const district = typeof body.district === "string" ? body.district.trim() : "";
  const city = typeof body.city === "string" ? body.city.trim() : "";
  const locality = typeof body.locality === "string" ? body.locality.trim() : "";
  if (shopName.length < 2 || ownerName.length < 2 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(ownerEmail) || !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(slug) || slug.length > 60) {
    return NextResponse.json({ error: "Provide a shop name, valid owner name/email, and a lowercase unique slug." }, { status: 400 });
  }
  const { data: existing, error: slugError } = await context.admin.from("tenants").select("id").eq("slug", slug).maybeSingle();
  if (slugError) return NextResponse.json({ error: "Could not check the requested shop slug." }, { status: 500 });
  if (existing) return NextResponse.json({ error: "That shop slug is already in use." }, { status: 409 });
  const callbackUrl = new URL("/auth/callback", request.nextUrl.origin).toString();
  const { data: invitation, error: inviteError } = await context.admin.auth.admin.inviteUserByEmail(ownerEmail, { data: { full_name: ownerName }, redirectTo: callbackUrl });
  const ownerUserId = invitation.user?.id;
  if (inviteError || !ownerUserId) {
    return NextResponse.json({ error: "Supabase could not send the owner invitation. Configure the email provider and allowed redirect URL, then retry.", providerMessage: inviteError?.message ?? "Owner user was not returned." }, { status: 502 });
  }
  const { data: tenantId, error: createError } = await context.admin.rpc("platform_admin_create_tenant", {
    p_actor_user_id: context.user.id, p_owner_user_id: ownerUserId, p_display_name: shopName,
    p_legal_name: legalName || null, p_slug: slug, p_state: state || null, p_district: district || null,
    p_city: city || null, p_locality: locality || null
  });
  if (createError || !tenantId) {
    await context.admin.auth.admin.deleteUser(ownerUserId);
    return NextResponse.json({ error: "Owner invite was issued but shop onboarding failed; the unaccepted invite was cleaned up.", detail: createError?.message ?? "Database onboarding did not return a tenant ID." }, { status: 500 });
  }
  return NextResponse.json({ tenantId, ownerInvited: true, message: "Shop created and owner invitation sent. The owner must accept the email invite and finish login/setup." }, { status: 201 });
}
