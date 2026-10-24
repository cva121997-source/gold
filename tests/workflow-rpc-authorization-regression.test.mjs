import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const migration = readFileSync(
  join(
    process.cwd(),
    "supabase/migrations/20261024155033_gold_stock_transfer_workflow_status_constraint_fix.sql"
  ),
  "utf8"
);
const transactionalSuite = readFileSync(
  join(
    process.cwd(),
    "tests/sql/workflow-rpc-authorization-transactional.test.sql"
  ),
  "utf8"
);

test("stock-transfer migration removes only the obsolete status check", () => {
  assert.match(
    migration,
    /drop constraint if exists stock_transfers_status_check/i
  );
  assert.match(
    migration,
    /stock_transfers_status_workflow_check[\s\S]*?convalidated[\s\S]*?pending_approval[\s\S]*?approved[\s\S]*?in_transit/i
  );
  assert.doesNotMatch(
    migration,
    /drop constraint if exists stock_transfers_status_workflow_check/i
  );
});

test("workflow RPC authorization suite is transaction-scoped and always rolls back", () => {
  assert.match(transactionalSuite, /\bBEGIN;/i);
  assert.match(transactionalSuite.trim(), /ROLLBACK;$/i);
  assert.doesNotMatch(
    transactionalSuite,
    /GRANT\s+(?:INSERT|UPDATE|DELETE|ALL)\s+ON\s+(?:public|auth)\./i
  );
});

test("workflow RPC suite contains the key authorization and identifier-tampering cases", () => {
  const requiredCases = [
    "add_stock_transfer_item blocks cross-tenant user",
    "submit_stock_transfer blocks cross-tenant user",
    "review_stock_transfer blocks cross-tenant user",
    "dispatch_stock_transfer blocks cross-tenant user",
    "receive_stock_transfer blocks cross-tenant user",
    "Cashier cannot create stock transfer",
    "Cashier cannot mark stocktake item",
    "Cashier cannot revalue inventory",
    "Cashier cannot record consent in sibling branch",
    "request_refund blocks wrong tenant",
    "review_refund_request blocks wrong tenant",
    "review_provider_gold_rate blocks wrong tenant",
    "create_draft_invoice prevents cross-tenant inventory UUID tampering",
    "create_draft_invoice blocks owner from wrong tenant branch",
  ];

  for (const name of requiredCases) {
    assert.ok(
      transactionalSuite.includes(name),
      `Missing required workflow authorization case: ${name}`
    );
  }
});
