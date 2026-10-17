"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowLeft, CircleAlert, PlugZap, RefreshCw, ShieldCheck } from "lucide-react";
import { createClient } from "@/lib/supabase/client";

type Membership = { tenant_id: string; role: string; tenants: { display_name: string; slug: string } | null };
type Integration = { key: string; name: string; category: string; configured: boolean; workflow: string };
type StatusResponse = { tenantId: string; checkedAt: string; integrations: Integration[]; error?: string };

export default function IntegrationsPage() {
  const router = useRouter();
  const [memberships, setMemberships] = useState<Membership[]>([]);
  const [tenantId, setTenantId] = useState("");
  const [statuses, setStatuses] = useState<Integration[]>([]);
  const [checkedAt, setCheckedAt] = useState("");
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
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
        const rows = (data ?? []) as unknown as Membership[];
        setMemberships(rows); setTenantId(rows[0]?.tenant_id ?? "");
      } catch { if (active) setError("Integration access could not be loaded."); }
      finally { if (active) setLoading(false); }
    })();
    return () => { active = false; };
  }, [router]);

  const load = useCallback(async () => {
    if (!tenantId) { setStatuses([]); return; }
    setError(""); setRefreshing(true);
    try {
      const response = await fetch("/api/integrations/status?tenantId=" + encodeURIComponent(tenantId), { cache: "no-store" });
      const body = await response.json() as StatusResponse;
      if (!response.ok) throw new Error(body.error ?? "Integration status could not be checked.");
      setStatuses(body.integrations ?? []); setCheckedAt(body.checkedAt);
    } catch (e) { setError(e instanceof Error ? e.message : "Integration status could not be checked."); }
    finally { setRefreshing(false); }
  }, [tenantId]);
  useEffect(() => { void load(); }, [load]);

  const current = memberships.find((m) => m.tenant_id === tenantId);
  const canView = ["owner", "manager"].includes(current?.role ?? "");
  return <main><div className="page-wrap">
    <Link className="link-text small" href="/dashboard"><ArrowLeft size={13} style={{ display: "inline", verticalAlign: "middle" }} /> Back to workspace</Link>
    <div style={{ marginTop: 20, marginBottom: 24 }}>
      <div className="eyebrow"><PlugZap size={14} /> System configuration</div>
      <h1 style={{ marginTop: 12 }}>Integrations & service health</h1>
      <p className="lead">Check whether server-side credentials are configured without exposing their values. “Configured” does not necessarily mean a provider has been tested or that delivery/fetch jobs are running.</p>
    </div>
    {error && <div role="alert" className="notice" style={{ marginBottom: 14 }}><CircleAlert size={16} /> {error}</div>}
    {loading ? <section className="panel">Checking access…</section> : memberships.length === 0 ? <section className="panel"><h2>No shop linked</h2><Link className="btn btn-primary" href="/onboarding">Set up your shop</Link></section> : <>
      <section className="panel" style={{ marginBottom: 18 }}>
        <div className="field" style={{ maxWidth: 460 }}><label htmlFor="integration-shop">Shop</label>
          <select id="integration-shop" value={tenantId} onChange={(e) => setTenantId(e.target.value)}>{memberships.map((m) => <option key={m.tenant_id} value={m.tenant_id}>{m.tenants?.display_name ?? m.tenant_id}</option>)}</select>
        </div>
        {!canView && <p className="small muted">Integration settings are restricted to shop owners and managers.</p>}
        <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap", marginTop: 12 }}>
          <button className="btn btn-secondary" type="button" onClick={() => void load()} disabled={refreshing || !canView}><RefreshCw size={15} /> {refreshing ? "Checking…" : "Re-check readiness"}</button>
          {checkedAt && <span className="small muted">Checked {new Date(checkedAt).toLocaleString("en-IN")}</span>}
        </div>
      </section>
      {canView && <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 300px), 1fr))", gap: 14 }}>
        {statuses.map((item) => <article className="panel" key={item.key}>
          <div style={{ display: "flex", alignItems: "start", justifyContent: "space-between", gap: 12 }}>
            <div><span className="eyebrow">{item.category}</span><h2 style={{ marginTop: 8 }}>{item.name}</h2></div>
            <span className="pill" style={{ background: item.configured ? "#edf7ef" : "#fff4df", color: item.configured ? "#1f5c3e" : "#835714", borderColor: item.configured ? "#cfe4d4" : "#ecd8ae" }}>{item.configured ? "Credentials set" : "Not configured"}</span>
          </div>
          <p className="small muted" style={{ marginTop: 12 }}>{item.workflow}</p>
          {item.configured && item.key === "razorpay" && <p className="small" style={{ marginBottom: 0 }}>Next: test a successful capture, duplicate webhook, failed payment and refund on Razorpay test mode.</p>}
        </article>)}
      </div>}
      <section className="panel" style={{ marginTop: 18 }}>
        <h2>Setup and security</h2>
        <p className="small muted">Provider secrets belong in the Vercel/server environment, never in browser storage or shop-facing database rows. Provider setup instructions are in the repository&apos;s environment template and integration runbooks.</p>
        <p><Link className="link-text" href="https://github.com/cva121997-source/gold/blob/main/.env.example" target="_blank">Review environment variable names</Link> · <Link className="link-text" href="https://github.com/cva121997-source/gold/blob/main/docs/PAYMENTS_RAZORPAY.md" target="_blank">Razorpay runbook</Link></p>
        <p className="small muted" style={{ marginBottom: 0 }}><ShieldCheck size={15} style={{ display: "inline", verticalAlign: "middle" }} /> This page only returns boolean readiness flags; it never returns any secret values.</p>
      </section>
    </>}
  </div></main>;
}
