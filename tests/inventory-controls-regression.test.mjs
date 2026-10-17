import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
const read=(p)=>readFileSync(join(process.cwd(),p),"utf8");
const history=read("supabase/migrations/20261017162000_gold_inventory_valuation_and_reorder_controls.sql");
const reorder=read("supabase/migrations/20261017162100_gold_inventory_reorder_aggregation.sql");
const revalue=read("supabase/migrations/20261017162200_gold_audited_inventory_revaluation.sql");
const baseline=read("supabase/migrations/20261017162300_gold_inventory_valuation_baseline_backfill.sql");
const page=read("app/inventory-controls/page.tsx");
const dashboard=read("app/dashboard/page.tsx");

test("valuation history and reorder rules have branch-scoped RLS",()=>{
 assert.match(history,/create table if not exists public\.inventory_valuation_history/i);
 assert.match(history,/create table if not exists public\.inventory_reorder_rules/i);
 assert.match(history,/alter table public\.inventory_valuation_history enable row level security/i);
 assert.match(history,/alter table public\.inventory_reorder_rules enable row level security/i);
 assert.match(history,/inventory_reorder_rules_manager_insert/i);
 assert.match(history,/inventory_reorder_rules_manager_update/i);
 assert.match(history,/inventory_reorder_rules_manager_delete/i);
 assert.match(reorder,/security invoker/i);
 assert.match(reorder,/private\.has_tenant_branch_access/i);
});

test("valuation changes require a reason and are auditable",()=>{
 assert.match(revalue,/change item valuation through the audited revaluation workflow with a reason/i);
 assert.match(revalue,/create or replace function public\.revalue_inventory_item/i);
 assert.match(revalue,/previous_value.*new_value.*reason/is);
 assert.match(revalue,/inventory\.item_revalued/i);
 assert.match(history,/create trigger inventory_item_valuation_history/i);
 assert.match(baseline,/historical value not independently verified/i);
});

test("inventory controls support low stock setup, current counts, revaluation and CSV",()=>{
 assert.match(page,/rpc\("get_inventory_reorder_status"/i);
 assert.match(page,/rpc\("revalue_inventory_item"/i);
 assert.match(page,/Save branch rule/i);
 assert.match(page,/Revalue a tracked piece/i);
 assert.match(page,/reason \(required\)/i);
 assert.match(page,/exportHistory/i);
 assert.match(page,/gold-valuation-history-/i);
 assert.match(dashboard,/href: "\/inventory-controls"/);
});
