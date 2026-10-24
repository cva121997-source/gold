# RLS and index performance review

## Changes applied

Migration `20261024145929_gold_rls_policy_and_duplicate_index_optimization.sql` was applied to the connected Gold Supabase project and added to the repository.

- Updated `customer_notes_staff_insert` and `customer_interactions_staff_insert` to use `(select auth.uid())`, avoiding per-row repeated evaluation in the policy expressions without changing the creator check or branch/role check.
- Consolidated overlapping SELECT predicates on 13 tables into one permissive SELECT policy per table. The original SELECT and ALL policy predicates are preserved as an OR for reads.
- Split the prior ALL policies into separate INSERT, UPDATE, and DELETE policies using the original USING and WITH CHECK predicates, so consolidating reads does not grant the broader read audience additional write access.
- Removed three standalone indexes that were byte-for-byte/definition-identical to constraint-backed unique indexes: `inventory_items_tenant_id_unique_idx`, `inventory_items_tenant_item_code_uidx`, and `suppliers_tenant_id_unique_idx`.

## Live advisor result after the migration

- `auth_rls_initplan`: no longer reported.
- `multiple_permissive_policies`: no longer reported for the 13 reviewed table/action pairs.
- `duplicate_index`: decreased from 5 findings to 2.
- `unindexed_foreign_keys`: 44 INFO findings remain.
- `unused_index`: 180 INFO findings remain.

The two remaining duplicate-index findings involve duplicate UNIQUE constraints, not standalone indexes. They were not dropped in this stage because constraint names and foreign-key dependencies can be relied on by schema operations or application SQL. Review those constraint definitions and dependencies before removing either one.

Unused-index advisories are not enough, by themselves, to prove an index is unnecessary: this database may not yet have received production-like traffic. Keep these indexes until query/workload history and the affected migration/code references have been reviewed. Likewise, unindexed foreign-key findings should be prioritized using query patterns, table growth, and write overhead rather than adding dozens of indexes indiscriminately.

The regression test `tests/rls-performance-regression.test.mjs` checks the policy target list, auth init-plan expression, split-policy migration structure, and the three standalone index removals.
