import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const read = (path) => readFileSync(join(process.cwd(), path), "utf8");
const base = read("supabase/migrations/20261017082144_gold_retail_operations.sql");
const fix = read("supabase/migrations/20261103140500_gold_reconciliation_generated_difference_fix.sql");

test("reconciliation period difference remains generated as actual minus expected", () => {
  assert.match(
    base,
    /difference_amount numeric\(14,2\) generated always as \(actual_amount - expected_amount\) stored/i
  );
});

test("statement import updates source amounts instead of writing a generated column", () => {
  assert.match(fix, /create or replace function private\.import_reconciliation_statement_lines/i);
  const update = fix.match(/update public\.reconciliation_records[\s\S]*?where tenant_id=p_tenant_id and id=p_reconciliation_id/i)?.[0];
  assert.ok(update, "reconciliation update statement must exist");
  assert.match(update, /set actual_amount=v_sum,/i);
  assert.doesNotMatch(update, /difference_amount\s*=/i);
});

test("RPC return value and audit difference use the generated column sign", () => {
  assert.equal((fix.match(/round\(v_sum-v_recon\.expected_amount,2\)/g) ?? []).length, 2);
  assert.doesNotMatch(fix, /round\(v_recon\.expected_amount-v_sum,2\)/i);
  assert.match(fix, /security definer set search_path=public,private,pg_temp/i);
});

test("fix preserves the public RPC surface and does not grant table privileges", () => {
  assert.match(fix, /create or replace function private\.import_reconciliation_statement_lines/i);
  assert.doesNotMatch(fix, /grant\s+(?:insert|update|delete|all)\s+on\s+public\./i);
  assert.match(fix, /notify pgrst, 'reload schema'/i);
});
