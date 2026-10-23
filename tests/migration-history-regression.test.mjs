import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const migrationDirectory = join(process.cwd(), "supabase/migrations");
const filenames = readdirSync(migrationDirectory)
  .filter(name => name.endsWith(".sql"))
  .sort();

test("Supabase migration filenames have unique 14-digit ordered versions", () => {
  const versions = filenames.map(name => {
    const match = name.match(/^(\d{14})_[a-z0-9_]+\.sql$/);
    assert.ok(match, `invalid migration filename: ${name}`);
    return match[1];
  });
  assert.equal(new Set(versions).size, versions.length, "migration version prefixes must be unique");
  assert.deepEqual(versions, [...versions].sort(), "migration files must sort in execution order");
});

test("the repository includes source for the applied branch-scope and single-piece-return migrations", () => {
  assert.ok(filenames.includes("20261017082305_gold_security_branch_scopes.sql"));
  assert.ok(filenames.includes("20261021071508_gold_credit_note_single_piece_return.sql"));
  const singlePiece = readFileSync(join(migrationDirectory, "20261021071508_gold_credit_note_single_piece_return.sql"), "utf8");
  assert.match(singlePiece, /v_note_line\.quantity<>1/i);
});
