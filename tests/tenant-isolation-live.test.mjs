import test from "node:test";
import assert from "node:assert/strict";
import { createClient } from "@supabase/supabase-js";

const env = process.env;
const required = [
  "GOLD_ISOLATION_TEST_SUPABASE_URL",
  "GOLD_ISOLATION_TEST_ANON_KEY",
  "GOLD_ISOLATION_TEST_PHONE",
  "GOLD_ISOLATION_TEST_PASSWORD",
  "GOLD_ISOLATION_TEST_TENANT_A_ID",
  "GOLD_ISOLATION_TEST_TENANT_B_ID",
  "GOLD_ISOLATION_TEST_CUSTOMER_B_ID"
];
const ready = required.every(key => Boolean(env[key]?.trim()));
const productionHost = "oidfkbshfywexmvsrkkd.supabase.co";

test("live tenant isolation check is limited to a dedicated staging project", { skip: !ready }, async () => {
  const url = new URL(env.GOLD_ISOLATION_TEST_SUPABASE_URL);
  assert.notEqual(url.hostname.toLowerCase(), productionHost,
    "Tenant isolation tests must never run against the production Gold project.");
  assert.notEqual(env.GOLD_ISOLATION_TEST_TENANT_A_ID, env.GOLD_ISOLATION_TEST_TENANT_B_ID,
    "Create two distinct staging tenants before running this test.");
});

test("a Shop A staging user cannot read a Shop B customer fixture", { skip: !ready }, async () => {
  const url = new URL(env.GOLD_ISOLATION_TEST_SUPABASE_URL);
  assert.notEqual(url.hostname.toLowerCase(), productionHost,
    "Tenant isolation tests must never run against the production Gold project.");
  assert.notEqual(env.GOLD_ISOLATION_TEST_TENANT_A_ID, env.GOLD_ISOLATION_TEST_TENANT_B_ID,
    "Create two distinct staging tenants.");

  const supabase = createClient(env.GOLD_ISOLATION_TEST_SUPABASE_URL, env.GOLD_ISOLATION_TEST_ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false }
  });
  const { data: signedIn, error: authError } = await supabase.auth.signInWithPassword({
    phone: env.GOLD_ISOLATION_TEST_PHONE, password: env.GOLD_ISOLATION_TEST_PASSWORD
  });
  assert.ifError(authError);
  assert.ok(signedIn.user, "Staging test account must authenticate.");

  const membership = await supabase.from("tenant_memberships").select("tenant_id")
    .eq("tenant_id", env.GOLD_ISOLATION_TEST_TENANT_A_ID).eq("user_id", signedIn.user.id).eq("is_active", true);
  assert.ifError(membership.error);
  assert.equal(membership.data?.length, 1, "Test account must belong to Shop A.");

  const crossTenantRead = await supabase.from("tenant_customers").select("id,tenant_id")
    .eq("tenant_id", env.GOLD_ISOLATION_TEST_TENANT_B_ID).eq("id", env.GOLD_ISOLATION_TEST_CUSTOMER_B_ID);
  assert.ifError(crossTenantRead.error);
  assert.equal(crossTenantRead.data?.length ?? 0, 0, "RLS must hide Shop B's customer from a Shop A user.");
  await supabase.auth.signOut();
});
