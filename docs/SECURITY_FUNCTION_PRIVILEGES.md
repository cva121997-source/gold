# Database function execution privileges

## Default privileges

Migration `20261023044854_gold_public_function_default_privileges.sql` is applied to the connected Gold Supabase project and checked against live default-ACL metadata.

Functions created by the project migration role (`postgres`) no longer inherit `EXECUTE` from `PUBLIC`. Newly created functions in the exposed `public` schema also no longer inherit execution grants for `anon`, `authenticated`, or `service_role`. New RPCs must explicitly grant execution to the smallest set of roles that needs it.

## Existing workflow RPCs

Migration `20261023200955_gold_private_workflow_rpc_implementations.sql` moves the 31 audited workflow implementations into the non-API `private` schema. The 33 public names and signatures remain available through `SECURITY INVOKER` wrappers that explicitly grant execution only to `authenticated` and `service_role`, and revoke it from `PUBLIC` and `anon`. The private implementations retain their `SECURITY DEFINER` behavior and in-function authentication plus tenant/branch/role checks.

The two scheme functions already had private implementations; their public wrappers were changed to `SECURITY INVOKER` and the required private grants were added. The migration notifies PostgREST to reload its schema cache.

## Verification

After applying the migration, the live database showed:

- 33 public wrappers, all `SECURITY INVOKER`.
- 33 private workflow implementations, all `SECURITY DEFINER`.
- Zero anonymous execution grants on either set.
- All 33 private implementations retain `auth.uid()` checks and a tenant/branch/role helper.
- The Supabase Security Advisor returned no findings.

Regression tests in `tests/function-default-privileges-regression.test.mjs` and `tests/private-workflow-rpc-regression.test.mjs` protect the default grants and wrapper migration structure. This is not a replacement for authenticated end-to-end tests with separate tenants and branch roles.
