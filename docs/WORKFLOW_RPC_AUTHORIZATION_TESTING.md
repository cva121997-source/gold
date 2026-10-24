# Workflow RPC tenant and branch authorization testing

## What was reviewed

The live database contains the 33 workflow RPC implementations moved to `private` in migration `20261023200955_gold_private_workflow_rpc_implementations.sql`. A catalog/source audit found all 33 implementations use `auth.uid()` and at least one tenant-, branch-, or role-membership guard. This code review complements, but does not replace, real calls as different authenticated users.

The rollback-only suite is `tests/sql/workflow-rpc-authorization-transactional.test.sql`. It calls the actual public RPC wrappers while the session runs as PostgreSQL role `authenticated`, changing only the synthetic JWT subject between test owner/cashier identities.

## Live test result

**26 of 26 database assertions passed.** The suite covered:

- Positive control: a tenant owner can create a stock transfer between branches belonging to that tenant.
- Cross-tenant target IDs: add, cancel, submit, review, dispatch, and receive stock-transfer calls are denied to a user who belongs to another tenant.
- Cross-tenant branch selection: creating a transfer with a destination branch from another tenant is rejected.
- Role boundaries: a cashier cannot create a stock transfer, start or mark a stocktake, revalue inventory, or record consent at a sibling branch.
- Tenant-scoped financial and scheme workflows: wrong-tenant calls to refund request/review/gateway/manual refund, provider-rate review, scheme lifecycle/draft editing, and draft credit-note workflows are rejected.
- Identifier tampering: an invoice workflow cannot treat a different tenant's inventory UUID as stock belonging to the caller's tenant.

The suite reports the actual error message for each rejected operation, so an error caused by the wrong validation layer does not count as success. The entire test is wrapped in one transaction and ends with `ROLLBACK`.

## Stock-transfer status constraint correction

During the review, two validated CHECK constraints were found on `public.stock_transfers`. The older `stock_transfers_status_check` allowed only `draft`, `dispatched`, `received`, and `cancelled`. The later `stock_transfers_status_workflow_check` correctly also allowed `pending_approval`, `approved`, `in_transit`, and `rejected`. Because PostgreSQL applies both constraints, the older check blocked workflow states required by the RPCs.

Migration `20261024155033_gold_stock_transfer_workflow_status_constraint_fix.sql` removes only the obsolete restrictive check and retains the validated workflow check. The rollback-only test successfully inserted fixtures using `draft`, `pending_approval`, `approved`, and `in_transit` after the correction.

## Cleanup and scope notes

A follow-up catalog query found zero remaining workflow-test Auth users, tenants, branches, memberships, stock transfers, stocktakes, or valuation-history rows. No non-test permissions were granted, no paid development branch was created, and no client business records were retained.

This is a representative database-backed authorization suite, not a full business-state end-to-end test for every one of the 33 RPCs. Supplier bill/payment, reconciliation, and several refund/credit-note transitions need their complete valid business preconditions to exercise success paths. Those implementations were included in the 33-function source audit, but those success paths are not claimed as tested by this suite.

## Running it again

Run the complete SQL file in one session/request:

```text
tests/sql/workflow-rpc-authorization-transactional.test.sql
```

Keep its final `ROLLBACK`. The JavaScript regression tests check the status-fix migration and safety properties of the SQL suite during `npm test`; they do not execute the SQL against a database.
