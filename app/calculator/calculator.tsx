"use client";
import { useMemo, useState, type FormEvent } from "react";
import { Info, RotateCcw } from "lucide-react";
import { calculateJewelleryQuote } from "@/lib/gold-calculation.js";

type MakingMode = "percent" | "fixed" | "perGram";
type PublicRate = {
  shop_name: string; shop_slug: string; branch_name: string | null; state: string | null;
  district: string | null; city: string | null; locality: string | null;
  metal_code: string; metal_name: string; purity_code: string; purity_label: string;
  price_per_gram: number | string; source_label: string | null; rate_status: string;
  effective_at: string; is_stale: boolean;
};
const todayInIndia = () => new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit"
}).format(new Date());
const inr = (amount: number) => new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 2 }).format(Number.isFinite(amount) ? amount : 0);
const parsePositive = (value: string) => { const n = Number(value); return Number.isFinite(n) && n >= 0 ? n : 0; };

export default function GoldCalculator() {
  const [purity, setPurity] = useState("22K · 916");
  const [metal, setMetal] = useState("gold");
  const [rate, setRate] = useState("13535");
  const [shopSlug, setShopSlug] = useState("");
  const [rateDate, setRateDate] = useState(todayInIndia);
  const [publishedRates, setPublishedRates] = useState<PublicRate[]>([]);
  const [loadedShop, setLoadedShop] = useState<PublicRate | null>(null);
  const [rateLoading, setRateLoading] = useState(false);
  const [rateError, setRateError] = useState("");
  const [rateNotice, setRateNotice] = useState("");
  const [weight, setWeight] = useState("10");
  const [makingMode, setMakingMode] = useState<MakingMode>("percent");
  const [makingInput, setMakingInput] = useState("12");
  const [wastagePercent, setWastagePercent] = useState("0");
  const [otherCharges, setOtherCharges] = useState("0");
  const [discount, setDiscount] = useState("0");
  const [gstEnabled, setGstEnabled] = useState(true);
  const [gstPercent, setGstPercent] = useState("3");
  const [budget, setBudget] = useState("156140");

  const availableMetals = useMemo(() => {
    if (!publishedRates.length) return [{ code: "gold", name: "Gold" }];
    const unique = new Map<string, string>();
    publishedRates.forEach((item) => unique.set(item.metal_code, item.metal_name));
    return Array.from(unique.entries()).map(([code, name]) => ({ code, name }));
  }, [publishedRates]);
  const availablePurities = useMemo(() => {
    if (!publishedRates.length) return ["24K · 999", "22K · 916", "18K · 750"];
    return Array.from(new Set(publishedRates.filter((item) => item.metal_code === metal).map((item) => item.purity_label)));
  }, [publishedRates, metal]);
  const selectedPublishedRate = publishedRates.find((item) => item.metal_code === metal && item.purity_label === purity) ?? null;

  async function loadPublishedRates(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setRateError("");
    setRateNotice("");
    setRateLoading(true);
    try {
      const { createClient } = await import("@/lib/supabase/client");
      const { data, error } = await createClient().rpc("get_public_rate_board_for_date", {
        p_shop_slug: shopSlug.trim(),
        p_rate_date: rateDate,
      });
      if (error) {
        setRateError("Published rates could not be loaded. Check the shop slug, public rate settings and the historical-rate migration.");
        setPublishedRates([]);
        setLoadedShop(null);
        return;
      }
      const rows = (data ?? []) as PublicRate[];
      if (!rows.length) {
        setRateError("No public rate has been published for this shop on or before the selected date. The calculator will remain on its clearly labelled sample rate.");
        setPublishedRates([]);
        setLoadedShop(null);
        return;
      }
      setPublishedRates(rows);
      const preferred = rows.find((item) => item.metal_code === "gold" && item.purity_code === "22K") ?? rows.find((item) => item.metal_code === "gold") ?? rows[0];
      setMetal(preferred.metal_code);
      setPurity(preferred.purity_label);
      setRate(String(preferred.price_per_gram));
      setLoadedShop(preferred);
      const location = [preferred.locality, preferred.city, preferred.district, preferred.state].filter(Boolean).join(", ");
      setRateNotice(preferred.shop_name + (location ? " · " + location : "") + " · rates effective on or before " + rateDate);
    } catch {
      setRateError("Gold could not connect to the published rate board. Check Supabase configuration and try again.");
    } finally {
      setRateLoading(false);
    }
  }

  function chooseMetal(next: string) {
    setMetal(next);
    const nextRate = publishedRates.find((item) => item.metal_code === next);
    if (nextRate) {
      setPurity(nextRate.purity_label);
      setRate(String(nextRate.price_per_gram));
      setLoadedShop(nextRate);
    } else if (next === "gold") {
      setPurity("22K · 916");
      setRate("13535");
    } else {
      setPurity("");
      setRate("0");
    }
  }

  function choosePurity(next: string) {
    setPurity(next);
    const selected = publishedRates.find((item) => item.metal_code === metal && item.purity_label === next);
    if (selected) {
      setRate(String(selected.price_per_gram));
      setLoadedShop(selected);
    } else if (!publishedRates.length) {
      if (next === "24K · 999") setRate("14712");
      else if (next === "22K · 916") setRate("13535");
      else setRate("11034");
    }
  }

  const values = useMemo(() => calculateJewelleryQuote({
    rate, weight, makingMode, makingInput, wastagePercent, otherCharges, discount, gstEnabled, gstPercent, budget
  }), [rate, weight, makingMode, makingInput, wastagePercent, otherCharges, discount, gstEnabled, gstPercent, budget]);

  function reset() {
    setPurity("22K · 916"); setMetal("gold"); setRate("13535"); setWeight("10"); setMakingMode("percent"); setMakingInput("12");
    setWastagePercent("0"); setOtherCharges("0"); setDiscount("0"); setGstEnabled(true); setGstPercent("3"); setBudget("156140");
    setShopSlug(""); setRateDate(todayInIndia()); setPublishedRates([]); setLoadedShop(null); setRateError(""); setRateNotice("");
  }

  return <div style={{ display: "grid", gap: 18 }}>
    <section className="panel">
      <div className="eyebrow">Local rate lookup</div>
      <h2 style={{ marginTop: 9 }}>Use a shop-published rate</h2>
      <p className="small muted">Enter a shop URL slug and a date. Gold only loads rates the shop explicitly published to its public rate board; unavailable or old rates are never passed off as a live market feed.</p>
      <form onSubmit={loadPublishedRates}>
        <div className="form-grid">
          <div className="field"><label htmlFor="shopSlugRate">Shop URL slug</label><input id="shopSlugRate" value={shopSlug} onChange={(e) => setShopSlug(e.target.value.toLowerCase().trim())} maxLength={60} pattern="[a-z0-9]+(-[a-z0-9]+)*" placeholder="sri-lakshmi-gold-house" /></div>
          <div className="field"><label htmlFor="selectedRateDate">Rate date (India)</label><input id="selectedRateDate" type="date" value={rateDate} max={todayInIndia()} onChange={(e) => setRateDate(e.target.value)} required /></div>
        </div>
        <button className="btn btn-primary" type="submit" disabled={rateLoading || !shopSlug.trim()} style={{ marginTop: 12 }}>{rateLoading ? "Loading published rates…" : "Load shop rates for this date"}</button>
      </form>
      {rateError && <div role="alert" className="notice" style={{ marginTop: 13 }}>{rateError}</div>}
      {rateNotice && <div className="notice" style={{ marginTop: 13, color: "#1f5c3e", background: "#edf7ef", borderColor: "#cfe4d4" }}>{rateNotice}</div>}
      {loadedShop && <div className="small muted" style={{ marginTop: 8 }}>
        Source: {loadedShop.source_label ?? loadedShop.rate_status} · Effective {new Date(loadedShop.effective_at).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })}
        {loadedShop.is_stale ? " · STALE / VERIFY" : ""}
      </div>}
    </section>
    <div className="calc-layout">
    <section className="panel">
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, marginBottom: 20 }}>
        <div><h2>Item details</h2><p className="small muted" style={{ marginBottom: 0 }}>All amounts are estimates in Indian rupees.</p></div>
        <button className="btn btn-secondary" type="button" onClick={reset}><RotateCcw size={14} /> Reset</button>
      </div>
      <div className="notice" style={{ marginBottom: 20 }}><Info size={16} style={{ flexShrink: 0, marginTop: 1 }} /><span>Regression example, not a current market quote. Confirm the local rate and applicable tax treatment before using these figures for a sale.</span></div>
      <div className="form-grid">
        <div className="field"><label htmlFor="metal">Metal</label><select id="metal" value={metal} onChange={(e) => chooseMetal(e.target.value)}>{availableMetals.map((item) => <option key={item.code} value={item.code}>{item.name}</option>)}</select></div><div className="field"><label htmlFor="purity">Purity</label><select id="purity" value={purity} onChange={(e) => choosePurity(e.target.value)}>{availablePurities.map((item) => <option key={item} value={item}>{item}</option>)}</select></div>
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
      <div className="result-hero" style={{ marginTop: 13 }}><div className="label">Estimated item total</div><strong>{inr(values.total)}</strong><div className="label">{parsePositive(weight).toLocaleString("en-IN")} grams · {availableMetals.find((item) => item.code === metal)?.name ?? "Metal"} · {purity}</div></div>
      <div style={{ marginTop: 15 }}>
        <div className="breakdown-row"><span>{availableMetals.find((item) => item.code === metal)?.name ?? "Metal"} value</span><strong>{inr(values.goldValue)}</strong></div>
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
    </div>
  </div>;
}
