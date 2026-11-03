import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const suite = readFileSync(
  join(process.cwd(), "tests/sql/business-workflow-success-transactional.test.sql"),
  "utf8"
);

test("business workflow success suite is one rollback-only transaction", () => {
  assert.match(suite, /^--[\s\S]*?\nBEGIN;/i);
  assert.match(suite.trim(), /ROLLBACK;$/i);
  assert.doesNotMatch(suite, /\b(?:DROP|TRUNCATE)\s+(?:TABLE|SCHEMA|DATABASE)\b/i);
  assert.doesNotMatch(suite, /GRANT\s+(?:INSERT|UPDATE|DELETE|ALL)\s+ON\s+(?:public|auth)\./i);
  assert.match(suite, /GRANT SELECT, INSERT ON pg_temp\.gold_business_workflow_results TO authenticated/i);
});

test("supplier bill posting, payment idempotency and reversal paths are exercised", () => {
  for (const fragment of [
    "public.post_supplier_bill",
    "public.record_supplier_bill_payment",
    "stage7-supplier-payment-40-a",
    "public.reverse_supplier_bill_payment",
    "status = 'partially_paid'",
    "status = 'paid'",
    "v_paid = 0",
  ]) {
    assert.ok(suite.includes(fragment), `Missing supplier workflow assertion: ${fragment}`);
  }
});

test("statement reconciliation checks exact matches, duplicate imports and unresolved lines", () => {
  assert.equal((suite.match(/public\.import_reconciliation_statement_lines/g) ?? []).length, 3);
  assert.match(suite, /Repeated statement import is idempotent/);
  assert.match(suite, /Unresolved statement line prevents false reconciliation/);
  assert.match(suite, /v_status = 'investigating'/);
});

test("invoice and credit-note issuance paths are exercised", () => {
  for (const fragment of [
    "public.create_draft_invoice",
    "public.finalize_invoice",
    "public.create_credit_note_draft",
    "public.issue_credit_note",
    "Credit-note draft issues and preserves its positive total",
  ]) {
    assert.ok(suite.includes(fragment), `Missing credit-note workflow assertion: ${fragment}`);
  }
});

test("all business fixtures use a dedicated synthetic namespace", () => {
  assert.match(suite, /f17f1001-0000-4000-8000-000000000001/);
  assert.match(suite, /STAGE7_TEST_20261103/);
  assert.match(suite, /gold-stage7-owner-20261103@example\.invalid/);
  assert.match(suite, /ROLLBACK;/);
});
