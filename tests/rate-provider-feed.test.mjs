import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";

const source = readFileSync(join(process.cwd(), "lib/rates/provider-feed.ts"), "utf8");
const javascript = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 }
}).outputText;
const ratesModule = await import("data:text/javascript;base64," + Buffer.from(javascript).toString("base64"));

const row = (override = {}) => ({
  state: "Tamil Nadu", district: null, city: null, locality: null,
  metal_code: "gold", purity_code: "22K", price_per_gram: 6200,
  effective_at: "2026-10-17T03:00:00Z", expires_at: "2026-10-18T03:00:00Z",
  source_label: "approved test feed", ...override
});

test("provider feed validator rejects zero, impossible and timestamp-without-zone rates", () => {
  assert.equal(ratesModule.validateProviderRate(row({ price_per_gram: 0 })), null);
  assert.equal(ratesModule.validateProviderRate(row({ price_per_gram: -100 })), null);
  assert.equal(ratesModule.validateProviderRate(row({ price_per_gram: 20_000_000 })), null);
  assert.equal(ratesModule.validateProviderRate(row({ effective_at: "2026-10-17T03:00:00" })), null);
  assert.equal(ratesModule.validateProviderRate(row({ expires_at: "2026-10-16T03:00:00Z" })), null);
});

test("location matching chooses the most specific compatible provider locality", () => {
  const broad = ratesModule.validateProviderRate(row());
  const city = ratesModule.validateProviderRate(row({ district: "Krishnagiri", city: "Hosur", price_per_gram: 6300 }));
  assert.ok(broad && city);
  const result = ratesModule.chooseLocationRate([broad, city], {
    state: "Tamil Nadu", district: "Krishnagiri", city: "Hosur", locality: "Bus Stand"
  });
  assert.equal(result.price_per_gram, 6300);
});

test("ambiguous equally-specific provider rates fail closed", () => {
  const one = ratesModule.validateProviderRate(row({ district: "Krishnagiri", city: "Hosur", price_per_gram: 6300 }));
  const two = ratesModule.validateProviderRate(row({ district: "Krishnagiri", city: "Hosur", price_per_gram: 6320 }));
  assert.ok(one && two);
  assert.equal(ratesModule.chooseLocationRate([one, two], {
    state: "Tamil Nadu", district: "Krishnagiri", city: "Hosur", locality: null
  }), null);
});
