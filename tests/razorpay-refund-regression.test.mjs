import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const read = path => readFileSync(join(process.cwd(), path), "utf8");
const refundRoute = read("app/api/payments/razorpay/refund/route.ts");
const webhook = read("app/api/payments/razorpay/webhook/route.ts");
const page = read("app/refunds/page.tsx");
const initialMigration = read("supabase/migrations/20261020125926_gold_razorpay_gateway_refunds.sql");
const serverOnlyMigration = read("supabase/migrations/20261021070336_gold_razorpay_refund_server_only.sql");
const orderingMigration = read("supabase/migrations/20261021070558_gold_razorpay_refund_method_and_ordering.sql");

test("gateway refund submission is authenticated and requires an approved refund RPC", () => {
  assert.match(refundRoute, /auth\.getUser\(\)/);
  assert.match(refundRoute, /session\.rpc\("begin_razorpay_gateway_refund"/);
  assert.match(initialMigration, /private\.has_tenant_role\(p_tenant_id,array\['owner','manager','accountant'\]\)/);
  assert.match(initialMigration, /status not in \('approved','processing'\)/i);
  assert.match(initialMigration, /unique index if not exists refunds_tenant_provider_idempotency_uidx/i);
});

test("gateway refund requests carry a stable receipt and do not blindly resend uncertain requests", () => {
  assert.match(refundRoute, /goldr/);
  assert.match(refundRoute, /gold_refund_id: refundId/);
  assert.match(refundRoute, /if \(!submissionAllowed\)/);
  assert.match(refundRoute, /fetchExistingRefund\(providerPaymentRef, receipt, refundId, amountPaise, auth\)/);
  assert.match(refundRoute, /No second refund was submitted/);
  assert.match(refundRoute, /will not send a second refund automatically/);
  assert.doesNotMatch(refundRoute, /["']X-Refund-Idempotency["']\s*:/);
});

test("provider outcome RPC is server-only and validates refund statuses", () => {
  assert.match(serverOnlyMigration, /revoke all on function public\.record_razorpay_gateway_refund_result\(uuid,uuid,text,text,text,text\) from public,anon,authenticated/i);
  assert.match(serverOnlyMigration, /grant execute on function public\.record_razorpay_gateway_refund_result\(uuid,uuid,text,text,text,text\) to service_role/i);
  assert.match(serverOnlyMigration, /p_provider_status not in \('pending','processed','failed'\)/);
});

test("signed Razorpay refund callbacks enter the event ledger and state updates cannot downgrade completed refunds", () => {
  assert.match(webhook, /safeEqualHex\(signature, expectedSignature\)/);
  assert.match(webhook, /refund\.created.*refund\.processed.*refund\.failed.*refund\.speed_changed/s);
  assert.match(webhook, /process_razorpay_refund_webhook_event/);
  assert.match(orderingMigration, /when v_existing_status='completed' then 'completed'/);
  assert.match(orderingMigration, /when p_event_type='refund\.processed' then 'completed'/);
  assert.match(orderingMigration, /payment_webhook_events/);
});

test("Refunds screen can submit approved payouts and reconcile ones already processing", () => {
  assert.match(page, /fetch\("\/api\/payments\/razorpay\/refund"/);
  assert.match(page, /Submit Razorpay refund/);
  assert.match(page, /Reconcile Razorpay refund/);
  assert.match(page, /does not create a second refund automatically/);
});
