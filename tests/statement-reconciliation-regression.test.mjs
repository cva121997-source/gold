import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const read = path => readFileSync(join(process.cwd(), path), "utf8");
const schema = read("supabase/migrations/20261021072640_gold_statement_line_reconciliation.sql");
const lineReview = read("supabase/migrations/20261021073158_gold_statement_reconciliation_line_review.sql");
const page = read("app/reconciliation/statements/page.tsx");
const dashboard = read("app/dashboard/page.tsx");

test("statement line table is private, tenant-scoped and deduplicated", () => {
  assert.match(schema, /create table if not exists public\.reconciliation_statement_lines/i);
  assert.match(schema, /unique\(tenant_id,reconciliation_id,statement_line_key\)/i);
  assert.match(schema, /enable row level security/i);
  assert.match(schema, /revoke insert,update,delete on public\.reconciliation_statement_lines from authenticated/i);
  assert.match(schema, /create unique index if not exists reconciliation_statement_single_match_uidx/i);
  assert.match(schema, /grant execute on function public\.import_reconciliation_statement_lines\(uuid,uuid,jsonb\) to authenticated/i);
});

test("statement import requires authorized shop role, scoped period, bounded batches and stable line keys", () => {
  assert.match(schema, /private\.has_tenant_role\(p_tenant_id,array\['owner','manager','accountant'\]\)/i);
  assert.match(schema, /jsonb_array_length\(p_lines\)>1000/i);
  assert.match(schema, /v_date<v_recon\.period_start or v_date>v_recon\.period_end/i);
  assert.match(schema, /md5\(v_date::text/);
  assert.match(schema, /p\.provider_payment_ref=v_reference/);
  assert.match(schema, /p\.status='confirmed'/);
});

test("total agreement alone cannot mark a statement reconciled while individual lines remain unresolved", () => {
  assert.match(lineReview, /count\(\*\) filter \(where line_status<>'matched'\)/i);
  assert.match(lineReview, /abs\(expected_amount-v_sum\)<0\.01 and v_unresolved=0 then 'matched'/i);
  assert.match(lineReview, /when abs\(expected_amount-v_sum\)<0\.01 then 'investigating'/i);
});

test("CSV workspace validates input, previews before import, and never rewrites payment ledger", () => {
  assert.match(page, /parseStatementCsv/);
  assert.match(page, /transaction_date,provider_reference,amount/);
  assert.match(page, /Up to 1,000 rows \/ 2 MB per import/);
  assert.match(page, /No ledger entries have been changed/);
  assert.match(page, /import_reconciliation_statement_lines/);
  assert.match(page, /range\(from, Math\.min\(from \+ 999, 50000\)\)/);
  assert.match(page, /all\.length > 50000/);
  assert.match(page, /Unmatched lines may be settlement transfers/);
  assert.match(dashboard, /href: "\/reconciliation\/statements"/);
  assert.doesNotMatch(page, /\.from\("payments"\)\.update|\.from\("payments"\)\.insert/);
});
