"use client";
import { useMemo, useState } from "react";
import { Info, RotateCcw } from "lucide-react";
import { calculateJewelleryQuote } from "@/lib/gold-calculation.js";

type MakingMode = "percent" | "fixed" | "perGram";
const inr = (amount: number) => new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 2 }).format(Number.isFinite(amount) ? amount : 0);
const parsePositive = (value: string) => { const n = Number(value); return Number.isFinite(n) && n >= 0 ? n : 0; };

export default function GoldCalculator() {
  const [purity, setPurity] = useState("22K · 916");
  const [rate, setRate] = useState("13535");
  const [weight, setWeight] = useState("10");
  const [makingMode, setMakingMode] = useState<MakingMode>("percent");
  const [makingInput, setMakingInput] = useState("12");
  const [wastagePercent, setWastagePercent] = useState("0");
  const [otherCharges, setOtherCharges] = useState("0");
  const [discount, setDiscount] = useState("0");
  const [gstEnabled, setGstEnabled] = useState(true);
  const [gstPercent, setGstPercent] = useState("3");
  const [budget, setBudget] = useState("156140");

  const values = useMemo(() => calculateJewelleryQuote({
    rate, weight, makingMode, makingInput, wastagePercent, otherCharges, discount, gstEnabled, gstPercent, budget
  }), [rate, weight, makingMode, makingInput, wastagePercent, otherCharges, discount, gstEnabled, gstPercent, budget]);

  function reset() {
    setPurity("22K · 916"); setRate("13535"); setWeight("10"); setMakingMode("percent"); setMakingInput("12");
    setWastagePercent("0"); setOtherCharges("0"); setDiscount("0"); setGstEnabled(true); setGstPercent("3"); setBudget("156140");
  }

  return <div className="calc-layout">
    <section className="panel">
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, marginBottom: 20 }}>
        <div><h2>Item details</h2><p className="small muted" style={{ marginBottom: 0 }}>All amounts are estimates in Indian rupees.</p></div>
        <button className="btn btn-secondary" type="button" onClick={reset}><RotateCcw size={14} /> Reset</button>
      </div>
      <div className="notice" style={{ marginBottom: 20 }}><Info size={16} style={{ flexShrink: 0, marginTop: 1 }} /><span>Regression example, not a current market quote. Confirm the local rate and applicable tax treatment before using these figures for a sale.</span></div>
      <div className="form-grid">
        <div className="field"><label htmlFor="purity">Gold purity</label><select id="purity" value={purity} onChange={(e) => { const next = e.target.value; setPurity(next); if (next === "24K · 999") setRate("14712"); else if (next === "22K · 916") setRate("13535"); else setRate("11034"); }}><option>24K · 999</option><option>22K · 916</option><option>18K · 750</option></select></div>
        <div className="field"><label htmlFor="rate">Rate per gram (₹)</label><input id="rate" type="number" min="0" step="0.01" value={rate} onChange={(e) => setRate(e.target.value)} /></div>
        <div className="field"><label htmlFor="weight">Net gold weight (grams)</label><input id="weight" type="number" min="0" step="0.001" value={weight} onChange={(e) => setWeight(e.target.value)} /></div>
        <div className="field"><label htmlFor="makingMode">Making charge method</label><select id="makingMode" value={makingMode} onChange={(e) => setMakingMode(e.target.value as MakingMode)}><option value="percent">Percentage of gold value</option><option value="fixed">Fixed amount per item</option><option value="perGram">Amount per gram</option></select></div>
        <div className="field"><label htmlFor="makingInput">{makingMode === "percent" ? "Making charge (%)" : makingMode === "fixed" ? "Making charge (₹)" : "Making charge (₹/gram)"}</label><input id="makingInput" type="number" min="0" step="0.01" value={makingInput} onChange={(e) => setMakingInput(e.target.value)} /></div>
        <div className="field"><label htmlFor="wastage">Wastage (% of gold value)</label><input id="wastage" type="number" min="0" step="0.01" value={wastagePercent} onChange={(e) => setWastagePercent(e.target.value)} /></div>
        <div className="field"><label htmlFor="otherCharges">Other charges (₹)</label><input id="otherCharges" type="number" min="0" step="0.01" value={otherCharges} onChange={(e) => setOtherCharges(e.target.value)} /></div>
        <div className="field"><label htmlFor="discount">Discount (₹)</label><input id="discount" type="number" min="0" step="0.01" value={discount} onChange={(e) => setDiscount(e.target.value)} /></div>
      </div>
      <div style={{ borderTop: "1px solid #eceee7", marginTop: 20, paddingTop: 18 }}>
        <label style={{ display: "flex", gap: 10, alignItems: "center", fontSize: 13, fontWeight: 750 }}><input type="checkbox" checked={gstEnabled} onChange={(e) => setGstEnabled(e.target.checked)} /> Include GST in this estimate</label>
        {gstEnabled && <div className="field" style={{ marginTop: 14, maxWidth: 220 }}><label htmlFor="gst">GST (%)</label><input id="gst" type="number" min="0" step="0.01" value={gstPercent} onChange={(e) => setGstPercent(e.target.value)} /></div>}
        <p className="small muted" style={{ margin: "12px 0 0" }}>For invoices, configure approved tax rules and obtain the appropriate professional review. This calculator does not determine legal tax liability.</p>
      </div>
    </section>
    <aside className="panel">
      <div className="eyebrow">Calculation summary</div>
      <div className="result-hero" style={{ marginTop: 13 }}><div className="label">Estimated item total</div><strong>{inr(values.total)}</strong><div className="label">{parsePositive(weight).toLocaleString("en-IN")} grams · {purity}</div></div>
      <div style={{ marginTop: 15 }}>
        <div className="breakdown-row"><span>Gold value</span><strong>{inr(values.goldValue)}</strong></div>
        <div className="breakdown-row"><span>Making charges</span><strong>{inr(values.making)}</strong></div>
        <div className="breakdown-row"><span>Wastage</span><strong>{inr(values.wastage)}</strong></div>
        <div className="breakdown-row"><span>Other charges</span><strong>{inr(values.other)}</strong></div>
        <div className="breakdown-row"><span>Discount</span><strong>−{inr(values.discount)}</strong></div>
        <div className="breakdown-row"><span>Taxable subtotal</span><strong>{inr(values.taxableSubtotal)}</strong></div>
        <div className="breakdown-row"><span>GST {gstEnabled ? "(" + parsePositive(gstPercent) + "%)" : "(excluded)"}</span><strong>{inr(values.gst)}</strong></div>
        <div className="breakdown-row total"><span>Estimated total</span><strong>{inr(values.total)}</strong></div>
      </div>
      <div style={{ background: "#f4f5ef", borderRadius: 13, padding: 16, marginTop: 19 }}>
        <h3 style={{ marginBottom: 5 }}>Budget to gold weight</h3><p className="small muted">Estimate the grams affordable at the selected rate and charges.</p>
        <div className="field"><label htmlFor="budget">Your budget (₹)</label><input id="budget" type="number" min="0" step="1" value={budget} onChange={(e) => setBudget(e.target.value)} /></div>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 12, marginTop: 14 }}><span className="small muted">Estimated net weight</span><strong style={{ color: "#1f5c3e", fontSize: 23 }}>{values.budgetGrams.toLocaleString("en-IN", { maximumFractionDigits: 3 })} g</strong></div>
        <p className="small muted" style={{ margin: "7px 0 0" }}>The reverse estimate uses the same rate, making, wastage, other-charge, discount and tax settings. Treat discounts as estimates until the shop confirms eligibility.</p>
      </div>
    </aside>
  </div>;
}
