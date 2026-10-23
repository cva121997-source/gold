import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const migrationPath = join(
  process.cwd(),
  "supabase/migrations/20261023044854_gold_public_function_default_privileges.sql"
);

test("new public functions require explicit execution grants", () => {
  const migration = readFileSync(migrationPath, "utf8");

  assert.match(
    migration,
    /alter default privileges for role postgres\s+revoke execute on functions from public/i,
    "new functions must not inherit EXECUTE from PUBLIC"
  );
  assert.match(
    migration,
    /alter default privileges for role postgres in schema public\s+revoke execute on functions from anon,\s*authenticated,\s*service_role/i,
    "new exposed-schema functions must require explicit grants for API roles"
  );
});
