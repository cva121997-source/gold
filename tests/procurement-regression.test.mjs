import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const read = (path) => readFileSync(join(process.cwd(), path), "utf8");
const procurement = read("supabase/migrations/20261017154744_gold_procurement_inventory_controls.sql");
const purchasing = read("app/purchasing/page.tsx");
const inventory = read("app/inventory/page.tsx");
const dashboard = read("app/dashboard/page.tsx");
const tabs = read("components/gold-inventory-tabs.tsx");

test("procurement schema is tenant scoped and keeps stock receipts server written", () => {
  for (const table of ["purchase_orders", "purchase_order_lines", "goods_receipts", "goods_receipt_lines"]) {
    assert.match(procurement, new RegExp("create table if not exists public\\." + table, "i"));
    assert.match(procurement, new RegExp("alter table public\\." + table + " enable row level security", "i"));
  }
  assert.match(procurement, /unique\(tenant_id,po_number\)/i);
  assert.match(procurement, /unique\(tenant_id,idempotency_key\)/i);
  assert.match(procurement, /revoke all on public\.goods_receipts,public\.goods_receipt_lines from anon/i);
  assert.match(procurement, /create policy purchase_orders_branch_read/i);
  assert.match(procurement, /create policy goods_receipts_branch_read/i);
  assert.match(procurement, /create or replace function public\.submit_purchase_order/i);
  assert.match(procurement, /create or replace function public\.receive_purchase_order/i);
  assert.match(procurement, /for update/i);
  assert.match(procurement, /purchase_order\.stock_received/i);
  assert.match(procurement, /purchase_receipt/i);
});

test("goods-receipt workflow validates each jewellery piece before increasing stock", () => {
  assert.match(procurement, /p_idempotency_key is null/i);
  assert.match(procurement, /ordered quantity.*already been received/i);
  assert.match(procurement, /net_metal_weight_grams.*stone_weight_grams.*gross_weight_grams/is);
  assert.match(procurement, /insert into public\.inventory_items/i);
  assert.match(procurement, /insert into public\.inventory_movements/i);
  assert.match(procurement, /insert into public\.goods_receipt_lines/i);
  assert.match(procurement, /update public\.purchase_order_lines set received_quantity=received_quantity\+1/i);
  assert.match(procurement, /public\.submit_purchase_order\(uuid,uuid\).*authenticated/is);
  assert.match(procurement, /public\.receive_purchase_order\(uuid,uuid,text,text,jsonb\).*authenticated/is);
});

test("purchasing UI supports draft orders, line editing, submit, partial goods receipt and piece identity", () => {
  assert.match(purchasing, /from\("purchase_orders"\)/);
  assert.match(purchasing, /from\("purchase_order_lines"\)/);
  assert.match(purchasing, /rpc\("submit_purchase_order"/);
  assert.match(purchasing, /rpc\("receive_purchase_order"/);
  assert.match(purchasing, /status === "draft"/);
  assert.match(purchasing, /partially_received/);
  assert.match(purchasing, /barcode/);
  assert.match(purchasing, /huid/);
  assert.match(purchasing, /net_metal_weight_grams/);
  assert.match(dashboard, /href: "\/purchasing"/);
});

test("current-gold register shows actual received item weights and identifiers", () => {
  assert.match(inventory, /barcode,huid,purity_id,gross_weight_grams,net_metal_weight_grams,stone_weight_grams/);
  assert.match(tabs, /item\.net_metal_weight_grams\?\?productMap\.get\(item\.product_id\)\?\.net_metal_weight_grams/);
  assert.match(tabs, /item\.huid\|\|product\?\.huid/);
  assert.match(tabs, /item\.barcode\|\|product\?\.barcode/);
  assert.match(tabs, /Net metal weight/);
  assert.match(tabs, /exportCurrent/);
});
