import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const read = path => readFileSync(join(process.cwd(), path), "utf8");
const sql = read("supabase/migrations/20261020124000_gold_credit_note_stock_returns.sql");
const page = read("app/credit-notes/page.tsx");
const pos = read("app/pos/page.tsx");
const dashboard = read("app/dashboard/page.tsx");

test("credit note stock return migration is idempotent and tenant/branch protected", () => {
  assert.match(sql, /create table if not exists public\.credit_note_inventory_returns/i);
  assert.match(sql, /unique \(tenant_id, inventory_item_id\)/i);
  assert.match(sql, /unique \(tenant_id, idempotency_key\)/i);
  assert.match(sql, /enable row level security/i);
  assert.match(sql, /revoke insert, update, delete on public\.credit_note_inventory_returns from authenticated/i);
  assert.match(sql, /private\.has_tenant_branch_access/i);
});

test("only the tracked piece sold on the source invoice can be returned", () => {
  assert.match(sql, /v_note\.status<>'issued'/i);
  assert.match(sql, /v_invoice_line\.inventory_item_id is distinct from p_inventory_item_id/i);
  assert.match(sql, /v_item\.status<>'sold'/i);
  assert.match(sql, /only an owner, manager or inventory manager can process returned stock/i);
  assert.match(sql, /update public\.inventory_items set status=v_new_status/i);
  assert.match(sql, /movement_type,quantity,from_branch_id,to_branch_id,reference,reason,actor_user_id/i);
  assert.match(sql, /inventory\.customer_return_recorded/i);
});

test("physical return UI requires disposition and reason, shows audit history, and keeps refunds separate", () => {
  assert.match(page, /record_credit_note_stock_return/);
  assert.match(page, /Physical stock return/);
  assert.match(page, /inspection reason/i);
  assert.match(page, /Restocked to Current Gold/);
  assert.match(page, /Sent to repair/);
  assert.match(page, /refund/i);
  assert.match(pos, /A credit note does not prove physical receipt/i);
  assert.match(dashboard, /href: "\/credit-notes"/);
});
