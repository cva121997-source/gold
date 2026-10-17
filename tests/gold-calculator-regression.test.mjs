import test from "node:test";
import assert from "node:assert/strict";
import { calculateJewelleryQuote } from "../lib/gold-calculation.js";

const base = {
  rate: "13535",
  weight: "10",
  makingMode: "percent",
  makingInput: "12",
  wastagePercent: "0",
  otherCharges: "0",
  discount: "0",
  gstEnabled: true,
  gstPercent: "3",
  budget: "156140",
};

test("22K screenshot regression matches gold, making, GST and total", () => {
  const quote = calculateJewelleryQuote(base);
  assert.equal(quote.goldValue, 135350);
  assert.equal(quote.making, 16242);
  assert.equal(quote.taxableSubtotal, 151592);
  assert.equal(quote.gst, 4548);
  assert.equal(quote.total, 156140);
});

test("budget inverse uses the same percentage, GST and charge formula", () => {
  const quote = calculateJewelleryQuote(base);
  assert.ok(Math.abs(quote.budgetGrams - 10) < 0.002, `expected about 10g, got ${quote.budgetGrams}`);
});

test("budget inverse handles fixed making charges and fixed discounts", () => {
  const fixed = { ...base, makingMode: "fixed", makingInput: "2000", otherCharges: "500", discount: "250", budget: "150000" };
  const quote = calculateJewelleryQuote(fixed);
  assert.ok(Number.isFinite(quote.budgetGrams));
  assert.ok(quote.budgetGrams > 0);
  const roundTrip = calculateJewelleryQuote({ ...fixed, weight: String(quote.budgetGrams), budget: "0" });
  assert.ok(roundTrip.total <= 150001);
});

test("per-gram making charges work and disabling GST leaves tax at zero", () => {
  const quote = calculateJewelleryQuote({ ...base, makingMode: "perGram", makingInput: "150", gstEnabled: false });
  assert.equal(quote.making, 1500);
  assert.equal(quote.gst, 0);
  assert.equal(quote.total, 136850);
});

test("invalid and zero rates fail closed for the inverse estimate", () => {
  const quote = calculateJewelleryQuote({ ...base, rate: "not-a-number", weight: "-5" });
  assert.equal(quote.goldValue, 0);
  assert.equal(quote.budgetGrams, 0);
  assert.ok(Number.isFinite(quote.total));
});
