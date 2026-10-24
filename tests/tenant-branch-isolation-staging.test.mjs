import test from "node:test";
import assert from "node:assert/strict";
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

    await expectVisible(ownerA, "tenants", ids.tenants.a, "tenant A");
    await expectVisible(ownerB, "tenants", ids.tenants.b, "tenant B");

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
  "cross-tenant and cross-branch writes are rejected",
  {
    skip:
      !integrationEnabled ||
      !writesEnabled,
  },
  async () => {
    const config = loadConfig();
    const ownerA = await signIn(config, "tenantAOwner");
    const ownerB = await signIn(config, "tenantBOwner");
    const staffA = await signIn(config, "branchAStaff");
    const ids = config.ids;

    // The staging fixture's location_label is reused so a wrongly-permitted
    // update does not change business fields. A test trigger may still update
    // updated_at, which is why this suite must only use disposable staging data.
    const targetItem = await expectVisible(
      ownerB,
      "inventory_items",
      ids.inventoryItems.bBranch1,
      "tenant B item",
      "id, location_label"
    );
    const { data: crossTenantUpdate, error: crossTenantUpdateError } =
      await ownerA
        .from("inventory_items")
        .update({ location_label: targetItem.location_label })
        .eq("id", ids.inventoryItems.bBranch1)
        .select("id");

    assert.ifError(crossTenantUpdateError);
    assert.equal(
      crossTenantUpdate.length,
      0,
      "Tenant A owner must not update tenant B inventory by guessing its ID."
    );

    const { data: crossBranchUpdate, error: crossBranchUpdateError } =
      await staffA
        .from("sales")
        .update({ status: "draft" })
        .eq("id", ids.sales.aBranch2)
        .select("id");

    assert.ok(
      crossBranchUpdateError || crossBranchUpdate.length === 0,
      "Branch A staff must not update a sale from sibling branch A2."
    );

    const ownSaleBefore = await expectVisible(
      staffA,
      "sales",
      ids.sales.aBranch1,
      "sale in assigned branch A1",
      "id, branch_id"
    );
    assert.equal(
      ownSaleBefore.branch_id,
      ids.branches.a1,
      "The branch write fixture must initially belong to assigned branch A1."
    );

    const { data: branchTamperingUpdate, error: branchTamperingError } =
      await staffA
        .from("sales")
        .update({ branch_id: ids.branches.a2 })
        .eq("id", ids.sales.aBranch1)
        .select("id, branch_id");

    assert.ok(
      branchTamperingError || branchTamperingUpdate.length === 0,
      "Branch A staff must not reassign an authorized sale to sibling branch A2."
    );

    const ownSaleAfter = await expectVisible(
      staffA,
      "sales",
      ids.sales.aBranch1,
      "sale after rejected branch reassignment",
      "id, branch_id"
    );
    assert.equal(
      ownSaleAfter.branch_id,
      ids.branches.a1,
      "A rejected branch reassignment must leave the fixture in branch A1."
    );
  }
);
