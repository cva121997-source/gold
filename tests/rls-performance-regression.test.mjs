import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const migration = readFileSync(
  join(
    process.cwd(),
    "supabase/migrations/20261024145929_gold_rls_policy_and_duplicate_index_optimization.sql"
  ),
  "utf8"
);

const policyTables = [
  "customer_orders",
  "feature_entitlements",
  "inventory_items",
  "product_categories",
  "products",
  "profiles",
  "rate_sources",
  "reconciliation_records",
  "repair_jobs",
  "staff_invitations",
  "suppliers",
  "system_integrations",
  "tax_configurations",
];

test("RLS performance migration covers the reviewed overlapping-policy tables", () => {
  assert.equal(policyTables.length, 13);
  for (const table of policyTables) {
    assert.ok(migration.includes(`'${table}'`), `missing policy optimization target: ${table}`);
  }
});

test("customer note and interaction writes use auth.uid() init-plan expressions", () => {
  assert.match(
    migration,
    /create policy customer_notes_staff_insert[\s\S]*?created_by = \(select auth\.uid\(\)\)/i
  );
  assert.match(
    migration,
    /create policy customer_interactions_staff_insert[\s\S]*?created_by = \(select auth\.uid\(\)\)/i
  );
});

test("ALL policy writes are split without changing their original predicates", () => {
  assert.match(migration, /create policy perf_select_optimized[\s\S]*?using \(%s\)/i);
  assert.match(migration, /create policy perf_insert_optimized[\s\S]*?with check \(%s\)/i);
  assert.match(migration, /create policy perf_update_optimized[\s\S]*?using \(%s\) with check \(%s\)/i);
  assert.match(migration, /create policy perf_delete_optimized[\s\S]*?using \(%s\)/i);
  assert.match(migration, /coalesce\(v_all_policy\.with_check,v_all_policy\.qual,'true'\)/i);
});

test("only proven redundant standalone indexes are dropped", () => {
  assert.match(migration, /drop index if exists public\.inventory_items_tenant_id_unique_idx/i);
  assert.match(migration, /drop index if exists public\.inventory_items_tenant_item_code_uidx/i);
  assert.match(migration, /drop index if exists public\.suppliers_tenant_id_unique_idx/i);
  assert.doesNotMatch(migration, /drop constraint[^;]*(stock_transfer_items_tenant_item_unique|stock_transfers_tenant_id_unique)/i);
});
