"use client";

import Link from "next/link";
import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowLeft, BookOpenCheck, CircleAlert, FileCheck2, Plus, ShieldCheck, WalletCards } from "lucide-react";
import { createClient } from "@/lib/supabase/client";

type Membership = { tenant_id: string; role: string; tenants: { display_name: string; slug: string } | null };
type Scheme = { id: string; tenant_id: string; name: string; description: string | null; scheme_type: string; status: string; current_version: number; created_at: string };
type SchemeVersion = { id: string; tenant_id: string; scheme_id: string; version_no: number; terms: Record<string, unknown>; reviewed_at: string | null; effective_from: string | null };

export default function SchemesPage() {
  const router = useRouter();
  const [memberships, setMemberships] = useState<Membership[]>([]);
  const [tenantId, setTenantId] = useState("");
  const [schemes, setSchemes] = useState<Scheme[]>([]);
  const [versions, setVersions] = useState<SchemeVersion[]>([]);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [schemeType, setSchemeType] = useState("flexible_gold_weight");
  const [tenure, setTenure] = useState("11");
  const [monthlyAmount, setMonthlyAmount] = useState("5000");
  const [benefitType, setBenefitType] = useState("one_instalment_equivalent");
  const [benefitMultiplier, setBenefitMultiplier] = useState("1");
  const [benefitAmount, setBenefitAmount] = useState("");
  const [benefitWeight, setBenefitWeight] = useState("");
  const [purityCode, setPurityCode] = useState("22K");
  const [weightInPeriodMonths, setWeightInPeriodMonths] = useState("1");
  const [gracePeriodDays, setGracePeriodDays] = useState("0");
  const [paymentDueDay, setPaymentDueDay] = useState("5");
  const [editingSchemeId, setEditingSchemeId] = useState<string | null>(null);
  const [approvedIds, setApprovedIds] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const supabase = createClient();
        const { data: { user } } = await supabase.auth.getUser();
        if (!user) { router.replace("/login"); return; }
        const { data, error: queryError } = await supabase.from("tenant_memberships").select("tenant_id, role, tenants(display_name, slug)").eq("user_id", user.id).eq("is_active", true);
        if (queryError) throw queryError;
        if (!alive) return;
        const rows = (data ?? []) as unknown as Membership[];
        setMemberships(rows); setTenantId(rows[0]?.tenant_id ?? "");
      } catch { if (alive) setError("Could not load shop memberships. Confirm the Supabase setup."); }
      finally { if (alive) setLoading(false); }
    })();
    return () => { alive = false; };
  }, [router]);

  const loadSchemes = useCallback(async () => {
    if (!tenantId) { setSchemes([]); setVersions([]); return; }
    const supabase = createClient();
    const { data, error: queryError } = await supabase.from("scheme_templates").select("id, tenant_id, name, description, scheme_type, status, current_version, created_at").eq("tenant_id", tenantId).order("created_at", { ascending: false });
    if (queryError) { setError("Could not read scheme templates. Check that the operations migration has been applied."); return; }
    const schemeRows = (data ?? []) as Scheme[];
    setSchemes(schemeRows);
    if (schemeRows.length === 0) { setVersions([]); return; }
    const { data: versionData, error: versionError } = await supabase.from("scheme_versions").select("id, tenant_id, scheme_id, version_no, terms, reviewed_at, effective_from").eq("tenant_id", tenantId).in("scheme_id", schemeRows.map((s) => s.id));
    if (versionError) { setError("Scheme versions could not be loaded. Check the migration and database policies."); return; }
    setVersions((versionData ?? []) as SchemeVersion[]);
  }, [tenantId]);

  useEffect(() => { void loadSchemes(); }, [loadSchemes]);
  const selectedMembership = memberships.find((m) => m.tenant_id === tenantId);
  const canManage = ["owner","manager","scheme_manager"].includes(selectedMembership?.role ?? "");
  const canPublish = selectedMembership?.role === "owner";
  const canControlLifecycle = ["owner","manager"].includes(selectedMembership?.role ?? "");
  const newestVersion = useMemo(() => {
    const map = new Map<string, SchemeVersion>();
    for (const version of [...versions].sort((a,b) => b.version_no - a.version_no)) if (!map.has(version.scheme_id)) map.set(version.scheme_id, version);
    return map;
  }, [versions]);

  function resetEditor() {
    setEditingSchemeId(null); setName(""); setDescription(""); setSchemeType("flexible_gold_weight");
    setTenure("11"); setMonthlyAmount("5000"); setBenefitType("one_instalment_equivalent");
    setBenefitMultiplier("1"); setBenefitAmount(""); setBenefitWeight(""); setPurityCode("22K");
    setWeightInPeriodMonths("1"); setGracePeriodDays("0"); setPaymentDueDay("5");
  }

  function termsForEditor() {
    const fixed = schemeType === "fixed_monthly";
    const tenureNumber = Number(tenure);
    const monthlyNumber = Number(monthlyAmount);
    const multiplierNumber = Number(benefitMultiplier);
    const amountNumber = benefitAmount.trim() ? Number(benefitAmount) : null;
    const weightNumber = benefitWeight.trim() ? Number(benefitWeight) : null;
    const weightInMonths = Number(weightInPeriodMonths);
    const graceDays = Number(gracePeriodDays);
    const dueDay = Number(paymentDueDay);
    if (fixed && (!Number.isInteger(tenureNumber) || tenureNumber < 1 || tenureNumber > 120 ||
        !Number.isFinite(monthlyNumber) || monthlyNumber <= 0)) {
      throw new Error("For a monthly scheme, enter a tenure from 1–120 months and a positive instalment amount.");
    }
    if (fixed && (!Number.isFinite(multiplierNumber) || multiplierNumber <= 0 || multiplierNumber > 24)) {
      throw new Error("Benefit instalment equivalent must be greater than zero and no more than 24 months.");
    }
    if (fixed && (!Number.isInteger(weightInMonths) || weightInMonths < 0 || weightInMonths > 24)) {
      throw new Error("Weight-in / benefit waiting period must be between 0 and 24 months.");
    }
    if (!Number.isInteger(graceDays) || graceDays < 0 || graceDays > 60) throw new Error("Grace period must be between 0 and 60 days.");
    if (!Number.isInteger(dueDay) || dueDay < 1 || dueDay > 28) throw new Error("Monthly due day must be between 1 and 28.");
    if (benefitType === "gold_weight_bonus" && fixed && (!weightNumber || !Number.isFinite(weightNumber) || weightNumber <= 0)) {
      throw new Error("Enter a positive gold-weight bonus to publish this benefit.");
    }
    if (benefitAmount.trim() && (!Number.isFinite(amountNumber) || Number(amountNumber) <= 0)) {
      throw new Error("Benefit amount must be positive when entered.");
    }
    return {
      scheme_type: schemeType, metal: "gold", purity_code: purityCode,
      payment_frequency: fixed ? "monthly" : "flexible",
      tenure_months: fixed ? tenureNumber : null,
      monthly_instalment_inr: fixed ? monthlyNumber : null,
      payment_due_day: dueDay,
      grace_period_days: graceDays,
      weight_in_period_months: fixed ? weightInMonths : 0,
      benefit_type: fixed ? benefitType : "none",
      benefit_equivalent_monthly_instalments: fixed && benefitType === "one_instalment_equivalent" ? multiplierNumber : 0,
      ...(fixed && amountNumber ? { benefit_amount_inr: amountNumber } : {}),
      ...(fixed && weightNumber ? { benefit_weight_grams: weightNumber } : {}),
      requires_owner_review: true, customer_terms_approved: false, owner_reviewed: false
    };
  }

  function beginEdit(scheme: Scheme, version?: SchemeVersion) {
    const terms = version?.terms ?? {};
    setEditingSchemeId(scheme.id); setName(scheme.name); setDescription(scheme.description ?? "");
    setSchemeType(scheme.scheme_type); setPurityCode(String(terms.purity_code ?? "22K"));
    setTenure(String(terms.tenure_months ?? 11)); setMonthlyAmount(String(terms.monthly_instalment_inr ?? 5000));
    setBenefitType(String(terms.benefit_type ?? "one_instalment_equivalent"));
    setBenefitMultiplier(String(terms.benefit_equivalent_monthly_instalments ?? 1));
    setBenefitAmount(terms.benefit_amount_inr == null ? "" : String(terms.benefit_amount_inr));
    setBenefitWeight(terms.benefit_weight_grams == null ? "" : String(terms.benefit_weight_grams));
    setWeightInPeriodMonths(String(terms.weight_in_period_months ?? 1));
    setGracePeriodDays(String(terms.grace_period_days ?? 0)); setPaymentDueDay(String(terms.payment_due_day ?? 5));
    setError(""); setNotice("Editing " + scheme.name + ". Save creates a new version, sets the scheme to draft and requires owner review before new enrolments resume.");
  }

  async function duplicateScheme(scheme: Scheme, version?: SchemeVersion) {
    const sourceTerms = version?.terms ?? {};
    const duplicateName = ("Copy of " + scheme.name).slice(0, 160);
    setError(""); setNotice(""); setSaving(true);
    try {
      const { error: rpcError } = await createClient().rpc("create_scheme_draft", {
        p_tenant_id: tenantId, p_name: duplicateName, p_description: scheme.description || "Copied from scheme " + scheme.id.slice(0, 8),
        p_scheme_type: scheme.scheme_type,
        p_terms: { ...sourceTerms, requires_owner_review: true, customer_terms_approved: false, owner_reviewed: false, copied_from_scheme_id: scheme.id, copied_from_version: version?.version_no ?? scheme.current_version }
      });
      if (rpcError) throw rpcError;
      setNotice("Scheme duplicated into a new draft. Review all terms before publishing.");
      await loadSchemes();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not duplicate scheme. Check your permissions.");
    } finally { setSaving(false); }
  }

  async function changeLifecycle(scheme: Scheme, action: "pause" | "resume" | "retire") {
    if (action === "retire" && !window.confirm("Retire this scheme? Existing enrolments keep their accepted terms, but new enrolments will not be allowed.")) return;
    setError(""); setNotice(""); setSaving(true);
    try {
      const { data, error: rpcError } = await createClient().rpc("set_scheme_lifecycle", { p_tenant_id: tenantId, p_scheme_id: scheme.id, p_action: action });
      if (rpcError) throw rpcError;
      setNotice("Scheme status updated to " + String(data) + ". Existing customer enrolments retain their accepted terms.");
      await loadSchemes();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Scheme status could not be updated. Lifecycle changes require an owner or manager.");
    } finally { setSaving(false); }
  }

  async function createDraft(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setError(""); setNotice("");
    if (!tenantId) { setError("Select a shop first."); return; }
    let terms: Record<string, unknown>;
    try { terms = termsForEditor(); }
    catch (e) { setError(e instanceof Error ? e.message : "Please check the scheme terms."); return; }
    setSaving(true);
    try {
      const supabase = createClient();
      const rpcResult = editingSchemeId
        ? await supabase.rpc("update_scheme_draft", {
            p_tenant_id: tenantId, p_scheme_id: editingSchemeId, p_name: name.trim(),
            p_description: description.trim() || null, p_scheme_type: schemeType, p_terms: terms
          })
        : await supabase.rpc("create_scheme_draft", {
            p_tenant_id: tenantId, p_name: name.trim(), p_description: description.trim() || null,
            p_scheme_type: schemeType, p_terms: terms
          });
      if (rpcResult.error) {
        setError("Draft not saved. Check your role, scheme state and the latest lifecycle SQL migration.");
        return;
      }
      const editing = Boolean(editingSchemeId);
      resetEditor();
      setNotice(editing
        ? "A new scheme version was created and marked draft. Review and publish it before accepting new enrolments."
        : "Draft created. It is not available to customers until the shop owner reviews and publishes the terms.");
      await loadSchemes();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save this draft. Check connectivity and database migrations.");
    } finally { setSaving(false); }
  }

  async function publishDraft(schemeId: string) {
    setError(""); setNotice("");
    if (!canPublish || !approvedIds.includes(schemeId)) { setError("Only the shop owner can publish, after explicitly reviewing the terms."); return; }
    try {
      const supabase = createClient();
      const { error: rpcError } = await supabase.rpc("publish_scheme_draft", { p_tenant_id: tenantId, p_scheme_id: schemeId, p_owner_approved: true });
      if (rpcError) { setError("Publishing failed. Check the owner role and operations migration."); return; }
      setApprovedIds((items) => items.filter((id) => id !== schemeId));
      setNotice("Scheme published and the reviewed version was recorded.");
      await loadSchemes();
    } catch { setError("Could not publish the draft. Check the connection and try again."); }
  }

  const termsSummary = (version?: SchemeVersion) => {
    const terms = version?.terms ?? {};
    const parts = [];
    if (terms.tenure_months) parts.push(String(terms.tenure_months) + " instalment months");
    if (terms.weight_in_period_months != null) parts.push(String(terms.weight_in_period_months) + " weight-in / benefit waiting months");
    if (terms.grace_period_days) parts.push(String(terms.grace_period_days) + " grace days");
    if (terms.monthly_instalment_inr) parts.push("₹" + Number(terms.monthly_instalment_inr).toLocaleString("en-IN") + " monthly");
    if (terms.benefit_type && terms.benefit_type !== "none") parts.push("Benefit: " + String(terms.benefit_type).replaceAll("_"," "));
    parts.push("owner review required");
    return parts.join(" · ");
  };

  return <main><div className="page-wrap">
    <Link className="link-text small" href="/dashboard"><ArrowLeft size={13} style={{ display: "inline", verticalAlign: "middle" }} /> Back to workspace</Link>
    <div style={{ marginTop: 20, marginBottom: 24 }}><div className="eyebrow"><WalletCards size={14} /> Savings scheme engine</div><h1 style={{ marginTop: 12 }}>Schemes</h1><p className="lead">Create versioned scheme drafts. New drafts stay private to the shop until the owner approves the terms and publishes them.</p></div>
    {error && <div role="alert" className="notice" style={{ marginBottom: 15 }}><CircleAlert size={16} style={{ flexShrink: 0 }} /><span>{error}</span></div>}
    {notice && <div className="notice" style={{ marginBottom: 15, color: "#1f5c3e", background: "#edf7ef", borderColor: "#cfe4d4" }}>{notice}</div>}
    {loading ? <div className="panel">Loading scheme access…</div> : memberships.length === 0 ? <div className="panel"><h2>No shop linked</h2><p className="muted">Set up your shop to start configuring schemes.</p><Link href="/onboarding" className="btn btn-primary">Set up your shop</Link></div> : <div className="calc-layout">
      <section className="panel">
        <h2>{editingSchemeId ? "Edit scheme — create a new version" : "Create a scheme draft"}</h2><p className="small muted">Terms are immutable snapshots. Saving an edit appends a new draft version; the shop owner must review it before new enrolments resume.</p>
        {editingSchemeId && <button className="btn btn-secondary" type="button" onClick={resetEditor} style={{marginBottom:14}}>Cancel edit</button>}
        {memberships.length > 1 && <div className="field" style={{ marginBottom: 15 }}><label htmlFor="tenant">Shop</label><select id="tenant" value={tenantId} onChange={(e) => setTenantId(e.target.value)}>{memberships.map((m) => <option key={m.tenant_id} value={m.tenant_id}>{m.tenants?.display_name ?? m.tenant_id}</option>)}</select></div>}
        {canManage ? <form onSubmit={createDraft}>
          <div className="field"><label htmlFor="name">Scheme name *</label><input id="name" required minLength={2} maxLength={160} value={name} onChange={(e) => setName(e.target.value)} placeholder="11-Month Jewellery Savings" /></div>
          <div className="field" style={{ marginTop: 14 }}><label htmlFor="description">Description and draft terms note</label><input id="description" value={description} onChange={(e) => setDescription(e.target.value)} maxLength={500} placeholder="Draft terms require owner and legal review" /></div>
          <div className="field" style={{ marginTop: 14 }}><label htmlFor="schemeType">Scheme model</label><select id="schemeType" value={schemeType} onChange={(e) => setSchemeType(e.target.value)}><option value="flexible_gold_weight">Flexible gold-weight savings</option><option value="fixed_monthly">Fixed monthly jewellery savings</option><option value="custom">Custom draft</option></select></div>
          {schemeType === "fixed_monthly" && <div className="form-grid" style={{ marginTop: 14 }}>
            <div className="field"><label htmlFor="tenure">Tenure (months)</label><input id="tenure" type="number" min="1" max="120" value={tenure} onChange={(e) => setTenure(e.target.value)} required /></div>
            <div className="field"><label htmlFor="monthlyAmount">Monthly instalment (₹)</label><input id="monthlyAmount" type="number" min="1" step="0.01" value={monthlyAmount} onChange={(e) => setMonthlyAmount(e.target.value)} required /></div>
            <div className="field" style={{ gridColumn: "1 / -1" }}><label htmlFor="benefitType">Draft maturity benefit</label><select id="benefitType" value={benefitType} onChange={(e) => setBenefitType(e.target.value)}><option value="one_instalment_equivalent">Equivalent to one or more monthly instalments</option><option value="jewellery_purchase_credit">Fixed jewellery purchase credit</option><option value="gold_weight_bonus">Gold-weight bonus</option><option value="making_charge_discount">Making-charge discount</option><option value="custom">Custom benefit</option><option value="none">No additional benefit</option></select></div>
            {benefitType === "one_instalment_equivalent" && <div className="field"><label htmlFor="benefitMultiplier">Benefit amount (monthly instalment equivalents)</label><input id="benefitMultiplier" type="number" min="0.01" max="24" step="0.01" value={benefitMultiplier} onChange={(e) => setBenefitMultiplier(e.target.value)} required /></div>}
            {["jewellery_purchase_credit","making_charge_discount","custom"].includes(benefitType) && <div className="field"><label htmlFor="benefitAmount">Configured benefit amount (₹, optional)</label><input id="benefitAmount" type="number" min="0.01" step="0.01" value={benefitAmount} onChange={(e) => setBenefitAmount(e.target.value)} placeholder="Leave blank to define under the published terms" /></div>}
            {benefitType === "gold_weight_bonus" && <div className="field"><label htmlFor="benefitWeight">Gold-weight benefit (grams)</label><input id="benefitWeight" type="number" min="0.001" step="0.001" value={benefitWeight} onChange={(e) => setBenefitWeight(e.target.value)} required /></div>}
                      <div className="field"><label htmlFor="weightInPeriod">Weight-in / benefit waiting period (months)</label><input id="weightInPeriod" type="number" min="0" max="24" step="1" value={weightInPeriodMonths} onChange={(e) => setWeightInPeriodMonths(e.target.value)} required /></div>
            <div className="field"><label htmlFor="paymentDueDay">Monthly due day (1–28)</label><input id="paymentDueDay" type="number" min="1" max="28" step="1" value={paymentDueDay} onChange={(e) => setPaymentDueDay(e.target.value)} required /></div>
            <div className="field"><label htmlFor="gracePeriodDays">Grace period (days)</label><input id="gracePeriodDays" type="number" min="0" max="60" step="1" value={gracePeriodDays} onChange={(e) => setGracePeriodDays(e.target.value)} required /></div>
          </div>}
          <div className="field" style={{marginTop:14}}><label htmlFor="purityCode">Gold purity used by weight-based calculations</label><select id="purityCode" value={purityCode} onChange={(e)=>setPurityCode(e.target.value)}><option value="24K">24K / 999</option><option value="22K">22K / 916</option><option value="18K">18K / 750</option></select></div>
          <button className="btn btn-primary" type="submit" disabled={saving} style={{ marginTop: 20, width: "100%" }}>{saving ? "Saving draft…" : <><Plus size={15} /> Save draft version</>}</button>
        </form> : <div className="notice">Your shop role does not have permission to create scheme drafts.</div>}
        <div className="notice" style={{ marginTop: 18 }}><BookOpenCheck size={16} style={{ flexShrink: 0, marginTop: 1 }} /><span>Do not describe a benefit as guaranteed until its calculation, legal and tax treatment have been reviewed and approved by the shop owner.</span></div>
      </section>
      <section className="panel">
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}><div><h2>Scheme catalogue</h2><p className="small muted">{schemes.length} schemes for this shop</p></div><span className="pill pill-green">Tenant scoped</span></div>
        {schemes.length === 0 ? <p className="small muted">No schemes in this shop yet. Create a draft to begin.</p> : <div style={{ display: "grid", gap: 12 }}>{schemes.map((scheme) => {
          const version = newestVersion.get(scheme.id);
          const approved = approvedIds.includes(scheme.id);
          return <article className="list-card" key={scheme.id} style={{ display: "block" }}>
            <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 12 }}>
              <div style={{ minWidth: 0 }}><strong>{scheme.name}</strong><div className="small muted" style={{ marginTop: 4 }}>{scheme.scheme_type.replaceAll("_", " ")} · Version {version?.version_no ?? scheme.current_version}</div></div><span className={"pill " + (scheme.status === "published" ? "pill-green" : "pill-demo")}>{scheme.status}</span>
            </div>
            {scheme.description && <p className="small muted" style={{ marginTop: 10, marginBottom: 4 }}>{scheme.description}</p>}
            <p className="small muted" style={{ marginTop: 8, marginBottom: 0 }}>{termsSummary(version)}</p>
            {version && <details style={{marginTop:10}}><summary className="small" style={{cursor:"pointer"}}>Preview full terms (version {version.version_no})</summary><pre style={{whiteSpace:"pre-wrap",overflowWrap:"anywhere",fontSize:11,background:"var(--surface-muted,#f7f4ee)",borderRadius:8,padding:10}}>{JSON.stringify(version.terms,null,2)}</pre></details>}
            {canManage && scheme.status !== "retired" && <div style={{display:"flex",gap:8,flexWrap:"wrap",marginTop:12}}>
              <button className="btn btn-secondary" type="button" disabled={saving} onClick={()=>beginEdit(scheme,version)}>Edit / new version</button>
              <button className="btn btn-secondary" type="button" disabled={saving} onClick={()=>void duplicateScheme(scheme,version)}>Duplicate</button>
              {canControlLifecycle && scheme.status==="published" && <button className="btn btn-secondary" type="button" disabled={saving} onClick={()=>void changeLifecycle(scheme,"pause")}>Pause</button>}
              {canControlLifecycle && scheme.status==="paused" && <button className="btn btn-primary" type="button" disabled={saving} onClick={()=>void changeLifecycle(scheme,"resume")}>Resume</button>}
              {canControlLifecycle && <button className="btn btn-secondary" type="button" disabled={saving} onClick={()=>void changeLifecycle(scheme,"retire")}>Retire</button>}
            </div>}
            {scheme.status === "draft" && canPublish && <div style={{ borderTop: "1px solid #eceee7", marginTop: 12, paddingTop: 12 }}>
              <label style={{ display: "flex", gap: 9, alignItems: "flex-start", fontSize: 12, lineHeight: 1.5 }}><input type="checkbox" checked={approved} onChange={(e) => setApprovedIds((items) => e.target.checked ? [...items.filter((id) => id !== scheme.id), scheme.id] : items.filter((id) => id !== scheme.id))} /><span>I have reviewed this version’s terms, benefit rules, cancellation conditions and applicable legal/tax treatment; I approve publication for this shop.</span></label>
              <button type="button" className="btn btn-primary" disabled={!approved} onClick={() => void publishDraft(scheme.id)} style={{ marginTop: 11 }}><FileCheck2 size={15} /> Publish reviewed version</button>
            </div>}
            {scheme.status === "draft" && !canPublish && <p className="small muted" style={{ marginTop: 10 }}>Only the shop owner can review and publish scheme terms.</p>}
            {version?.reviewed_at && <p className="small muted" style={{ marginTop: 8 }}><ShieldCheck size={13} style={{ display: "inline", verticalAlign: "middle" }} /> Reviewed {new Date(version.reviewed_at).toLocaleString("en-IN")}</p>}
          </article>;
        })}</div>}
      </section>
    </div>}
  </div></main>;
}
