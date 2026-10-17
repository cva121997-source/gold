import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const read = (path) => readFileSync(join(root, path), "utf8");
const lifecycleSql = read("supabase/migrations/20261017103530_gold_lifecycle_and_refund_controls.sql");
const consentSql = read("supabase/migrations/20261017103610_gold_customer_consent_history_rpc.sql");

test("customer CRM history tables enforce row-level security and append-only client writes", () => {
  assert.match(lifecycleSql, /create table if not exists public\.customer_notes/i);
  assert.match(lifecycleSql, /create table if not exists public\.customer_interactions/i);
  assert.match(lifecycleSql, /alter table public\.customer_notes enable row level security/i);
  assert.match(lifecycleSql, /alter table public\.customer_interactions enable row level security/i);
  assert.match(lifecycleSql, /revoke update, delete on public\.customer_notes from anon, authenticated/i);
  assert.match(lifecycleSql, /revoke update, delete on public\.customer_interactions from anon, authenticated/i);
  assert.match(lifecycleSql, /private\.has_tenant_branch_access/i);
});

test("refund request validates a confirmed payment and limits requested balance", () => {
  assert.match(lifecycleSql, /create or replace function public\.request_refund/i);
  assert.match(lifecycleSql, /status='confirmed' for update/i);
  assert.match(lifecycleSql, /sum\(amount\).*from public\.refunds/is);
  assert.match(lifecycleSql, /Refund exceeds the remaining refundable payment balance/i);
  assert.match(lifecycleSql, /create or replace function public\.review_refund_request/i);
  assert.match(lifecycleSql, /create or replace function public\.complete_manual_refund/i);
  assert.match(lifecycleSql, /Gateway refunds must be completed through a verified provider refund workflow/i);
});

test("platform audit records are not exposed to browser roles", () => {
  assert.match(lifecycleSql, /create table if not exists public\.platform_audit_logs/i);
  assert.match(lifecycleSql, /alter table public\.platform_audit_logs enable row level security/i);
  assert.match(lifecycleSql, /revoke all on public\.platform_audit_logs from public,anon,authenticated/i);
  assert.match(lifecycleSql, /grant all on public\.platform_audit_logs to service_role/i);
});

test("customer consent grants and withdrawals use a trusted, audited RPC", () => {
  assert.match(consentSql, /create or replace function public\.record_customer_consent/i);
  assert.match(consentSql, /private\.has_tenant_branch_access/i);
  assert.match(consentSql, /withdrawn_at=coalesce\(withdrawn_at,now\(\)\)/i);
  assert.match(consentSql, /customer\.consent_withdrawn/i);
  assert.match(consentSql, /revoke all on function public\.record_customer_consent/i);
});

test("new lifecycle pages are wired to database workflows", () => {
  const redemptions = read("app/redemptions/page.tsx");
  const refunds = read("app/refunds/page.tsx");
  const customerHistory = read("app/customer-history/page.tsx");
  const auditLogs = read("app/audit-logs/page.tsx");
  assert.match(redemptions, /evaluate_scheme_benefit/);
  assert.match(redemptions, /request_scheme_redemption/);
  assert.match(redemptions, /review_scheme_redemption/);
  assert.match(refunds, /request_refund/);
  assert.match(refunds, /review_refund_request/);
  assert.match(refunds, /complete_manual_refund/);
  assert.match(customerHistory, /record_customer_consent/);
  assert.match(customerHistory, /customer_interactions/);
  assert.match(auditLogs, /from\("audit_logs"\)/);
});
