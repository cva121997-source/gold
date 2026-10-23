# Database function execution privileges

## Migration

`20261023044854_gold_public_function_default_privileges.sql` is applied to the connected Gold Supabase project and checked against live default-ACL metadata.

It changes defaults for functions created by the project migration role (`postgres`):

- Revokes the implicit `EXECUTE` grant from `PUBLIC`.
- In the exposed `public` schema, removes the default `EXECUTE` grants to `anon`, `authenticated`, and `service_role`.

It affects newly created functions only. Existing function definitions and grants are deliberately unchanged. New RPCs must explicitly grant execution to the smallest set of roles that need them.

## Remaining review work

The live Supabase Security Advisor still reports 33 `authenticated_security_definer_function_executable` findings on existing authenticated workflow RPCs. This migration does not mark those functions as cleared. Keep reviewing each RPC's body, tenant/branch/role checks, and ACL; avoid blanket revokes that would break legitimate shop workflows or blanket grants that expose internal operations.

The migration test `tests/function-default-privileges-regression.test.mjs` protects the intended future default-grant behavior.
