import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const read=(path)=>readFileSync(join(process.cwd(),path),"utf8");
const migration=read("supabase/migrations/20261017164200_gold_supplier_price_variance_approval.sql");
const page=read("app/supplier-bills/page.tsx");

test("PO-linked supplier price/tax variances require an independent reasoned approval",()=>{
 assert.match(migration,/approve_supplier_bill_price_variance/i);
 assert.match(migration,/purchase price or tax variance requires approval/i);
 assert.match(migration,/the bill creator cannot approve their own purchase price variance/i);
 assert.match(migration,/invalidate_supplier_bill_variance_after_line_change/i);
 assert.match(migration,/supplier_bill\.price_variance_approved/i);
 assert.match(page,/rpc\("approve_supplier_bill_price_variance"/);
 assert.match(page,/A separate owner\/manager must approve this variance/);
 assert.match(page,/Editing any bill line clears this approval/i);
 assert.match(page,/priceVarianceLines\.length>0&&!varianceApproved/);
 assert.match(page,/price_variance_approved_by/);
});
