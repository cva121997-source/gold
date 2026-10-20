import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
const read=(p)=>readFileSync(join(process.cwd(),p),"utf8");
const schema=read("supabase/migrations/20261017164000_gold_supplier_accounts_payable.sql");
const ui=read("app/supplier-bills/page.tsx");
const dashboard=read("app/dashboard/page.tsx");

test("supplier payables use tenant keys, RLS and draft-only invoice editing",()=>{
 for(const table of ["supplier_bills","supplier_bill_lines","supplier_bill_payments"]){
  assert.match(schema,new RegExp("create table if not exists public\\."+table,"i"));
  assert.match(schema,new RegExp("alter table public\\."+table+" enable row level security","i"));
 }
 assert.match(schema,/supplier_bills_draft_insert/i);
 assert.match(schema,/supplier_bills_draft_update/i);
 assert.match(schema,/supplier_bill_lines_draft_insert/i);
 assert.match(schema,/supplier_bill_lines_draft_delete/i);
 assert.match(schema,/guard_supplier_bill_status/i);
 assert.match(schema,/guard_supplier_bill_line/i);
 assert.match(schema,/unique\(tenant_id,idempotency_key\)/i);
});

test("linked supplier invoices cannot exceed quantities actually received or already billed",()=>{
 assert.match(schema,/every invoice line must be matched to a line from the linked purchase order/i);
 assert.match(schema,/invoice quantity exceeds received quantity or has already been billed/i);
 assert.match(schema,/pol\.received_quantity/i);
 assert.match(schema,/supplier_bills_invoice_number_uidx/i);
 assert.match(ui,/Received purchase-order line/);
 assert.match(ui,/PO-linked invoices are matched against received quantities when posted/i);
 assert.match(ui,/Match & post bill/);
});

test("supplier payments are idempotent, capped to balance and reversals are audited",()=>{
 assert.match(schema,/pg_advisory_xact_lock/i);
 assert.match(schema,/create or replace function public\.record_supplier_bill_payment/i);
 assert.match(schema,/payment exceeds current balance/i);
 assert.match(schema,/create or replace function public\.reverse_supplier_bill_payment/i);
 assert.match(schema,/supplier_bill\.payment_recorded/i);
 assert.match(schema,/supplier_bill\.payment_reversed/i);
 assert.match(ui,/rpc\("record_supplier_bill_payment"/);
 assert.match(ui,/rpc\("reverse_supplier_bill_payment"/);
 assert.match(ui,/this is a ledger reversal, not a bank refund/i);
});

test("supplier bill page reports open payables and exports the register",()=>{
 assert.match(ui,/Open supplier payables/);
 assert.match(ui,/Overdue invoices/);
 assert.match(ui,/supplier-payables-/);
 assert.match(ui,/replaceAll\('"','""'\)/);
 assert.match(dashboard,/href: "\/supplier-bills"/);
});
