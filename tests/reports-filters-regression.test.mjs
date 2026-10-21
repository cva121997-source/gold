import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const page=readFileSync(join(process.cwd(),"app/reports/page.tsx"),"utf8");
const dashboard=readFileSync(join(process.cwd(),"app/dashboard/page.tsx"),"utf8");

test("reports are filterable by India-local date range and branch",()=>{
 assert.match(page,/report-from/);
 assert.match(page,/report-to/);
 assert.match(page,/report-branch/);
 assert.match(page,/startIndiaDay\(fromDate\)/);
 assert.match(page,/startIndiaDay\(nextDate\(toDate\)\)/);
 assert.match(page,/\.gte\("created_at",start\)\.lt\("created_at",end\)/);
 assert.match(page,/\.gte\("invoice_date",fromDate\)\.lte\("invoice_date",toDate\)/);
 assert.match(page,/paymentQuery=paymentQuery\.eq\("branch_id",branchId\)/);
 assert.match(page,/invoiceQuery=invoiceQuery\.eq\("branch_id",branchId\)/);
});

test("reports include issued credit notes, collection breakdown and scoped CSV export",()=>{
 assert.match(page,/from\("credit_notes"\)/);
 assert.match(page,/\.eq\("status","issued"\)/);
 assert.match(page,/Collections by payment method/);
 assert.match(page,/Issued credit notes in range/);
 assert.match(page,/gold-report-"\+fromDate\+"-to-"\+toDate/);
 assert.match(page,/replaceAll\('"','""'\)/);
 assert.match(page,/\\ufeff/);
 assert.match(page,/50,000-record safety limit per source/i);
 assert.match(dashboard,/href: "\/reports"/);
});

test("report metrics use actual returned tenant-scoped records instead of hard-coded values",()=>{
 assert.match(page,/setPayments\(paymentsData\)/);
 assert.match(page,/setInvoices\(invoicesData\)/);
 assert.match(page,/setCreditNotes\(creditData\)/);
 assert.match(page,/setCustomersCount\(c\.count\?\?0\)/);
 assert.match(page,/setItemsCount\(stock\.count\?\?0\)/);
});
