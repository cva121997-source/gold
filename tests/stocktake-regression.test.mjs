import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const read = (path) => readFileSync(join(process.cwd(), path), "utf8");
const schema = read("supabase/migrations/20261017155739_gold_inventory_stocktake_workflow.sql");
const page = read("app/stocktakes/page.tsx");
const dashboard = read("app/dashboard/page.tsx");

test("stocktake snapshots are branch-scoped and read-only outside audited RPC workflows", () => {
  assert.match(schema, /create table if not exists public\.inventory_stocktakes/i);
  assert.match(schema, /create table if not exists public\.inventory_stocktake_lines/i);
  assert.match(schema, /alter table public\.inventory_stocktakes enable row level security/i);
  assert.match(schema, /alter table public\.inventory_stocktake_lines enable row level security/i);
  assert.match(schema, /grant select on public\.inventory_stocktakes,public\.inventory_stocktake_lines to authenticated/i);
  assert.match(schema, /create policy inventory_stocktakes_branch_read/i);
  assert.match(schema, /create policy inventory_stocktake_lines_branch_read/i);
  assert.match(schema, /create or replace function public\.create_inventory_stocktake/i);
  assert.match(schema, /create or replace function public\.mark_inventory_stocktake_item/i);
  assert.match(schema, /create or replace function public\.finalize_inventory_stocktake/i);
});

test("stocktake workflow snapshots only on-hand pieces and records audit evidence", () => {
  assert.match(schema, /ii\.status in \('in_stock','reserved','repair'\)/i);
  assert.match(schema, /inventory\.stocktake_started/i);
  assert.match(schema, /inventory\.stocktake_finalized/i);
  assert.match(schema, /found_count=v_found,missing_count=v_missing,extra_count=v_extra,changed_during_count=v_changed/i);
  assert.match(schema, /only a shop owner or manager can finalise/i);
  assert.match(schema, /an unexpected item must be marked as found/i);
  assert.match(schema, /does not silently|never silently/i);
});

test("stock reconciliation UI supports scan lookup, counting, final review and navigation", () => {
  assert.match(page, /rpc\("create_inventory_stocktake"/i);
  assert.match(page, /rpc\("mark_inventory_stocktake_item"/i);
  assert.match(page, /rpc\("finalize_inventory_stocktake"/i);
  assert.match(page, /item_code,item\.serial_number,item\.barcode,item\.huid/i);
  assert.match(page, /Add as extra & mark found/i);
  assert.match(page, /missing items were not automatically written off/i);
  assert.match(dashboard, /href: "\/stocktakes"/);
});
