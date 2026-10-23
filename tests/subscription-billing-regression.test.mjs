import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const read = (path) => readFileSync(join(process.cwd(), path), "utf8");
const billingSchema = read("supabase/migrations/20261017152248_gold_subscription_billing_gateway.sql");
const processor = read("supabase/migrations/20261017152337_gold_subscription_webhook_processor.sql");
const createSubscription = read("app/api/billing/create-subscription/route.ts");
const cancelSubscription = read("app/api/billing/cancel-subscription/route.ts");
const subscriptionWebhook = read("app/api/payments/razorpay/subscription-webhook/route.ts");
const planAdminApi = read("app/api/platform-admin/plans/route.ts");
const planAdminPage = read("app/platform-admin/plans/page.tsx");

test("subscription provider references and webhook ledger are protected from browser writes", () => {
  assert.match(billingSchema, /provider_monthly_plan_ref/i);
  assert.match(billingSchema, /provider_annual_plan_ref/i);
  assert.match(billingSchema, /billing_interval/i);
  assert.match(billingSchema, /create table if not exists public\.subscription_webhook_events/i);
  assert.match(billingSchema, /alter table public\.subscription_webhook_events enable row level security/i);
  assert.match(billingSchema, /revoke all on public\.subscription_webhook_events from public,anon,authenticated/i);
  assert.match(billingSchema, /grant all on public\.subscription_webhook_events to service_role/i);
});

test("subscription webhook processor requires service role and rejects stale events", () => {
  assert.match(processor, /auth\.role\(\).*service_role/is);
  assert.match(processor, /latest_provider_event_at.*v_event_at/is);
  assert.match(processor, /older, replayed events must not roll status backwards/i);
  assert.match(processor, /feature_entitlements/i);
  assert.match(processor, /revoke all on function public\.apply_razorpay_subscription_event.*authenticated/is);
  assert.match(processor, /grant execute on function public\.apply_razorpay_subscription_event.*service_role/is);
});

test("shop subscription endpoint checks active owner before trial or provider checkout", () => {
  assert.match(createSubscription, /membership\.role !== "owner"/);
  assert.match(createSubscription, /price === 0/);
  assert.match(createSubscription, /\/plans/);
  assert.match(createSubscription, /\/subscriptions/);
  assert.match(createSubscription, /status: "pending"/);
  assert.match(createSubscription, /checkoutRequired: true/);
  assert.match(createSubscription, /provider_monthly_plan_ref/);
  assert.match(createSubscription, /provider_annual_plan_ref/);
  assert.match(createSubscription, /providerPlanRef/);
});

test("subscription webhook validates raw body signature and deduplicates event IDs", () => {
  assert.match(subscriptionWebhook, /x-razorpay-signature/);
  assert.match(subscriptionWebhook, /createHmac\("sha256", secret\)/);
  assert.match(subscriptionWebhook, /request\.text\(\)/);
  assert.match(subscriptionWebhook, /x-razorpay-event-id/);
  assert.match(subscriptionWebhook, /subscription_webhook_events/);
  assert.match(subscriptionWebhook, /apply_razorpay_subscription_event/);
});

test("only owner can cancel billing and paid cancellation is period-end", () => {
  assert.match(cancelSubscription, /membership\.role !== "owner"/);
  assert.match(cancelSubscription, /cancel_at_cycle_end: true/);
  assert.match(cancelSubscription, /cancel_at_period_end: true/);
});

test("platform-admin plan editor validates and audits pricing/entitlements", () => {
  assert.match(planAdminApi, /getPlatformAdminContext/);
  assert.match(planAdminApi, /monthlyPriceInr/);
  assert.match(planAdminApi, /annualPriceInr/);
  assert.match(planAdminApi, /subscription_plan_updated/);
  assert.match(planAdminApi, /platform_owner.*platform_admin/s);
  assert.match(planAdminPage, /Manage plans|Subscription plans/);
  assert.match(planAdminPage, /entitlements JSON/i);
});

test("Current Gold and Sold Gold tabs show actual stock and customer-linked invoices", () => {
  const tabs = read("components/gold-inventory-tabs.tsx");
  const inventory = read("app/inventory/page.tsx");
  const pos = read("app/pos/page.tsx");
  assert.match(tabs, /"current","Current Gold"/);
  assert.match(tabs, /"sold","Sold Gold"/);
  assert.match(tabs, /customerName:customer\?\.full_name/);
  assert.match(tabs, /row\.customerName/);
  assert.match(tabs, /customer_consents|tenant_customers/);
  assert.match(tabs, /credit_note_lines/);
  assert.match(tabs, /exportSold/);
  assert.match(inventory, /GoldInventoryTabs/);
  assert.match(pos, /create_draft_invoice_for_inventory_item/);
  assert.match(pos, /Choose the customer before selling a tracked gold stock item/);
});
