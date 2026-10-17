"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowLeft, Download, History, RefreshCw, Search, ShieldCheck } from "lucide-react";
import { createClient } from "@/lib/supabase/client";

type Membership = { tenant_id: string; role: string; tenants: { display_name: string; slug: string } | null };
type AuditRow = { id: number; tenant_id: string | null; actor_user_id: string | null; event_name: string; entity_type: string | null; entity_id: string | null; details: Record<string, unknown>; created_at: string };
const stamp = (value: string) => new Date(value).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" });
const csvCell = (value: unknown) => '"' + String(value ?? "").replaceAll('"', '""') + '"';

export default function AuditLogsPage() {
  const router = useRouter();
  const [memberships, setMemberships] = useState<Membership[]>([]);
  const [tenantId, setTenantId] = useState("");
  const [rows, setRows] = useState<AuditRow[]>([]);
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const supabase = createClient();
        const { data: { user } } = await supabase.auth.getUser();
        if (!user) { router.replace("/login"); return; }
        const { data, error: e } = await supabase.from("tenant_memberships").select("tenant_id,role,tenants(display_name,slug)").eq("user_id", user.id).eq("is_active", true);
        if (e) throw e;
        if (!active) return;
        const list = (data ?? []) as unknown as Membership[];
        setMemberships(list); setTenantId(list[0]?.tenant_id ?? "");
      } catch { if (active) setError("Audit access could not be loaded. Sign in with a shop account."); }
      finally { if (active) setLoading(false); }
    })();
    return () => { active = false; };
  }, [router]);

  const load = useCallback(async () => {
    if (!tenantId) { setRows([]); return; }
    setError("");
    const { data, error: queryError } = await createClient().from("audit_logs")
      .select("id,tenant_id,actor_user_id,event_name,entity_type,entity_id,details,created_at")
      .eq("tenant_id", tenantId).order("created_at", { ascending: false }).limit(1000);
    if (queryError) { setRows([]); setError("Audit records are restricted to shop owners and managers."); return; }
    setRows((data ?? []) as AuditRow[]);
  }, [tenantId]);
  useEffect(() => { void load(); }, [load]);

  const current = memberships.find((m) => m.tenant_id === tenantId);
  const canRead = ["owner", "manager"].includes(current?.role ?? "");
  const filtered = useMemo(() => {
    const term = search.trim().toLowerCase();
    if (!term) return rows;
    return rows.filter((row) => [row.event_name, row.entity_type, row.entity_id, row.actor_user_id, JSON.stringify(row.details)].some((value) => String(value ?? "").toLowerCase().includes(term)));
  }, [rows, search]);

  function exportCsv() {
    const header = ["id", "created_at", "event_name", "entity_type", "entity_id", "actor_user_id", "details"];
    const contents = [header, ...filtered.map((row) => [row.id, row.created_at, row.event_name, row.entity_type, row.entity_id, row.actor_user_id, JSON.stringify(row.details)])]
      .map((line) => line.map(csvCell).join(",")).join("\r\n");
    const url = URL.createObjectURL(new Blob(["\ufeff" + contents], { type: "text/csv;charset=utf-8" }));
    const anchor = document.createElement("a"); anchor.href = url; anchor.download = "gold-audit-log-" + new Date().toISOString().slice(0, 10) + ".csv"; anchor.click();
    URL.revokeObjectURL(url);
  }

  return <main><div className="page-wrap">
    <Link className="link-text small" href="/dashboard"><ArrowLeft size={13} style={{ display: "inline", verticalAlign: "middle" }} /> Back to workspace</Link>
    <div style={{ marginTop: 20, marginBottom: 24 }}>
      <div className="eyebrow"><History size={14} /> Governance & controls</div>
      <h1 style={{ marginTop: 12 }}>Audit log</h1>
      <p className="lead">Read-only business event history for rates, scheme terms, enrolments, payment confirmation, refunds, redemptions and other audited operations.</p>
    </div>
    {error && <div role="alert" className="notice" style={{ marginBottom: 14 }}>{error}</div>}
    {loading ? <section className="panel">Checking audit access…</section> : memberships.length === 0 ? <section className="panel"><h2>No shop linked</h2><Link className="btn btn-primary" href="/onboarding">Set up your shop</Link></section> : <>
      <section className="panel" style={{ marginBottom: 18 }}>
        <div className="field" style={{ maxWidth: 460 }}><label htmlFor="audit-tenant">Shop</label>
          <select id="audit-tenant" value={tenantId} onChange={(e) => setTenantId(e.target.value)}>{memberships.map((m) => <option key={m.tenant_id} value={m.tenant_id}>{m.tenants?.display_name ?? m.tenant_id}</option>)}</select>
        </div>
        {!canRead && <p className="small muted">Audit events contain sensitive operational details; access is limited to the owner and manager.</p>}
        <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap", marginTop: 14 }}>
          <div className="field" style={{ flex: "1 1 260px" }}><label htmlFor="audit-search"><Search size={14} style={{ display: "inline", verticalAlign: "middle" }} /> Search audit events</label><input id="audit-search" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Event, entity ID or details…" /></div>
          <button className="btn btn-secondary" type="button" onClick={() => void load()} disabled={!canRead}><RefreshCw size={15} /> Refresh</button>
          <button className="btn btn-primary" type="button" onClick={exportCsv} disabled={!canRead || filtered.length === 0}><Download size={15} /> Export CSV</button>
        </div>
      </section>
      {canRead && <section className="panel">
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
          <h2>Business events</h2><span className="small muted">{filtered.length} of {rows.length} events loaded · latest 1,000</span>
        </div>
        {filtered.length === 0 ? <p className="muted" style={{ marginTop: 16 }}>No audit events match this filter.</p> : <div style={{ display: "grid", gap: 10, marginTop: 14 }}>
          {filtered.map((row) => <article key={row.id} style={{ border: "1px solid var(--line, #ded8cd)", borderRadius: 12, padding: 13, minWidth: 0 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "start", gap: 12, flexWrap: "wrap" }}>
              <div><strong>{row.event_name.replaceAll(".", " · ")}</strong><div className="small muted">{row.entity_type ?? "event"}{row.entity_id ? " · " + row.entity_id : ""}</div></div>
              <time className="small muted">{stamp(row.created_at)}</time>
            </div>
            <details style={{ marginTop: 10 }}><summary className="small" style={{ cursor: "pointer" }}>Event details</summary>
              <pre style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere", fontSize: 12, background: "var(--surface-muted, #f7f4ee)", borderRadius: 8, padding: 12 }}>{JSON.stringify(row.details ?? {}, null, 2)}</pre>
            </details>
            <p className="small muted" style={{ marginBottom: 0 }}>Actor: {row.actor_user_id ?? "system / integration"} · Record #{row.id}</p>
          </article>)}
        </div>}
      </section>}
      <section className="panel" style={{ marginTop: 18 }}><p className="small muted" style={{ margin: 0 }}><ShieldCheck size={15} style={{ display: "inline", verticalAlign: "middle" }} /> This page is read-only. Financial corrections should use approved refund, reversal or credit-note workflows rather than editing the original record.</p></section>
    </>}
  </div></main>;
}
