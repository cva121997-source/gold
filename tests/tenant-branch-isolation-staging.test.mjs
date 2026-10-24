import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";

const configJson = process.env.GOLD_TENANT_ISOLATION_STAGING_CONFIG;
const integrationEnabled = Boolean(configJson);
const knownProductionProjectRefs = new Set(["oidfkbshfywexmvsrkkd"]);
const writeConfirmation = "I_ACKNOWLEDGE_DISPOSABLE_STAGING_DATA";
const writesEnabled = writeGateIsOpen(
  integrationEnabled,
  process.env.GOLD_TENANT_ISOLATION_ENABLE_WRITES
);
const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function writeGateIsOpen(configured, confirmation) {
  return Boolean(configured) && confirmation === writeConfirmation;
}

function assertSafeStagingProject(projectRef, supabaseUrl) {
  assert.equal(typeof projectRef, "string", "projectRef is required.");
  assert.equal(typeof supabaseUrl, "string", "supabaseUrl is required.");

  const url = new URL(supabaseUrl);
  assert.equal(url.protocol, "https:", "Use an HTTPS staging Supabase URL.");
  assert.equal(
    url.hostname.split(".")[0],
    projectRef,
    "projectRef must match the Supabase URL host."
  );
  assert.ok(
    !knownProductionProjectRefs.has(projectRef),
    "Tenant isolation integration tests are blocked against the known production project."
  );
}

function loadConfig() {
  assert.ok(
    configJson,
    "Set GOLD_TENANT_ISOLATION_STAGING_CONFIG to run staging integration tests."
  );

  let config;
  try {
    config = JSON.parse(configJson);
  } catch (error) {
    throw new Error(
      "GOLD_TENANT_ISOLATION_STAGING_CONFIG must be valid JSON.",
      { cause: error }
    );
  }

  assert.equal(typeof config.anonKey, "string", "anonKey is required.");
  assert.ok(config.users, "users fixture map is required.");
  assert.ok(config.ids, "ids fixture map is required.");

  assertSafeStagingProject(config.projectRef, config.supabaseUrl);

  for (const userName of ["tenantAOwner", "tenantBOwner", "branchAStaff"]) {
    const user = config.users[userName];
    assert.ok(user, `Missing users.${userName} staging fixture.`);
    assert.equal(typeof user.email, "string", `Missing ${userName}.email.`);
    assert.equal(
      typeof user.password,
      "string",
      `Missing ${userName}.password.`
    );
  }

  const requiredIds = [
    ["tenants", "a"],
    ["tenants", "b"],
    ["branches", "a1"],
    ["branches", "a2"],
    ["branches", "a3"],
    ["branches", "b1"],
    ["products", "a"],
    ["products", "b"],
    ["inventoryItems", "aBranch1"],
    ["inventoryItems", "aBranch2"],
    ["inventoryItems", "bBranch1"],
    ["sales", "aBranch1"],
    ["sales", "aBranch2"],
    ["sales", "bBranch1"],
  ];

  for (const [group, key] of requiredIds) {
    const id = config.ids[group]?.[key];
    assert.equal(typeof id, "string", `Missing ids.${group}.${key}.`);
    assert.match(id, uuidPattern, `ids.${group}.${key} must be a UUID.`);
  }

  assert.notEqual(config.ids.tenants.a, config.ids.tenants.b);
  assert.notEqual(config.ids.branches.a1, config.ids.branches.a2);
  assert.notEqual(config.ids.branches.a1, config.ids.branches.a3);
  assert.notEqual(config.ids.branches.a1, config.ids.branches.b1);
  assert.notEqual(config.ids.products.a, config.ids.products.b);
  assert.notEqual(
    config.ids.inventoryItems.aBranch1,
    config.ids.inventoryItems.aBranch2
  );
  assert.notEqual(
    config.ids.inventoryItems.aBranch1,
    config.ids.inventoryItems.bBranch1
  );

  return config;
}

function createStagingClient(config) {
  return createClient(config.supabaseUrl, config.anonKey, {
    auth: {
      autoRefreshToken: false,
      detectSessionInUrl: false,
      persistSession: false,
    },
  });
}

async function signIn(config, userName) {
  const client = createStagingClient(config);
  const { error } = await client.auth.signInWithPassword(config.users[userName]);
  assert.ifError(error, `Could not sign in staging fixture ${userName}.`);
  return client;
}

async function expectVisible(client, table, id, description, columns = "id") {
  const { data, error } = await client.from(table).select(columns).eq("id", id);
  assert.ifError(error, `Unable to query ${description}.`);
  assert.equal(data.length, 1, `${description} should be visible.`);
  return data[0];
}

async function expectHidden(client, table, id, description) {
  const { data, error } = await client.from(table).select("id").eq("id", id);
  assert.ifError(error, `Unable to query ${description}.`);
  assert.equal(
    data.length,
    0,
    `${description} must be hidden by tenant/branch isolation.`
  );
}

test("staging project guard blocks the known production project", () => {
  assert.throws(
    () =>
      assertSafeStagingProject(
        "oidfkbshfywexmvsrkkd",
        "https://oidfkbshfywexmvsrkkd.supabase.co"
      ),
    /blocked against the known production project/
  );
});

test("staging project guard rejects a URL/project-ref mismatch", () => {
  assert.throws(
    () =>
      assertSafeStagingProject(
        "different-staging-ref",
        "https://oidfkbshfywexmvsrkkd.supabase.co"
      ),
    /projectRef must match the Supabase URL host/
  );
});

test("write tests require explicit disposable-staging confirmation", () => {
  assert.equal(writeGateIsOpen(false, writeConfirmation), false);
  assert.equal(writeGateIsOpen(true, "yes"), false);
  assert.equal(writeGateIsOpen(true, writeConfirmation), true);
});

test(
  "tenant owners cannot read another tenant by direct ID",
  { skip: !integrationEnabled },
  async () => {
    const config = loadConfig();
    const ownerA = await signIn(config, "tenantAOwner");
    const ownerB = await signIn(config, "tenantBOwner");
    const ids = config.ids;

    for (const [table, id, label] of [
      ["tenants", ids.tenants.a, "tenant A"],
      ["branches", ids.branches.a1, "tenant A branch"],
      ["products", ids.products.a, "tenant A product"],
      ["inventory_items", ids.inventoryItems.aBranch1, "tenant A inventory item"],
      ["sales", ids.sales.aBranch1, "tenant A sale"],
    ]) {
      await expectVisible(ownerA, table, id, label);
    }

    for (const [table, id, label] of [
      ["tenants", ids.tenants.b, "tenant B"],
      ["branches", ids.branches.b1, "tenant B branch"],
      ["products", ids.products.b, "tenant B product"],
      ["inventory_items", ids.inventoryItems.bBranch1, "tenant B inventory item"],
      ["sales", ids.sales.bBranch1, "tenant B sale"],
    ]) {
      await expectVisible(ownerB, table, id, label);
    }

    for (const [table, id, label] of [
      ["tenants", ids.tenants.b, "tenant B"],
      ["branches", ids.branches.b1, "tenant B branch"],
      ["products", ids.products.b, "tenant B product"],
      ["inventory_items", ids.inventoryItems.bBranch1, "tenant B inventory item"],
      ["sales", ids.sales.bBranch1, "tenant B sale"],
    ]) {
      await expectHidden(ownerA, table, id, label);
    }

    for (const [table, id, label] of [
      ["tenants", ids.tenants.a, "tenant A"],
      ["branches", ids.branches.a1, "tenant A branch"],
      ["products", ids.products.a, "tenant A product"],
      ["inventory_items", ids.inventoryItems.aBranch1, "tenant A inventory item"],
      ["sales", ids.sales.aBranch1, "tenant A sale"],
    ]) {
      await expectHidden(ownerB, table, id, label);
    }
  }
);

test(
  "branch-assigned staff cannot read sibling-branch or cross-tenant records",
  { skip: !integrationEnabled },
  async () => {
    const config = loadConfig();
    const staffA = await signIn(config, "branchAStaff");
    const ids = config.ids;

    await expectVisible(staffA, "branches", ids.branches.a1, "assigned branch A1");
    await expectVisible(
      staffA,
      "products",
      ids.products.a,
      "tenant A product shared at tenant scope"
    );
    await expectVisible(
      staffA,
      "inventory_items",
      ids.inventoryItems.aBranch1,
      "inventory item in assigned branch A1"
    );
    await expectVisible(staffA, "sales", ids.sales.aBranch1, "sale in assigned branch A1");

    for (const [table, id, label] of [
      ["branches", ids.branches.a2, "sibling branch A2"],
      ["branches", ids.branches.b1, "tenant B branch"],
      ["products", ids.products.b, "tenant B product"],
      ["inventory_items", ids.inventoryItems.aBranch2, "inventory item in sibling branch A2"],
      ["inventory_items", ids.inventoryItems.bBranch1, "tenant B inventory item"],
      ["sales", ids.sales.aBranch2, "sale in sibling branch A2"],
      ["sales", ids.sales.bBranch1, "tenant B sale"],
    ]) {
      await expectHidden(staffA, table, id, label);
    }
  }
);

test(
  "cross-tenant and branch identifier tampering writes are rejected",
  {
    skip:
      !integrationEnabled ||
      !writesEnabled,
  },
  async () => {
    const config = loadConfig();
    const ownerA = await signIn(config, "tenantAOwner");
    const staffA = await signIn(config, "branchAStaff");
    const ids = config.ids;

    // Branch A3 is a fixture branch with no child rows. This allows the test
    // to check tenant_id WITH CHECK without a dependent composite FK masking it.
    const { data: branchTampering, error: branchTamperingError } =
      await ownerA
        .from("branches")
        .update({ tenant_id: ids.tenants.b })
        .eq("id", ids.branches.a3)
        .select("id, tenant_id");

    assert.ok(
      branchTamperingError || (branchTampering ?? []).length === 0,
      "Tenant A owner must not reassign branch A3 to tenant B."
    );

    const branchAfterAttempt = await expectVisible(
      ownerA,
      "branches",
      ids.branches.a3,
      "branch A3 after rejected tenant reassignment",
      "id, tenant_id"
    );
    assert.equal(
      branchAfterAttempt.tenant_id,
      ids.tenants.a,
      "A rejected tenant reassignment must leave branch A3 under tenant A."
    );

    const ownBranch = await expectVisible(
      staffA,
      "branches",
      ids.branches.a1,
      "assigned branch A1",
      "id, name"
    );
    const { data: branchStaffUpdate, error: branchStaffUpdateError } =
      await staffA
        .from("branches")
        .update({ name: ownBranch.name })
        .eq("id", ids.branches.a1)
        .select("id");

    assert.ok(
      branchStaffUpdateError || (branchStaffUpdate ?? []).length === 0,
      "Cashier staff must not update branch administration fields directly."
    );

    const quotePayload = (tenantId, branchId, quoteCode) => ({
      tenant_id: tenantId,
      branch_id: branchId,
      quote_code: quoteCode,
      gold_rate_snapshot: 0,
      weight_grams: 0,
      gold_value: 0,
      making_charge_mode: "fixed",
      taxable_subtotal: 0,
      total_amount: 0,
    });

    const siblingQuoteAttempt = await staffA
      .from("calculator_quotes")
      .insert(
        quotePayload(
          ids.tenants.a,
          ids.branches.a2,
          `ISO-SIBLING-${randomUUID()}`
        )
      )
      .select("id");

    assert.ok(
      siblingQuoteAttempt.error,
      "Branch A1 staff must not insert a calculator quote into sibling branch A2."
    );

    const crossTenantQuoteAttempt = await ownerA
      .from("calculator_quotes")
      .insert(
        quotePayload(
          ids.tenants.b,
          ids.branches.b1,
          `ISO-CROSS-TENANT-${randomUUID()}`
        )
      )
      .select("id");

    assert.ok(
      crossTenantQuoteAttempt.error,
      "Tenant A owner must not insert a calculator quote into tenant B."
    );
  }
);
