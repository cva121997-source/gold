import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const read = path => readFileSync(join(process.cwd(), path), "utf8");
const route = read("app/api/integrations/status/route.ts");
const page = read("app/integrations/page.tsx");

test("integration activity is access-controlled and strictly tenant scoped", () => {
  assert.match(route, /auth\.getUser\(\)/);
  assert.match(route, /eq\("tenant_id", tenantId\)\.eq\("user_id", user\.id\)/);
  assert.match(route, /\["owner", "manager"\]\.includes\(membership\.role\)/);
  assert.match(route, /from\("rate_provider_runs"\).*?eq\("tenant_id", tenantId\)/s);
  assert.match(route, /from\("notifications"\).*?eq\("tenant_id", tenantId\)/s);
  assert.match(route, /from\("payments"\).*?eq\("tenant_id", tenantId\)/s);
  assert.match(route, /from\("tenant_subscriptions"\).*?eq\("tenant_id", tenantId\)/s);
  assert.match(route, /\.limit\(500\)/);
  assert.doesNotMatch(route, /safe_payload|customer_id|mobile_e164|provider_event_id/);
});

test("integration activity summarizes last success, last failure, retry backlog and sample size", () => {
  assert.match(route, /lastSuccessfulAt/);
  assert.match(route, /lastFailureAt/);
  assert.match(route, /recentFailures/);
  assert.match(route, /pendingCount/);
  assert.match(route, /activityWindowDays: 30/);
  assert.match(page, /Recent activity · last 30 days/);
  assert.match(page, /Last success/);
  assert.match(page, /Last failure/);
  assert.match(page, /Pending \/ processing/);
  assert.match(page, /Records checked/);
});

test("integration readiness does not represent provider credentials as a successful connection", () => {
  assert.match(page, /Configured.*does not necessarily mean a provider has been tested/s);
  assert.match(route, /No confirmed success/);
  assert.match(route, /activityAvailable/);
});
