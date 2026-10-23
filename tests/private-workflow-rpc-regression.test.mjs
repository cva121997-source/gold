import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const migration = readFileSync(
  join(process.cwd(), "supabase/migrations/20261023200955_gold_private_workflow_rpc_implementations.sql"),
  "utf8"
);

const reviewedRpcs = [
  "add_stock_transfer_item",
  "approve_supplier_bill_price_variance",
  "begin_razorpay_gateway_refund",
  "cancel_stock_transfer",
  "complete_manual_refund",
  "create_credit_note_draft",
  "create_draft_invoice_for_inventory_item",
  "create_inventory_stocktake",
  "create_stock_transfer",
  "dispatch_stock_transfer",
  "finalize_inventory_stocktake",
  "import_reconciliation_statement_lines",
  "issue_credit_note",
  "mark_inventory_stocktake_item",
  "post_supplier_bill",
  "receive_purchase_order",
  "receive_stock_transfer",
  "record_credit_note_stock_return",
  "record_customer_consent",
  "record_supplier_bill_payment",
  "request_refund",
  "resolve_inventory_stocktake_discrepancy",
  "revalue_inventory_item",
  "reverse_supplier_bill_payment",
  "review_provider_gold_rate",
  "review_refund_request",
  "review_stock_transfer",
  "set_scheme_lifecycle",
  "submit_purchase_order",
  "submit_stock_transfer",
  "update_scheme_draft",
  "void_draft_credit_note",
  "void_supplier_bill",
];

test("all 33 reviewed workflow RPCs are included in the private-implementation migration", () => {
  assert.equal(reviewedRpcs.length, 33);
  assert.equal(new Set(reviewedRpcs).size, reviewedRpcs.length);

  for (const rpc of reviewedRpcs) {
    assert.ok(
      migration.includes(`'${rpc}'`),
      `missing reviewed RPC from migration target list: ${rpc}`
    );
  }
});

test("exposed RPC wrappers use SECURITY INVOKER and fixed search paths", () => {
  assert.match(
    migration,
    /create function public\.%I\(%s\) returns %s[\s\S]*?language sql security invoker[\s\S]*?set search_path to public, private, pg_temp/i
  );
  assert.match(
    migration,
    /create or replace function public\.set_scheme_lifecycle\([\s\S]*?security invoker[\s\S]*?private\.set_scheme_lifecycle/i
  );
  assert.match(
    migration,
    /create or replace function public\.update_scheme_draft\([\s\S]*?security invoker[\s\S]*?private\.update_scheme_draft/i
  );
});

test("workflow wrappers revoke PUBLIC/anon access and explicitly grant intended API roles", () => {
  assert.match(
    migration,
    /revoke all on function public\.%I\(%s\) from public, anon/i
  );
  assert.match(
    migration,
    /grant execute on function public\.%I\(%s\) to authenticated, service_role/i
  );
  assert.match(migration, /notify pgrst, 'reload schema'/i);
});
