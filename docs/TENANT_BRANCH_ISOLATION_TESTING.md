# Tenant and branch isolation regression tests

## What is covered

`tests/tenant-branch-isolation-staging.test.mjs` uses real Supabase Auth sessions with the public/anon key and the PostgREST API. It deliberately does not use a service-role key.

- A tenant owner cannot fetch another tenant, branch, product, inventory item, or sale by supplying its UUID directly.
- A branch-assigned staff member can read records in their assigned branch but cannot read sibling-branch or other-tenant records by UUID.
- When explicitly enabled, tests attempt a cross-tenant inventory update, a sibling-branch sale update, and a branch reassignment. The last case specifically exercises the UPDATE policy's `WITH CHECK` boundary.

These are opt-in integration tests, so ordinary CI does not need staging credentials. With no staging configuration they are skipped; the normal unit-test, lint, type-check, and build checks still run.

## Required isolated fixture data

Create a **disposable, non-production Supabase project** with the current Gold schema and three test accounts:

- `tenantAOwner`: active owner membership in tenant A.
- `tenantBOwner`: active owner membership in tenant B.
- `branchAStaff`: a non-manager staff account assigned only to branch A1 in tenant A. Use a role that can read and update its own branch's sales (for example, `cashier`).

Create two tenants, branches A1 and A2 under tenant A, branch B1 under tenant B, one product per tenant, and one inventory item and one draft sale in each of branches A1, A2, and B1. The branch A1 staff account must not have a second membership granting wider access. Use only synthetic data created for these tests. Set the sale in A1 and A2 to `draft`; write tests may touch `updated_at` if an unexpected policy allows an update.

The JSON below is the exact shape for the `GOLD_TENANT_ISOLATION_STAGING_CONFIG` environment variable. Supply the actual staging URL, anon/publishable key, account credentials, and fixture UUIDs; do not commit the config or put passwords in source control.

```json
{
  "projectRef": "your-staging-project-ref",
  "supabaseUrl": "https://your-staging-project-ref.supabase.co",
  "anonKey": "your-staging-anon-or-publishable-key",
  "users": {
    "tenantAOwner": { "email": "owner-a@example.invalid", "password": "staging-only-password" },
    "tenantBOwner": { "email": "owner-b@example.invalid", "password": "staging-only-password" },
    "branchAStaff": { "email": "branch-a-staff@example.invalid", "password": "staging-only-password" }
  },
  "ids": {
    "tenants": { "a": "00000000-0000-4000-8000-000000000001", "b": "00000000-0000-4000-8000-000000000002" },
    "branches": {
      "a1": "00000000-0000-4000-8000-000000000011",
      "a2": "00000000-0000-4000-8000-000000000012",
      "b1": "00000000-0000-4000-8000-000000000021"
    },
    "products": { "a": "00000000-0000-4000-8000-000000000031", "b": "00000000-0000-4000-8000-000000000032" },
    "inventoryItems": {
      "aBranch1": "00000000-0000-4000-8000-000000000041",
      "aBranch2": "00000000-0000-4000-8000-000000000042",
      "bBranch1": "00000000-0000-4000-8000-000000000043"
    },
    "sales": {
      "aBranch1": "00000000-0000-4000-8000-000000000051",
      "aBranch2": "00000000-0000-4000-8000-000000000052",
      "bBranch1": "00000000-0000-4000-8000-000000000053"
    }
  }
}
```

The UUIDs above are **shape examples only**, not a data seed. Replace every example with the real UUIDs of the disposable staging fixtures.

## Running the tests

Set the JSON above as `GOLD_TENANT_ISOLATION_STAGING_CONFIG`, then run:

```bash
npm test
```

Read-only tenant and branch checks run when the config is present. The project guard verifies that the URL hostname matches `projectRef` and blocks the known production project reference.

The write-denial tests are separately gated. Only in the disposable staging environment, explicitly set:

```bash
GOLD_TENANT_ISOLATION_ENABLE_WRITES=I_ACKNOWLEDGE_DISPOSABLE_STAGING_DATA
```

Then run `npm test` again. Do not set that flag against production or a shared environment. No service-role key is used by these tests.

## Current live baseline

The connected Gold project was checked without writing data:

- Row-level security was enabled on all 77 public base tables returned by the catalog audit.
- All 29 authenticated UPDATE/ALL policy entries had explicit `WITH CHECK` expressions.
- The only three anon/public policies were SELECT-only policies for the shared `metals`, `purity_definitions`, and `subscription_plans` catalogs.
- A read-only authenticated-role probe using a synthetic, unassigned user UUID saw zero tenants, memberships, branches, and inventory items.
- The connected project currently has zero tenant rows, zero branches, zero active memberships, zero inventory items, and zero sales.

Because the connected project has no tenant fixtures, a representative cross-tenant/branch behavior test cannot be completed against it without introducing test data. This stage does not seed or mutate that project. Run the opt-in suite in the disposable staging project before treating live cross-tenant write isolation as fully verified.
