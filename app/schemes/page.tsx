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
  const [benefitType, setBenefitType] = useState("jewellery_purchase_credit");
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
  const newestVersion = useMemo(() => {
    const map = new Map<string, SchemeVersion>();
    for (const version of [...versions].sort((a,b) => b.version_no - a.version_no)) if (!map.has(version.scheme_id)) map.set(version.scheme_id, version);
    return map;
  }, [versions]);

  async function createDraft(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setError(""); setNotice("");
    if (!tenantId) { setError("Select a shop first."); return; }
    if (schemeType === "fixed_monthly" && (!Number(tenure) || Number(tenure) < 1 || !Number(monthlyAmount) || Number(monthlyAmount) <= 0)) { setError("For a monthly scheme, enter a positive tenure and instalment amount."); return; }
    setSaving(true);
    try {
      const supabase = createClient();
      const terms = {
        scheme_type: schemeType,
        metal: "gold",
        purity_code: "22K",
        payment_frequency: schemeType === "fixed_monthly" ? "monthly" : "flexible",
        tenure_months: schemeType === "fixed_monthly" ? Number(tenure) : null,
        monthly_instalment_inr: schemeType === "fixed_monthly" ? Number(monthlyAmount) : null,
        benefit_type: schemeType === "fixed_monthly" ? benefitType : "none",
        benefit_equivalent_monthly_instalments: benefitType === "one_instalment_equivalent" ? 1 : 0,
        requires_owner_review: true,
        customer_terms_approved: false
      };
      const { error: rpcError } = await supabase.rpc("create_scheme_draft", {
        p_tenant_id: tenantId, p_name: name.trim(), p_description: description.trim() || null, p_scheme_type: schemeType, p_terms: terms
      });
      if (rpcError) { setError("Draft not saved. Confirm the operations migration is applied and your role can manage schemes."); return; }
      setName(""); setDescription(""); setNotice("Draft created. It is not available to customers until the shop owner reviews and publishes the terms.");
      await loadSchemes();
    } catch { setError("Could not create this draft. Check connectivity and database migrations."); }
    finally { setSaving(false); }
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
    if (terms.tenure_months) parts.push(String(terms.tenure_months) + " months");
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
        <h2>Create a scheme draft</h2><p className="small muted">The terms snapshot created with this draft is retained as version 1.</p>
        {memberships.length > 1 && <div className="field" style={{ marginBottom: 15 }}><label htmlFor="tenant">Shop</label><select id="tenant" value={tenantId} onChange={(e) => setTenantId(e.target.value)}>{memberships.map((m) => <option key={m.tenant_id} value={m.tenant_id}>{m.tenants?.display_name ?? m.tenant_id}</option>)}</select></div>}
        {canManage ? <form onSubmit={createDraft}>
          <div className="field"><label htmlFor="name">Scheme name *</label><input id="name" required minLength={2} maxLength={160} value={name} onChange={(e) => setName(e.target.value)} placeholder="11-Month Jewellery Savings" /></div>
          <div className="field" style={{ marginTop: 14 }}><label htmlFor="description">Description and draft terms note</label><input id="description" value={description} onChange={(e) => setDescription(e.target.value)} maxLength={500} placeholder="Draft terms require owner and legal review" /></div>
          <div className="field" style={{ marginTop: 14 }}><label htmlFor="schemeType">Scheme model</label><select id="schemeType" value={schemeType} onChange={(e) => setSchemeType(e.target.value)}><option value="flexible_gold_weight">Flexible gold-weight savings</option><option value="fixed_monthly">Fixed monthly jewellery savings</option><option value="custom">Custom draft</option></select></div>
          {schemeType === "fixed_monthly" && <div className="form-grid" style={{ marginTop: 14 }}>
            <div className="field"><label htmlFor="tenure">Tenure (months)</label><input id="tenure" type="number" min="1" max="120" value={tenure} onChange={(e) => setTenure(e.target.value)} required /></div>
            <div className="field"><label htmlFor="monthlyAmount">Monthly instalment (₹)</label><input id="monthlyAmount" type="number" min="1" step="0.01" value={monthlyAmount} onChange={(e) => setMonthlyAmount(e.target.value)} required /></div>
            <div className="field" style={{ gridColumn: "1 / -1" }}><label htmlFor="benefitType">Draft maturity benefit</label><select id="benefitType" value={benefitType} onChange={(e) => setBenefitType(e.target.value)}><option value="jewellery_purchase_credit">Jewellery purchase credit</option><option value="gold_weight_bonus">Gold-weight bonus (requires explicit valuation rules)</option><option value="making_charge_discount">Making-charge discount</option><option value="one_instalment_equivalent">Equivalent to one monthly instalment</option><option value="custom">Custom benefit</option><option value="none">No additional benefit</option></select></div>
          </div>}
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
