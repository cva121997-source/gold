import { NextRequest, NextResponse } from "next/server";
import { createClient as createSessionClient } from "@/lib/supabase/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

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

  const has = (...keys: string[]) => keys.every((key) => Boolean(process.env[key]?.trim()));
  const integrations = [
    { key: "supabase", name: "Supabase", category: "Database & authentication", configured: has("NEXT_PUBLIC_SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_ANON_KEY", "SUPABASE_SERVICE_ROLE_KEY"), workflow: "Authentication, database and server-side admin access" },
    { key: "razorpay", name: "Razorpay", category: "Online payments", configured: has("RAZORPAY_KEY_ID", "RAZORPAY_KEY_SECRET", "RAZORPAY_WEBHOOK_SECRET"), workflow: "Checkout order + signature-verified payment capture webhook are implemented; test credentials and refund reconciliation still need end-to-end verification" },
    { key: "gold-rate", name: "Approved gold-rate provider", category: "Rate engine", configured: has("GOLD_RATE_PROVIDER_URL", "GOLD_RATE_PROVIDER_API_KEY"), workflow: "Provider adapter and scheduled refresh worker are not wired; use verified manual shop rates until implemented" },
    { key: "email", name: "Email provider", category: "Notifications", configured: has("RESEND_API_KEY"), workflow: "Credential check only; sending adapter and delivery worker are not connected" },
    { key: "sms", name: "SMS provider", category: "Notifications", configured: has("TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN", "TWILIO_PHONE_NUMBER"), workflow: "Credential check only; sending adapter and delivery worker are not connected" },
    { key: "whatsapp", name: "WhatsApp Business", category: "Notifications", configured: has("WHATSAPP_ACCESS_TOKEN", "WHATSAPP_PHONE_NUMBER_ID"), workflow: "Credential check only; approved-template sending and delivery callbacks are not connected" }
  ];
  return NextResponse.json({ tenantId, checkedAt: new Date().toISOString(), integrations });
}
