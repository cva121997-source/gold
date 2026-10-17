import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
const read=(p)=>readFileSync(join(process.cwd(),p),"utf8");
const migration=read("supabase/migrations/20261017164300_gold_stocktake_discrepancy_resolution.sql");
const page=read("app/stocktakes/page.tsx");

test("stocktake missing-piece resolutions require owner/manager review and a reason",()=>{
 assert.match(migration,/create table if not exists public\.inventory_stocktake_resolutions/i);
 assert.match(migration,/alter table public\.inventory_stocktake_resolutions enable row level security/i);
 assert.match(migration,/only an owner or manager can resolve stocktake discrepancies/i);
 assert.match(migration,/provide a resolution reason between 5 and 500 characters/i);
 assert.match(migration,/item status changed during the count/i);
 assert.match(migration,/inventory\.stocktake_discrepancy_resolved/i);
 assert.match(migration,/private\.move_inventory_item\(p_tenant_id,v_item\.id,'write_off'/i);
 assert.match(migration,/found_after_count/i);
});

test("stocktake UI can write off or mark found only after the count is finalised",()=>{
 assert.match(page,/rpc\("resolve_inventory_stocktake_discrepancy"/i);
 assert.match(page,/Approve write-off/);
 assert.match(page,/Found after count/);
 assert.match(page,/resolutionMap/);
 assert.match(page,/missing items were not automatically written off/i);
});
