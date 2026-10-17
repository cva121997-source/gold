"use client";

import Link from "next/link";
import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowLeft, CircleAlert, ClipboardCheck, RefreshCw, ShieldCheck } from "lucide-react";
import { createClient } from "@/lib/supabase/client";

type Membership = { tenant_id: string; branch_id: string | null; role: string; tenants: { display_name: string; slug: string } | null };
type Enrolment = { id: string; tenant_id: string; branch_id: string | null; customer_id: string; enrolment_code: string; status: string; maturity_date: string | null; start_date: string };
type Benefit = { id: string; enrolment_id: string; benefit_type: string; status: string; amount_value: number | null; weight_grams: number | null; eligible_at: string | null; rules_snapshot: Record<string, unknown> };
type Redemption = { id: string; enrolment_id: string; benefit_id: string | null; redemption_code: string; status: string; value_inr: number; weight_grams: number; notes: string | null; created_at: string; completed_at: string | null };
const inr = (value: number) => new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 2 }).format(Number(value) || 0);

export default function RedemptionsPage() {
  const router = useRouter();
  const [memberships, setMemberships] = useState<Membership[]>([]);
  const [tenantId, setTenantId] = useState("");
  const [enrolments, setEnrolments] = useState<Enrolment[]>([]);
  const [benefits, setBenefits] = useState<Benefit[]>([]);
  const [redemptions, setRedemptions] = useState<Redemption[]>([]);
  const [benefitId, setBenefitId] = useState("");
  const [value, setValue] = useState("0");
  const [weight, setWeight] = useState("0");
  const [notes, setNotes] = useState("");
  const [reviewNotes, setReviewNotes] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const supabase = createClient();
        const { data: { user } } = await supabase.auth.getUser();
        if (!user) { router.replace("/login"); return; }
        const { data, error: e } = await supabase.from("tenant_memberships").select("tenant_id,branch_id,role,tenants(display_name,slug)").eq("user_id", user.id).eq("is_active", true);
        if (e) throw e;
        if (!active) return;
        const rows = (data ?? []) as unknown as Membership[];
        setMemberships(rows); setTenantId(rows[0]?.tenant_id ?? "");
      } catch { if (active) setError("Scheme redemption access could not be loaded. Check authentication and shop membership."); }
      finally { if (active) setLoading(false); }
    })();
    return () => { active = false; };
  }, [router]);

  const load = useCallback(async () => {
    if (!tenantId) { setEnrolments([]); setBenefits([]); setRedemptions([]); return; }
    setError("");
    const supabase = createClient();
    const [e, b, r] = await Promise.all([
      supabase.from("scheme_enrolments").select("id,tenant_id,branch_id,customer_id,enrolment_code,status,maturity_date,start_date").eq("tenant_id", tenantId).order("created_at", { ascending: false }).limit(500),
      supabase.from("scheme_benefits").select("id,enrolment_id,benefit_type,status,amount_value,weight_grams,eligible_at,rules_snapshot").eq("tenant_id", tenantId).order("created_at", { ascending: false }).limit(500),
      supabase.from("scheme_redemptions").select("id,enrolment_id,benefit_id,redemption_code,status,value_inr,weight_grams,notes,created_at,completed_at").eq("tenant_id", tenantId).order("created_at", { ascending: false }).limit(500)
    ]);
    if (e.error || b.error || r.error) { setError("Could not load redemption records. Confirm the latest migrations and owner/manager or scheme role."); return; }
    setEnrolments((e.data ?? []) as Enrolment[]);
    setBenefits((b.data ?? []) as Benefit[]);
    setRedemptions((r.data ?? []) as Redemption[]);
  }, [tenantId]);

  useEffect(() => { void load(); }, [load]);
  const current = memberships.find((m) => m.tenant_id === tenantId);
  const canManage = ["owner", "manager", "scheme_manager"].includes(current?.role ?? "");
  const canReview = ["owner", "manager"].includes(current?.role ?? "");
  const enrolmentMap = useMemo(() => new Map(enrolments.map((row) => [row.id, row])), [enrolments]);
  const benefitMap = useMemo(() => new Map(benefits.map((row) => [row.id, row])), [benefits]);
  const chosenBenefit = benefits.find((row) => row.id === benefitId);

  async function evaluate(enrolment: Enrolment) {
    setError(""); setNotice(""); setSaving(true);
    try {
      const { error: rpcError } = await createClient().rpc("evaluate_scheme_benefit", { p_tenant_id: tenantId, p_enrolment_id: enrolment.id });
      if (rpcError) throw rpcError;
      setNotice("Scheme benefit eligibility evaluation completed and recorded by the database workflow.");
      await load();
    } catch (e) { setError(e instanceof Error ? e.message : "Eligibility could not be evaluated. Confirm the published terms and contribution schedule."); }
    finally { setSaving(false); }
  }

  function selectBenefit(nextId: string) {
    setBenefitId(nextId);
    const benefit = benefits.find((row) => row.id === nextId);
    setValue(String(benefit?.amount_value ?? 0));
    setWeight(String(benefit?.weight_grams ?? 0));
  }

  async function requestRedemption(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setError(""); setNotice("");
    const benefit = benefitMap.get(benefitId);
    const enrolment = benefit ? enrolmentMap.get(benefit.enrolment_id) : undefined;
    if (!benefit || !enrolment) { setError("Choose an existing benefit and enrolment."); return; }
    const valueNumber = Number(value); const weightNumber = Number(weight);
    if (!Number.isFinite(valueNumber) || valueNumber < 0 || !Number.isFinite(weightNumber) || weightNumber < 0) { setError("Value and gold weight must be valid non-negative amounts."); return; }
    setSaving(true);
    try {
      const { error: rpcError } = await createClient().rpc("request_scheme_redemption", {
        p_tenant_id: tenantId, p_branch_id: enrolment.branch_id ?? current?.branch_id ?? null,
        p_enrolment_id: enrolment.id, p_benefit_id: benefit.id, p_value_inr: valueNumber,
        p_weight_grams: weightNumber, p_notes: notes.trim() || null
      });
      if (rpcError) throw rpcError;
      setNotice("Redemption request submitted. An owner or manager must review it before completion.");
      setBenefitId(""); setValue("0"); setWeight("0"); setNotes("");
      await load();
    } catch (e) { setError(e instanceof Error ? e.message : "Redemption request failed. The database validates eligibility and duplicate requests."); }
    finally { setSaving(false); }
  }

  async function action(row: Redemption, next: "approve" | "reject" | "complete" | "cancel") {
    setError(""); setNotice(""); setSaving(true);
    try {
      const { error: rpcError } = await createClient().rpc("review_scheme_redemption", {
        p_tenant_id: tenantId, p_redemption_id: row.id, p_action: next, p_notes: reviewNotes[row.id]?.trim() || null
      });
      if (rpcError) throw rpcError;
      setNotice("Redemption " + next + " action recorded and audited.");
      await load();
    } catch (e) { setError(e instanceof Error ? e.message : "Redemption status could not be changed."); }
    finally { setSaving(false); }
  }

  return <main><div className="page-wrap">
    <Link className="link-text small" href="/dashboard"><ArrowLeft size={13} style={{ display: "inline", verticalAlign: "middle" }} /> Back to workspace</Link>
    <div style={{ marginTop: 20, marginBottom: 24 }}>
      <div className="eyebrow"><ClipboardCheck size={14} /> Scheme lifecycle</div>
      <h1 style={{ marginTop: 12 }}>Redemption & benefits</h1>
      <p className="lead">Evaluate published benefit rules, submit redemption requests, and record owner/manager approval and completion against the enrolment ledger.</p>
    </div>
    {error && <div role="alert" className="notice" style={{ marginBottom: 14 }}><CircleAlert size={16} /> {error}</div>}
    {notice && <div role="status" className="notice" style={{ marginBottom: 14, color: "#1f5c3e", background: "#edf7ef", borderColor: "#cfe4d4" }}>{notice}</div>}
    {loading ? <section className="panel">Loading scheme records…</section> : memberships.length === 0 ? <section className="panel"><h2>No shop linked</h2><Link className="btn btn-primary" href="/onboarding">Set up your shop</Link></section> : <>
      <div className="field" style={{ maxWidth: 420, marginBottom: 18 }}><label htmlFor="redemption-tenant">Shop</label>
        <select id="redemption-tenant" value={tenantId} onChange={(e) => setTenantId(e.target.value)}>{memberships.map((m) => <option key={m.tenant_id} value={m.tenant_id}>{m.tenants?.display_name ?? m.tenant_id}</option>)}</select>
      </div>
      <section className="panel" style={{ marginBottom: 18 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
          <div><h2>Benefit eligibility</h2><p className="small muted">Evaluation uses the saved terms and confirmed instalment history; the displayed UI does not itself grant a benefit.</p></div>
          <button className="btn btn-secondary" onClick={() => void load()} type="button" disabled={saving}><RefreshCw size={15} /> Refresh</button>
        </div>
        {enrolments.length === 0 ? <p className="muted">No scheme enrolments found.</p> : <div style={{ display: "grid", gap: 10, marginTop: 12 }}>
          {enrolments.map((enrolment) => <article key={enrolment.id} style={{ border: "1px solid var(--line, #ded8cd)", borderRadius: 12, padding: 12, display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
            <div><strong>{enrolment.enrolment_code}</strong><div className="small muted">{enrolment.status.replaceAll("_", " ")} · Start {enrolment.start_date} · Maturity {enrolment.maturity_date ?? "not set"}</div>
              <div className="small muted">Benefits: {benefits.filter((b) => b.enrolment_id === enrolment.id).map((b) => b.benefit_type + " (" + b.status + ")").join(", ") || "not evaluated yet"}</div></div>
            <button className="btn btn-primary" type="button" disabled={saving || !canManage} onClick={() => void evaluate(enrolment)}>Evaluate eligibility</button>
          </article>)}
        </div>}
      </section>
      <section className="calc-layout">
        <div className="panel"><h2>Request a redemption</h2>
          <p className="small muted">A request is not a completed redemption. The database rechecks permission, enrolment and benefit constraints.</p>
          <form onSubmit={requestRedemption}>
            <div className="field"><label htmlFor="benefit">Benefit</label>
              <select id="benefit" value={benefitId} onChange={(e) => selectBenefit(e.target.value)} required disabled={!canManage}>
                <option value="">Choose benefit…</option>
                {benefits.filter((b) => !["redeemed", "cancelled", "rejected"].includes(b.status)).map((b) => <option key={b.id} value={b.id}>{enrolmentMap.get(b.enrolment_id)?.enrolment_code ?? b.enrolment_id.slice(0, 8)} · {b.benefit_type} · {b.status}</option>)}
              </select>
            </div>
            {chosenBenefit && <p className="small muted">Eligible at: {chosenBenefit.eligible_at ? new Date(chosenBenefit.eligible_at).toLocaleString("en-IN") : "not yet marked"} · Rule snapshot retained.</p>}
            <div className="field" style={{ marginTop: 12 }}><label htmlFor="benefit-value">Redemption value (₹)</label><input id="benefit-value" type="number" min="0" step="0.01" value={value} onChange={(e) => setValue(e.target.value)} disabled={!canManage} /></div>
            <div className="field" style={{ marginTop: 12 }}><label htmlFor="benefit-weight">Gold weight (grams)</label><input id="benefit-weight" type="number" min="0" step="0.001" value={weight} onChange={(e) => setWeight(e.target.value)} disabled={!canManage} /></div>
            <div className="field" style={{ marginTop: 12 }}><label htmlFor="benefit-notes">Notes / quote reference</label><textarea id="benefit-notes" rows={3} value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={2000} disabled={!canManage} /></div>
            <button className="btn btn-primary" type="submit" style={{ width: "100%", marginTop: 16 }} disabled={saving || !canManage}>Submit redemption request</button>
          </form>
        </div>
        <div className="panel"><h2>Redemption register</h2>
          {redemptions.length === 0 ? <p className="muted" style={{ marginTop: 14 }}>No redemptions submitted yet.</p> : <div style={{ display: "grid", gap: 12, marginTop: 14 }}>
            {redemptions.map((row) => <article key={row.id} style={{ border: "1px solid var(--line, #ded8cd)", borderRadius: 14, padding: 14 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "start", gap: 10, flexWrap: "wrap" }}><div><strong>{row.redemption_code}</strong><div className="small muted">{enrolmentMap.get(row.enrolment_id)?.enrolment_code ?? row.enrolment_id.slice(0, 8)}</div></div><span className="pill">{row.status}</span></div>
              <p style={{ margin: "10px 0 4px" }}>{inr(Number(row.value_inr))} · {Number(row.weight_grams).toFixed(3)} g</p>
              {row.notes && <p className="small muted">{row.notes}</p>}
              <div className="small muted">Created {new Date(row.created_at).toLocaleString("en-IN")}{row.completed_at ? " · Completed " + new Date(row.completed_at).toLocaleString("en-IN") : ""}</div>
              {canReview && ["requested", "approved"].includes(row.status) && <div style={{ marginTop: 10 }}>
                <div className="field"><label htmlFor={"review-note-" + row.id}>Review notes</label><input id={"review-note-" + row.id} value={reviewNotes[row.id] ?? ""} onChange={(e) => setReviewNotes((prev) => ({ ...prev, [row.id]: e.target.value }))} placeholder="Optional internal note" /></div>
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 10 }}>
                  {row.status === "requested" && <><button className="btn btn-primary" type="button" disabled={saving} onClick={() => void action(row, "approve")}>Approve</button><button className="btn btn-secondary" type="button" disabled={saving} onClick={() => void action(row, "reject")}>Reject</button></>}
                  {row.status === "approved" && <button className="btn btn-primary" type="button" disabled={saving} onClick={() => void action(row, "complete")}>Mark redeemed</button>}
                  <button className="btn btn-secondary" type="button" disabled={saving} onClick={() => void action(row, "cancel")}>Cancel</button>
                </div>
              </div>}
            </article>)}
          </div>}
        </div>
      </section>
      <section className="panel" style={{ marginTop: 18 }}><p className="small muted" style={{ margin: 0 }}><ShieldCheck size={15} style={{ display: "inline", verticalAlign: "middle" }} /> Eligibility, approval, cancellation and completion are stored through audited database RPCs. Confirm scheme terms with your legal/tax adviser; configuration alone does not establish legal approval.</p></section>
    </>}
  </div></main>;
}
