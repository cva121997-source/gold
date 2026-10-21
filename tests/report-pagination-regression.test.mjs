import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
const page = readFileSync(join(process.cwd(), "app/reports/page.tsx"), "utf8");
const docs = readFileSync(join(process.cwd(), "docs/IMPLEMENTATION_STATUS.md"), "utf8");

test("report source reads use explicit pages and fail visibly at a hard safety limit", () => {
  assert.match(page, /async function fetchAllPages/);
  assert.match(page, /pageSize=1000,maxRows=50000/);
  assert.match(page, /from<=maxRows/);
  assert.match(page, /rows\.length>maxRows/);
  assert.match(page, /\.range\(from,\s*to\)/);
  assert.match(page, /50,000-record safety limit/);
  assert.doesNotMatch(page, /.limit(2000)/);
});

test("report filters preserve shop, date and branch constraints while fetching pages", () => {
  assert.match(page, /eq\("tenant_id",tenantId\)\.gte\("created_at",start\)\.lt\("created_at",end\)/);
  assert.match(page, /eq\("tenant_id",tenantId\)\.gte\("invoice_date",fromDate\)\.lte\("invoice_date",toDate\)/);
  assert.match(page, /if\(branchId\).*?paymentQuery=paymentQuery\.eq\("branch_id",branchId\)/s);
  assert.match(page, /Promise\.all\(\[/);
});

test("report page explains the export cap and accounting-review limitation", () => {
  assert.match(page, /50,000-record safety limit/);
  assert.match(page, /not a substitute for reviewed accounting\/tax filings/);
});
