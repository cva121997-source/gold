import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const read=(path)=>readFileSync(join(process.cwd(),path),"utf8");
const workflow=read("supabase/migrations/20261017163000_gold_branch_transfer_approval_workflow.sql");
const integrity=read("supabase/migrations/20261017163200_gold_branch_transfer_tenant_integrity.sql");
const snapshot=read("supabase/migrations/20261017163100_gold_branch_transfer_item_snapshots.sql");
const page=read("app/transfers/page.tsx");
const inventory=read("app/inventory/page.tsx");
const dashboard=read("app/dashboard/page.tsx");

test("branch transfer tables are tenant-scoped and cannot be written directly by browser roles",()=>{
 assert.match(workflow,/alter table public\.stock_transfers enable row level security/i);
 assert.match(workflow,/alter table public\.stock_transfer_items enable row level security/i);
 assert.match(workflow,/revoke insert,update,delete on public\.stock_transfers,public\.stock_transfer_items from public,anon,authenticated/i);
 assert.match(workflow,/create policy stock_transfers_branch_read/i);
 assert.match(workflow,/create policy stock_transfer_items_branch_read/i);
 assert.match(integrity,/foreign key\(tenant_id,inventory_item_id\) references public\.inventory_items\(tenant_id,id\)/i);
});

test("transfers require second-person approval and distinct dispatch and receipt states",()=>{
 for(const fn of ["create_stock_transfer","add_stock_transfer_item","submit_stock_transfer","review_stock_transfer","dispatch_stock_transfer","receive_stock_transfer","cancel_stock_transfer"])
  assert.match(workflow,new RegExp("create or replace function public\\."+fn,"i"),fn);
 assert.match(workflow,/transfer_pending/i);
 assert.match(workflow,/status='pending_approval'/i);
 assert.match(workflow,/the transfer requester cannot approve their own transfer/i);
 assert.match(workflow,/status='in_transit'/i);
 assert.match(workflow,/status='received'/i);
 assert.match(integrity,/transfer requester cannot approve their own transfer/i);
 assert.match(workflow,/direct transfers are disabled/i);
});

test("transfer snapshots preserve piece identifiers and weights across branches",()=>{
 assert.match(snapshot,/item_code_snapshot text/i);
 assert.match(snapshot,/huid_snapshot text/i);
 assert.match(snapshot,/barcode_snapshot text/i);
 assert.match(snapshot,/gross_weight_grams_snapshot/i);
 assert.match(snapshot,/net_metal_weight_grams_snapshot/i);
 assert.match(page,/item_code_snapshot/);
 assert.match(page,/barcode_snapshot/);
 assert.match(page,/rpc\("dispatch_stock_transfer"/);
 assert.match(page,/rpc\("receive_stock_transfer"/);
 assert.match(page,/Confirm received at destination/);
 assert.match(inventory,/href="\/transfers">Request branch transfer/);
 assert.match(dashboard,/href: "\/transfers"/);
});
