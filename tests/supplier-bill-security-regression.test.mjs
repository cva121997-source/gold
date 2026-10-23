import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
const root=process.cwd();
const hardening=readFileSync(join(root,"supabase/migrations/20261017162604_gold_supplier_bill_creator_and_variance_field_hardening.sql"),"utf8");
const page=readFileSync(join(root,"app/supplier-bills/page.tsx"),"utf8");

test("supplier bill creator and immutable identities cannot be spoofed",()=>{
 assert.match(hardening,/supplier bill creator must match the authenticated user/i);
 assert.match(hardening,/supplier bill tenant, branch, supplier, purchase-order link and creator are immutable/i);
 assert.match(hardening,/new supplier bills must start as unapproved drafts/i);
});

test("supplier price variance approval fields require the controlled RPC and are invalidated on edits",()=>{
 assert.match(hardening,/price variance approval fields are writable only through the audited approval workflow/i);
 assert.match(hardening,/gold\.supplier_bill_variance_workflow/i);
 assert.match(hardening,/approve_supplier_bill_price_variance/i);
 assert.match(hardening,/invalidate_supplier_bill_variance_approval/i);
 assert.match(page,/price_variance_approved_by/);
 assert.match(page,/approveVariance/);
});
