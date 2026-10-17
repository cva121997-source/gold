// Server-only authorization helper for platform administration endpoints.
// SUPABASE_SERVICE_ROLE_KEY must be configured only on the server; never expose it as NEXT_PUBLIC_*.
import { createClient as createSupabaseClient } from "@supabase/supabase-js";
import { NextResponse } from "next/server";
import { createClient as createSessionClient } from "@/lib/supabase/server";

export async function getPlatformAdminContext() {
  let session;
  try {
    session = await createSessionClient();
  } catch {
    return { response: NextResponse.json({ error: "Supabase session configuration is missing." }, { status: 503 }) } as const;
  }
  const { data: { user }, error: userError } = await session.auth.getUser();
  if (userError || !user) {
    return { response: NextResponse.json({ error: "Sign in to access platform administration." }, { status: 401 }) } as const;
  }
  const projectUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!projectUrl || !serviceKey) {
    return { response: NextResponse.json({
      error: "Platform administration is not configured on this server. Set SUPABASE_SERVICE_ROLE_KEY as a server-only environment variable. Never add it to Git or a NEXT_PUBLIC_* variable."
    }, { status: 503 }) } as const;
  }
  const admin = createSupabaseClient(projectUrl, serviceKey, { auth: { autoRefreshToken: false, persistSession: false } });
  const { data: profile, error: roleError } = await admin.from("platform_admins").select("admin_role").eq("user_id", user.id).maybeSingle();
  if (roleError) return { response: NextResponse.json({ error: "Could not verify platform administrator permissions." }, { status: 500 }) } as const;
  if (!profile) return { response: NextResponse.json({ error: "This account is not registered as a platform administrator." }, { status: 403 }) } as const;
  return { admin, user, adminRole: profile.admin_role } as const;
}
