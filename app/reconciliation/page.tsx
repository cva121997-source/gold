"use client";

import Link from "next/link";
import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowLeft, CircleAlert, Download, RefreshCw, Scale } from "lucide-react";
import { createClient } from "@/lib/supabase/client";

type Membership = { tenant_id: string; branch_id: string | null; role: string; tenants: { display_name: string; slug: string } | null };
type Reconciliation = { id: string; provider: string | null; branch_id: string | null; period_start: string; period_end: string; expected_amount: number; actual_amount: number; difference_amount: number | null; status: string; notes: string | null; reconciled_by: string | null; reconciled_at: string | null; created_at: string };
const inr = (v: number) => new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 2 }).format(Number(v) || 0);
const today = () => new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
const csv = (v: unknown) => '"' + String(v ?? "").replaceAll('"', '""') + '"';

export default function ReconciliationPage() {
  const router = useRouter();
  const [memberships, setMemberships] = useState<Membership[]>([]);
  const [tenantId, setTenantId] = useState("");
  const [records, setRecords] = useState<Reconciliation[]>([]);
  const [provider, setProvider] = useState("Razorpay");
  const [periodStart, setPeriodStart] = useState(today);
  const [periodEnd, setPeriodEnd] = useState(today);
  const [expected, setExpected] = useState("0");
  const [actual, setActual] = useState("0");
  const [notes, setNotes] = useState("");
  const [filter, setFilter] = useState("all");
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
        const { data, error: queryError } = await supabase.from("tenant_memberships").select("tenant_id,branch_id,role,tenants(display_name,slug)").eq("user_id", user.id).eq("is_active", true);
        if (queryError) throw queryError;
        if (!active) return;
        const rows = (data ?? []) as unknown as Membership[];
        setMemberships(rows); setTenantId(rows[0]?.tenant_id ?? "");
      } catch { if (active) setError("Could not load shop membership."); }
      finally { if (active) setLoading(false); }
    })();
    return () => { active = false; };
  }, [router]);

  const load = useCallback(async () => {
    if (!tenantId) { setRecords([]); return; }
    const { data, error: queryError } = await createClient().from("reconciliation_records")
      .select("id,provider,branch_id,period_start,period_end,expected_amount,actual_amount,difference_amount,status,notes,reconciled_by,reconciled_at,created_at")
      .eq("tenant_id", tenantId).order("created_at", { ascending: false }).limit(500);
    if (queryError) { setError("Reconciliation is restricted to shop owners, managers and accountants; apply the latest migrations."); setRecords([]); return; }
    setRecords((data ?? []) as Reconciliation[]);
  }, [tenantId]);
  useEffect(() => { void load(); }, [load]);

  const current = memberships.find((m) => m.tenant_id === tenantId);
  const canManage = ["owner", "manager", "accountant"].includes(current?.role ?? "");
  const expectedNumber = Number(expected);
  const actualNumber = Number(actual);
  const previewDifference = (Number.isFinite(expectedNumber) ? expectedNumber : 0) - (Number.isFinite(actualNumber) ? actualNumber : 0);
  const filtered = useMemo(() => filter === "all" ? records : records.filter((r) => r.status === filter), [records, filter]);

  async function createRecord(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setError(""); setNotice("");
    if (!tenantId || periodEnd < periodStart) { setError("Choose a valid reconciliation period."); return; }
    if (!Number.isFinite(expectedNumber) || expectedNumber < 0 || !Number.isFinite(actualNumber) || actualNumber < 0) { setError("Amounts must be valid non-negative numbers."); return; }
    setSaving(true);
    try {
      const { data: { user } } = await createClient().auth.getUser();
      if (!user) { router.replace("/login"); return; }
      const difference = Math.round((expectedNumber - actualNumber + Number.EPSILON) * 100) / 100;
      const status = Math.abs(difference) < 0.01 ? "matched" : "open";
      const { error: insertError } = await createClient().from("reconciliation_records").insert({
        tenant_id: tenantId, branch_id: current?.branch_id ?? null,
        provider: provider.trim() || null, period_start: periodStart, period_end: periodEnd,
        expected_amount: expectedNumber, actual_amount: actualNumber, difference_amount: difference,
        status, notes: notes.trim() || null,
        reconciled_by: status === "matched" ? user.id : null, reconciled_at: status === "matched" ? new Date().toISOString() : null
      });
      if (insertError) throw insertError;
      setNotice(status === "matched" ? "Record saved as matched because the entered totals are equal." : "Reconciliation saved as open; investigate the difference before resolving it.");
      setExpected("0"); setActual("0"); setNotes("");
      await load();
    } catch (e) { setError(e instanceof Error ? e.message : "Reconciliation record could not be saved."); }
    finally { setSaving(false); }
  }

  async function setStatus(row: Reconciliation, status: "investigating" | "resolved" | "matched") {
    setError(""); setNotice("");
    if (status === "resolved" && !window.confirm("Mark this reconciliation as resolved? Confirm the difference has been explained with evidence.")) return;
    setSaving(true);
    try {
      const { data: { user } } = await createClient().auth.getUser();
      if (!user) { router.replace("/login"); return; }
      const nextNotes = notes.trim() || row.notes;
      const patch: Record<string, unknown> = { status, notes: nextNotes };
      if (status === "resolved" || status === "matched") {
        patch.reconciled_by = user.id;
        patch.reconciled_at = new Date().toISOString();
      }
      const { error: updateError } = await createClient().from("reconciliation_records").update(patch).eq("tenant_id", tenantId).eq("id", row.id);
      if (updateError) throw updateError;
      setNotice("Reconciliation status updated. Keep the source statement and approval evidence with your accounting records.");
      await load();
    } catch (e) { setError(e instanceof Error ? e.message : "Status could not be updated."); }
    finally { setSaving(false); }
  }

  function exportCsv() {
    const data = [["provider", "period_start", "period_end", "expected_amount", "actual_amount", "difference_amount", "status", "notes", "reconciled_at"],
      ...filtered.map((r) => [r.provider, r.period_start, r.period_end, r.expected_amount, r.actual_amount, r.difference_amount, r.status, r.notes, r.reconciled_at])]
      .map((line) => line.map(csv).join(",")).join("\r\n");
    const url = URL.createObjectURL(new Blob(["\ufeff" + data], { type: "text/csv;charset=utf-8" }));
    const a = document.createElement("a"); a.href = url; a.download = "gold-reconciliation-" + today() + ".csv"; a.click(); URL.revokeObjectURL(url);
  }

  return <main><div className="page-wrap">
    <Link className="link-text small" href="/reports"><ArrowLeft size={13} style={{ display: "inline", verticalAlign: "middle" }} /> Back to reports</Link>
    <div style={{ marginTop: 20, marginBottom: 24 }}>
      <div className="eyebrow"><Scale size={14} /> Finance controls</div>
      <h1 style={{ marginTop: 12 }}>Payment reconciliation</h1>
      <p className="lead">Record expected ledger totals and compare them with a provider or bank statement. This is a manual reconciliation register; it does not fetch statements or verify provider payouts automatically.</p>
    </div>
    {error && <div role="alert" className="notice" style={{ marginBottom: 14 }}><CircleAlert size={16} /> {error}</div>}
    {notice && <div role="status" className="notice" style={{ marginBottom: 14, color: "#1f5c3e", background: "#edf7ef", borderColor: "#cfe4d4" }}>{notice}</div>}
    {loading ? <section className="panel">Loading permissions…</section> : memberships.length === 0 ? <section className="panel"><h2>No shop linked</h2><Link href="/onboarding" className="btn btn-primary">Set up your shop</Link></section> : <>
      <section className="panel" style={{ marginBottom: 18 }}>
        <div className="field" style={{ maxWidth: 460 }}><label htmlFor="reconciliation-shop">Shop</label>
          <select id="reconciliation-shop" value={tenantId} onChange={(e) => setTenantId(e.target.value)}>{memberships.map((m) => <option key={m.tenant_id} value={m.tenant_id}>{m.tenants?.display_name ?? m.tenant_id}</option>)}</select>
        </div>
        {!canManage && <p className="small muted" style={{ marginBottom: 0 }}>Reconciliation is restricted to shop owners, managers and accountants.</p>}
      </section>
      {canManage && <section className="panel" style={{ marginBottom: 18 }}>
        <h2>New reconciliation period</h2>
        <form onSubmit={createRecord}>
          <div className="form-grid">
            <div className="field"><label htmlFor="provider">Payment provider / bank</label><input id="provider" value={provider} onChange={(e) => setProvider(e.target.value)} maxLength={100} placeholder="Razorpay, cash book, bank…" /></div>
            <div className="field"><label htmlFor="recon-start">Period start</label><input id="recon-start" type="date" value={periodStart} onChange={(e) => setPeriodStart(e.target.value)} required /></div>
            <div className="field"><label htmlFor="recon-end">Period end</label><input id="recon-end" type="date" value={periodEnd} onChange={(e) => setPeriodEnd(e.target.value)} min={periodStart} required /></div>
            <div className="field"><label htmlFor="expected">Expected ledger amount (₹)</label><input id="expected" type="number" min="0" step="0.01" value={expected} onChange={(e) => setExpected(e.target.value)} required /></div>
            <div className="field"><label htmlFor="actual">Actual statement amount (₹)</label><input id="actual" type="number" min="0" step="0.01" value={actual} onChange={(e) => setActual(e.target.value)} required /></div>
            <div className="field"><label htmlFor="difference">Difference: expected − actual</label><input id="difference" value={inr(previewDifference)} readOnly /></div>
          </div>
          <div className="field" style={{ marginTop: 12 }}><label htmlFor="recon-notes">Evidence / investigation notes</label><textarea id="recon-notes" rows={3} value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={4000} placeholder="Statement reference, transfer IDs, mismatch explanation…" /></div>
          <button className="btn btn-primary" style={{ marginTop: 14 }} type="submit" disabled={saving}>{saving ? "Saving…" : "Save reconciliation record"}</button>
        </form>
      </section>}
      <section className="panel">
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}><h2>Reconciliation register</h2>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}><select aria-label="Filter reconciliation status" value={filter} onChange={(e) => setFilter(e.target.value)}><option value="all">All statuses</option><option value="open">Open</option><option value="investigating">Investigating</option><option value="matched">Matched</option><option value="resolved">Resolved</option></select><button className="btn btn-secondary" type="button" onClick={() => void load()}><RefreshCw size={15} /> Refresh</button><button className="btn btn-secondary" type="button" onClick={exportCsv}><Download size={15} /> Export CSV</button></div>
        </div>
        {filtered.length === 0 ? <p className="muted" style={{ marginTop: 16 }}>No records match this filter.</p> : <div style={{ display: "grid", gap: 12, marginTop: 14 }}>
          {filtered.map((row) => <article key={row.id} style={{ border: "1px solid var(--line)", borderRadius: 13, padding: 14, overflowWrap: "anywhere" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "start", gap: 12, flexWrap: "wrap" }}><div><strong>{row.provider || "Provider / bank"}</strong><div className="small muted">{row.period_start} → {row.period_end}</div></div><span className="pill">{row.status}</span></div>
            <div className="breakdown-row"><span>Expected</span><strong>{inr(Number(row.expected_amount))}</strong></div><div className="breakdown-row"><span>Statement</span><strong>{inr(Number(row.actual_amount))}</strong></div><div className="breakdown-row total"><span>Difference</span><strong>{inr(Number(row.difference_amount ?? Number(row.expected_amount)-Number(row.actual_amount)))}</strong></div>
            {row.notes && <p className="small muted" style={{ marginTop: 10, marginBottom: 0, whiteSpace: "pre-wrap" }}>{row.notes}</p>}
            <p className="small muted" style={{ marginTop: 10, marginBottom: 0 }}>Created {new Date(row.created_at).toLocaleString("en-IN")}{row.reconciled_at ? " · Reviewed " + new Date(row.reconciled_at).toLocaleString("en-IN") : ""}</p>
            {canManage && row.status !== "resolved" && <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: 12 }}>
              {row.status !== "investigating" && <button className="btn btn-secondary" type="button" disabled={saving} onClick={() => void setStatus(row, "investigating")}>Investigating</button>}
              {row.status !== "matched" && <button className="btn btn-secondary" type="button" disabled={saving} onClick={() => void setStatus(row, "matched")}>Mark matched</button>}
              <button className="btn btn-primary" type="button" disabled={saving} onClick={() => void setStatus(row, "resolved")}>Resolve</button>
            </div>}
          </article>)}
        </div>}
      </section>
    </>}
  </div></main>;
}
