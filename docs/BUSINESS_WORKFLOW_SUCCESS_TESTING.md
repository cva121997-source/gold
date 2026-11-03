# Business workflow success-path testing (Stage 7)

## Scope

The live workflow suite is `tests/sql/business-workflow-success-transactional.test.sql`. It is designed to call the actual public RPC wrappers as PostgreSQL role `authenticated`, using one synthetic owner, one tenant and one branch. It adds no schema objects and grants no access to permanent tables.

The suite covers these successful state transitions:

- **Supplier payables:** create a draft bill and line, post it with generated subtotal/tax/total, record a partial payment, retry the same idempotency key, settle the remaining balance, then reverse both payments and verify that the bill returns to an unpaid `posted` state.
- **Statement reconciliation:** import a statement line that matches a confirmed Razorpay payment, verify the period becomes `matched`, re-import the identical line and verify deduplication, then import an amount-total-matching but unresolved line and verify the period remains `investigating`.
- **Credit notes:** create and issue an invoice, create a credit-note draft from its invoice line, and issue the credit note with a positive calculated total.

## Reconciliation difference-column fix

Stage 7 review found that `reconciliation_records.difference_amount` is a stored generated column defined as `actual_amount - expected_amount`, while the prior private statement-import implementation attempted to assign that generated column in an `UPDATE`. PostgreSQL does not allow a generated column to be assigned directly.

Migration `20261103140500_gold_reconciliation_generated_difference_fix.sql` replaces the private import implementation so it updates `actual_amount` only, lets PostgreSQL derive `difference_amount`, and returns/audits the same `actual_amount - expected_amount` sign. The public RPC name/signature and its existing permissions are preserved.

**The migration is committed but has not been applied to Supabase.** The project is currently `INACTIVE`; the database has not been resumed to avoid unexpected compute usage or billing. The correction is not live-verified until the migration is applied and the SQL success-path suite passes.

## Test execution and safety

Run the entire SQL file in one database session/request. The file begins with `BEGIN`, checks that its synthetic fixture identifiers are unused, creates all Auth and business fixtures inside the transaction, reports each assertion, and ends with `ROLLBACK`. Keep the final `ROLLBACK`; do not run individual sections. PostgreSQL sequences are nontransactional: creating the test credit-note draft consumes one credit-note number even though the credit-note row and audit records roll back, so a harmless number gap may remain.

The JavaScript regression file `tests/business-workflow-success-regression.test.mjs` is included in `npm test`. It verifies the test suite's rollback boundary, synthetic fixture namespace and required success-path assertions. It does not itself connect to PostgreSQL or execute the SQL.

## Live database verification status

**Not yet executed against the connected Supabase database.** On 2026-11-03, the Supabase project metadata reported the project status as `INACTIVE`. Database SQL requests returned `Database is possibly not accessible at the moment`, and listing migration history timed out. No Stage 7 database fixture or schema change was attempted after these connection failures; the project was not restored or restarted. Therefore this document does not claim that the SQL suite passed or that these live workflows have been validated.

When the database connection is available, execute the SQL suite as one request and record the returned assertion count/results here. Then run a separate cleanup query to confirm that the synthetic Auth user, tenant, branch, membership, supplier, bill, payments, reconciliation records/lines, invoice, credit note and audit rows are absent.

## Explicit exclusions

The PO-linked price-variance approval path is not covered by this stage's success-path suite. It needs a complete purchase-order and goods-receipt setup so the supplier bill can be matched against received quantities and independently approved by a different owner/manager. Physical tracked-piece return and financial refund are separate workflows and are also outside this suite.

No paid Supabase branch or development project was created for this work.
