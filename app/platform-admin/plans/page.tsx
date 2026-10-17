"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { ArrowLeft, CircleAlert, CreditCard, RefreshCw, Save, ShieldCheck } from "lucide-react";

type PlanDraft = {
  id: string; code: string; name: string; description: string; monthlyPriceInr: string;
  annualPriceInr: string; trialDays: string; isActive: boolean; entitlementsText: string;
  providerMonthlyPlanRef: string | null; providerAnnualPlanRef: string | null;
};
type ApiPlan = {
  id: string; code: string; name: string; description: string | null; monthly_price_inr: number;
  annual_price_inr: number; trial_days: number; is_active: boolean; entitlements: Record<string, unknown>;
  provider_monthly_plan_ref: string | null; provider_annual_plan_ref: string | null;
};
type ApiResult = { adminRole?: string; plans?: ApiPlan[]; plan?: ApiPlan; error?: string; warning?: string };

function toDraft(plan: ApiPlan): PlanDraft {
  return {
    id: plan.id, code: plan.code, name: plan.name, description: plan.description ?? "",
    monthlyPriceInr: String(plan.monthly_price_inr), annualPriceInr: String(plan.annual_price_inr),
    trialDays: String(plan.trial_days), isActive: plan.is_active,
    entitlementsText: JSON.stringify(plan.entitlements ?? {}, null, 2),
    providerMonthlyPlanRef: plan.provider_monthly_plan_ref, providerAnnualPlanRef: plan.provider_annual_plan_ref
  };
}

export default function PlatformPlansPage() {
  const [plans, setPlans] = useState<PlanDraft[]>([]);
  const [adminRole, setAdminRole] = useState("");
  const [loading, setLoading] = useState(true);
  const [savingPlan, setSavingPlan] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const canManage = ["platform_owner", "platform_admin"].includes(adminRole);

  const load = useCallback(async () => {
    setError("");
    try {
      const response = await fetch("/api/platform-admin/plans", { cache: "no-store" });
      const data = await response.json() as ApiResult;
      if (!response.ok) throw new Error(data.error ?? "Platform plan catalogue could not be loaded.");
      setAdminRole(data.adminRole ?? "");
      setPlans((data.plans ?? []).map(toDraft));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Unable to load subscription plans.");
    } finally { setLoading(false); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  function update(id: string, key: keyof PlanDraft, value: string | boolean) {
    setPlans((current) => current.map((plan) => plan.id === id ? { ...plan, [key]: value } : plan));
  }

  async function save(plan: PlanDraft) {
    setError(""); setNotice(""); setSavingPlan(plan.id);
    let entitlements: Record<string, unknown>;
    try {
      entitlements = JSON.parse(plan.entitlementsText) as Record<string, unknown>;
      if (!entitlements || typeof entitlements !== "object" || Array.isArray(entitlements)) throw new Error("Entitlements must be a JSON object.");
    } catch (e) {
      setError(e instanceof Error ? "Invalid entitlements JSON: " + e.message : "Invalid entitlements JSON.");
      setSavingPlan(""); return;
    }
    const monthlyPriceInr = Number(plan.monthlyPriceInr);
    const annualPriceInr = Number(plan.annualPriceInr);
    const trialDays = Number(plan.trialDays);
    if (!Number.isFinite(monthlyPriceInr) || monthlyPriceInr < 0 || !Number.isFinite(annualPriceInr) || annualPriceInr < 0 || !Number.isInteger(trialDays) || trialDays < 0 || trialDays > 90) {
      setError("Prices must be non-negative INR numbers and trial days must be a whole number from 0 to 90.");
      setSavingPlan(""); return;
    }
    try {
      const response = await fetch("/api/platform-admin/plans", {
        method: "PATCH", headers: { "content-type": "application/json" },
        body: JSON.stringify({
          planId: plan.id, description: plan.description, monthlyPriceInr, annualPriceInr,
          trialDays, isActive: plan.isActive, entitlements
        })
      });
      const result = await response.json() as ApiResult;
      if (!response.ok) throw new Error(result.error ?? "Plan update failed.");
      setNotice(result.warning ?? plan.name + " pricing and entitlements saved.");
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Plan could not be saved.");
    } finally { setSavingPlan(""); }
  }

  return <main><div className="page-wrap">
    <Link className="link-text small" href="/platform-admin"><ArrowLeft size={13} style={{ display: "inline", verticalAlign: "middle" }} /> Back to platform admin</Link>
    <div style={{ marginTop: 20, marginBottom: 24 }}>
      <div className="eyebrow"><CreditCard size={14} /> SaaS billing configuration</div>
      <h1 style={{ marginTop: 12 }}>Subscription plans</h1>
      <p className="lead">Configure the plan catalogue, trial length and feature limits. Prices are INR before any provider-side taxes; have your legal/accounting setup reviewed before activating paid collection.</p>
    </div>
    {error && <div role="alert" className="notice" style={{ marginBottom: 14 }}><CircleAlert size={16} /> {error}</div>}
    {notice && <div role="status" className="notice" style={{ marginBottom: 14, color: "#1f5c3e", background: "#edf7ef", borderColor: "#cfe4d4" }}>{notice}</div>}
    {loading ? <section className="panel">Verifying platform access…</section> : plans.length === 0 ? <section className="panel"><h2>Plan catalogue unavailable</h2><p className="small muted">You need an active platform-admin account and a configured server service key to manage pricing.</p></section> : <>
      <section className="panel" style={{ marginBottom: 18 }}>
        <p className="small muted" style={{ margin: 0 }}><ShieldCheck size={15} style={{ display: "inline", verticalAlign: "middle" }} /> Role: {adminRole.replaceAll("_", " ")}. Provider plan references are managed automatically. Changing a saved price causes future checkouts to create a new immutable Razorpay plan; existing subscriptions keep their current provider plan.</p>
      </section>
      <div style={{ display: "grid", gap: 16 }}>
        {plans.map((plan) => <section className="panel" key={plan.id}>
          <div style={{ display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap", alignItems: "start" }}>
            <div><span className="eyebrow">Plan code: {plan.code}</span><h2 style={{ marginTop: 8 }}>{plan.name}</h2></div>
            <label style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 12, fontWeight: 700 }}><input type="checkbox" checked={plan.isActive} disabled={!canManage || savingPlan === plan.id} onChange={(e) => update(plan.id, "isActive", e.target.checked)} /> Available to customers</label>
          </div>
          <div className="form-grid" style={{ marginTop: 16 }}>
            <div className="field"><label htmlFor={plan.id + "-monthly"}>Monthly price (₹)</label><input id={plan.id + "-monthly"} type="number" min="0" max="100000000" step="0.01" value={plan.monthlyPriceInr} disabled={!canManage || savingPlan === plan.id} onChange={(e) => update(plan.id, "monthlyPriceInr", e.target.value)} /></div>
            <div className="field"><label htmlFor={plan.id + "-annual"}>Annual price (₹)</label><input id={plan.id + "-annual"} type="number" min="0" max="1000000000" step="0.01" value={plan.annualPriceInr} disabled={!canManage || savingPlan === plan.id} onChange={(e) => update(plan.id, "annualPriceInr", e.target.value)} /></div>
            <div className="field"><label htmlFor={plan.id + "-trial"}>Trial length (days)</label><input id={plan.id + "-trial"} type="number" min="0" max="90" step="1" value={plan.trialDays} disabled={!canManage || savingPlan === plan.id} onChange={(e) => update(plan.id, "trialDays", e.target.value)} /></div>
            <div className="field"><label htmlFor={plan.id + "-description"}>Customer-facing description</label><input id={plan.id + "-description"} value={plan.description} maxLength={1000} disabled={!canManage || savingPlan === plan.id} onChange={(e) => update(plan.id, "description", e.target.value)} /></div>
          </div>
          <div className="field" style={{ marginTop: 14 }}><label htmlFor={plan.id + "-entitlements"}>Entitlements JSON (boolean, integer limit or null = unlimited)</label>
            <textarea id={plan.id + "-entitlements"} rows={7} spellCheck={false} value={plan.entitlementsText} disabled={!canManage || savingPlan === plan.id} onChange={(e) => update(plan.id, "entitlementsText", e.target.value)} />
          </div>
          <div className="small muted" style={{ marginTop: 10 }}>
            Provider mapping: monthly {plan.providerMonthlyPlanRef ? "configured" : "created on first paid checkout"} · annual {plan.providerAnnualPlanRef ? "configured" : "created on first paid checkout"}
          </div>
          {canManage && <button className="btn btn-primary" style={{ marginTop: 14 }} type="button" disabled={savingPlan === plan.id} onClick={() => void save(plan)}>{savingPlan === plan.id ? "Saving plan…" : <><Save size={15} /> Save plan settings</>}</button>}
        </section>)}
      </div>
    </>}
    <section className="panel" style={{ marginTop: 18 }}><p className="small muted" style={{ margin: 0 }}>Price changes do not retroactively change existing subscribers. Plan activation through Razorpay remains pending until the signed subscription webhook is processed. Test with Razorpay test credentials before live billing.</p></section>
  </div></main>;
}
