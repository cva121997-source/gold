begin;

-- Revoke PostgreSQL's default EXECUTE grant to PUBLIC for functions created
-- by the project migration role. Existing function ACLs are not changed.
alter default privileges for role postgres
  revoke execute on functions from public;

-- The exposed public schema also grants new functions to Supabase API roles
-- by default. Require explicit per-function grants for every exposed RPC.
alter default privileges for role postgres in schema public
  revoke execute on functions from anon, authenticated, service_role;

commit;
