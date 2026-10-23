import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
const migration=readFileSync(join(process.cwd(),"supabase/migrations/20261017162826_gold_supplier_bill_void_workflow.sql"),"utf8");
const page=readFileSync(join(process.cwd(),"app/supplier-bills/page.tsx"),"utf8");

test("supplier bill voiding is auditable and cannot erase payment history",()=>{
 assert.match(migration,/create or replace function public\.void_supplier_bill/i);
 assert.match(migration,/provide a void reason between 5 and 500 characters/i);
 assert.match(migration,/only draft or unpaid posted bills can be voided/i);
 assert.match(migration,/reverse supplier payment entries first/i);
 assert.match(migration,/supplier_bill\.voided/i);
 assert.match(page,/rpc\("void_supplier_bill"/i);
 assert.match(page,/Void supplier bill/i);
 assert.match(page,/Voiding is allowed only for drafts or unpaid posted bills/i);
});
