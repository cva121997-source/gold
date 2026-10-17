/**
 * Shared jewellery quotation formula. Financial values are computed with decimal
 * inputs and rounded only where the displayed invoice estimate requires it.
 * This module intentionally has no browser or database dependencies so the core
 * calculation can be exercised by Node's test runner and reused by the UI.
 */

/** @param {unknown} value */
function nonNegative(value) {
  const n = typeof value === "number" || typeof value === "string" ? Number(value) : 0;
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

/**
 * @param {{
 *  rate: unknown, weight: unknown, makingMode: "percent"|"fixed"|"perGram",
 *  makingInput: unknown, wastagePercent: unknown, otherCharges: unknown,
 *  discount: unknown, gstEnabled: boolean, gstPercent: unknown, budget: unknown
 * }} input
 */
export function calculateJewelleryQuote(input) {
  const rate = nonNegative(input.rate);
  const grams = nonNegative(input.weight);
  const makingInput = nonNegative(input.makingInput);
  const wastagePercent = nonNegative(input.wastagePercent);
  const other = nonNegative(input.otherCharges);
  const discountInput = nonNegative(input.discount);
  const gstPercent = nonNegative(input.gstPercent);

  const goldValue = rate * grams;
  const making = input.makingMode === "percent"
    ? goldValue * makingInput / 100
    : input.makingMode === "perGram"
      ? makingInput * grams
      : makingInput;
  const wastage = goldValue * wastagePercent / 100;
  const discount = Math.min(discountInput, goldValue + making + wastage + other);
  const taxableSubtotal = Math.max(0, goldValue + making + wastage + other - discount);
  const gst = input.gstEnabled ? Math.round(taxableSubtotal * gstPercent / 100) : 0;
  const total = Math.round((taxableSubtotal + gst) * 100) / 100;

  // Invert the exact same forward formula; fixed charges and discounts are included.
  const targetBudget = nonNegative(input.budget);
  const costForWeight = (weight) => {
    const itemGold = rate * weight;
    const itemMaking = input.makingMode === "percent"
      ? itemGold * makingInput / 100
      : input.makingMode === "perGram"
        ? makingInput * weight
        : makingInput;
    const itemWastage = itemGold * wastagePercent / 100;
    const rawSubtotal = itemGold + itemMaking + itemWastage + other;
    const appliedDiscount = Math.min(discountInput, rawSubtotal);
    const subtotal = Math.max(0, rawSubtotal - appliedDiscount);
    const tax = input.gstEnabled ? Math.round(subtotal * gstPercent / 100) : 0;
    return subtotal + tax;
  };

  let low = 0;
  let high = Math.max((targetBudget / Math.max(rate, 1)) * 2 + 1, 1);
  for (let i = 0; i < 80; i += 1) {
    const middle = (low + high) / 2;
    if (costForWeight(middle) <= targetBudget) low = middle;
    else high = middle;
  }
  const budgetGrams = targetBudget > 0 && rate > 0 ? low : 0;

  return { goldValue, making, wastage, other, discount, taxableSubtotal, gst, total, budgetGrams };
}
