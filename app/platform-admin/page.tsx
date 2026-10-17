"use client";

import Link from "next/link";
import { FormEvent, useCallback, useEffect, useState } from "react";
import { ArrowLeft, Building2, CircleAlert, Plus, RefreshCw, ShieldCheck } from "lucide-react";

type Subscription = {
  status: string;
  trial_ends_at: string | null;
  current_period_end: string | null;
  subscription_plans: { code: string; name: string; monthly_price_inr: number; annual_price_inr: number } | null;
};
type Tenant = {
  id: string; code: string; slug: string; legal_name: string | null; display_name: string; status: string;
  state: string | null; district: string | null; city: string | null; locality: string | null; created_at: string;
  tenant_subscriptions: Subscription[] | Subscription | null;
};
type Stats = { total: number; active: number; trial: number; suspended: number; cancelled: number };
type ApiData = { adminRole: string; tenants: Tenant[]; stats: Stats };
const emptyStats: Stats = { total: 0, active: 0, trial: 0, suspended: 0, cancelled: 0 };

export default function PlatformAdminPage() {
  const [data, setData] = useState<ApiData | null>(null);
  const [loading, setLoading] = useState(true);
  const [busyTenant, setBusyTenant] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [newShop, setNewShop] = useState(false);
  const [saving, setSaving] = useState(false);
  const [shopName, setShopName] = useState("");
  const [legalName, setLegalName] = useState("");
  const [ownerName, setOwnerName] = useState("");
  const [ownerEmail, setOwnerEmail] = useState("");
  const [slug, setSlug] = useState("");
  const [stateName, setStateName] = useState("Tamil Nadu");
  const [district, setDistrict] = useState("");
  const [city, setCity] = useState("");
  const [locality, setLocality] = useState("");

  const load = useCallback(async () => {
    setError("");
    try {
      const response = await fetch("/api/platform-admin/tenants", { cache: "no-store" });
      const body = await response.json() as ApiData & { error?: string };
      if (!response.ok) { setData(null); setError(body.error ?? "Platform tenant list could not be loaded."); return; }
      setData(body);
    } catch { setError("Unable to contact the platform administration API."); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  function changeShopName(value: string) {
    setShopName(value);
    setSlug(value.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60));
  }

  async function changeStatus(tenant: Tenant, status: string) {
    setError(""); setNotice(""); setBusyTenant(tenant.id);
    try {
      const response = await fetch("/api/platform-admin/tenants", {
        method: "PATCH", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tenantId: tenant.id, status })
      });
      const body = await response.json() as { error?: string; warning?: string };
      if (!response.ok) { setError(body.error ?? "Tenant status update failed."); return; }
      setNotice(body.warning ?? ("Tenant status changed to " + status + "."));
      await load();
    } catch { setError("Unable to update the shop status."); }
    finally { setBusyTenant(""); }
  }

  async function createShop(e: FormEvent<HTMLFormElement>) {
    e.preventDefault(); setError(""); setNotice(""); setSaving(true);
    try {
      const response = await fetch("/api/platform-admin/tenants", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ shopName, legalName, ownerName, ownerEmail, slug, state: stateName, district, city, locality })
      });
      const body = await response.json() as { error?: string; detail?: string; message?: string };
      if (!response.ok) { setError([body.error, body.detail].filter(Boolean).join(" ")); return; }
      setNotice(body.message ?? "Shop created.");
      setNewShop(false); setShopName(""); setLegalName(""); setOwnerName(""); setOwnerEmail(""); setSlug(""); setDistrict(""); setCity(""); setLocality("");
      await load();
    } catch { setError("Unable to create the shop. Check server configuration and email provider settings."); }
    finally { setSaving(false); }
  }

  const stats = data?.stats ?? emptyStats;
  const canManage = data ? ["platform_owner", "platform_admin"].includes(data.adminRole) : false;
  const subscriptionOf = (tenant: Tenant) =>
    Array.isArray(tenant.tenant_subscriptions) ? tenant.tenant_subscriptions[0] ?? null : tenant.tenant_subscriptions;

  return <main><div className="page-wrap">
    <Link className="link-text small" href="/dashboard"><ArrowLeft size={13} style={{ display: "inline", verticalAlign: "middle" }} /> Back to shop workspace</Link>
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 14, flexWrap: "wrap", marginTop: 20, marginBottom: 24 }}>
      <div><div className="eyebrow"><ShieldCheck size={14} /> Platform administration</div><h1 style={{ marginTop: 12 }}>Gold SaaS control center</h1><p className="lead">Manage registered jewellery tenants, trials, activation and suspension. Access is verified against a server-side platform-admin record.</p></div>
      <div className="action-row" style={{ marginTop: 0 }}><button className="btn btn-secondary" type="button" onClick={() => void load()}><RefreshCw size={14} /> Refresh</button>{canManage && <button className="btn btn-primary" type="button" onClick={() => setNewShop(v => !v)}><Plus size={15} /> Register shop</button>}</div>
    </div>
    {error && <div role="alert" className="notice" style={{ marginBottom: 14 }}><CircleAlert size={16} /><span>{error}</span></div>}
    {notice && <div className="notice" style={{ marginBottom: 14, color: "#1f5c3e", background: "#edf7ef", borderColor: "#cfe4d4" }}>{notice}</div>}

    {newShop && canManage && <section className="panel" style={{ marginBottom: 18 }}>
      <h2>Register a shop and invite its owner</h2>
      <p className="small muted">This workflow requires the server-only service key, Supabase Auth email delivery, and an allowed redirect URL.</p>
      <form onSubmit={createShop}><div className="form-grid">
        <div className="field"><label htmlFor="shopName">Shop display name *</label><input id="shopName" value={shopName} onChange={e => changeShopName(e.target.value)} required minLength={2} maxLength={120} /></div>
        <div className="field"><label htmlFor="slug">Unique shop slug *</label><input id="slug" value={slug} onChange={e => setSlug(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ""))} required pattern="[a-z0-9]+(-[a-z0-9]+)*" maxLength={60} /></div>
        <div className="field"><label htmlFor="ownerName">Shop owner's name *</label><input id="ownerName" value={ownerName} onChange={e => setOwnerName(e.target.value)} required minLength={2} /></div>
        <div className="field"><label htmlFor="ownerEmail">Owner email *</label><input id="ownerEmail" type="email" value={ownerEmail} onChange={e => setOwnerEmail(e.target.value)} required /></div>
        <div className="field"><label htmlFor="legalName">Legal business name</label><input id="legalName" value={legalName} onChange={e => setLegalName(e.target.value)} /></div>
        <div className="field"><label htmlFor="stateName">State</label><input id="stateName" value={stateName} onChange={e => setStateName(e.target.value)} /></div>
        <div className="field"><label htmlFor="district">District</label><input id="district" value={district} onChange={e => setDistrict(e.target.value)} /></div>
        <div className="field"><label htmlFor="city">City</label><input id="city" value={city} onChange={e => setCity(e.target.value)} /></div>
        <div className="field"><label htmlFor="locality">Locality / market</label><input id="locality" value={locality} onChange={e => setLocality(e.target.value)} /></div>
      </div><div className="action-row"><button className="btn btn-primary" type="submit" disabled={saving}>{saving ? "Inviting owner…" : "Create tenant and invite owner"}</button><button className="btn btn-secondary" type="button" onClick={() => setNewShop(false)}>Cancel</button></div></form>
    </section>}

    {loading ? <div className="panel">Verifying platform access and loading tenants…</div> : !data ? <div className="panel"><div className="feature-icon"><ShieldCheck size={21} /></div><h2>Platform access unavailable</h2><p className="muted" style={{ lineHeight: 1.7 }}>{error || "This account is not configured as a platform administrator, or the server service key is missing."}</p><p className="small muted">For initial setup, create the user in Supabase Auth, then have an authorised project owner add that exact Auth user ID to public.platform_admins in the SQL Editor. Configure SUPABASE_SERVICE_ROLE_KEY only in server environment settings.</p></div> : <>
      <div className="dashboard-grid">
        <div className="metric-card"><div className="small muted">Registered shops (max 500)</div><div className="metric-value">{stats.total}</div></div>
        <div className="metric-card"><div className="small muted">Active</div><div className="metric-value">{stats.active}</div></div>
        <div className="metric-card"><div className="small muted">Trial</div><div className="metric-value">{stats.trial}</div></div>
        <div className="metric-card"><div className="small muted">Suspended</div><div className="metric-value">{stats.suspended}</div></div>
        <div className="metric-card"><div className="small muted">Cancelled</div><div className="metric-value">{stats.cancelled}</div></div>
        <div className="metric-card"><div className="small muted">Your platform role</div><div className="metric-value" style={{ fontSize: 20 }}>{data.adminRole.replaceAll("_", " ")}</div></div>
      </div>
      <section className="panel" style={{ marginTop: 18 }}><div className="section-head" style={{ marginTop: 0 }}><div><h2>Tenant management</h2><p className="small muted">Status changes are written to the platform audit log.</p></div></div>
        {data.tenants.length === 0 ? <p className="small muted">No shops registered yet.</p> : <div style={{ display: "grid", gap: 12 }}>{data.tenants.map(t => {
          const sub = subscriptionOf(t);
          return <article className="list-card" key={t.id} style={{ display: "block" }}>
            <div style={{ display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}><div style={{ display: "flex", gap: 12, alignItems: "flex-start" }}><div className="feature-icon" style={{ marginBottom: 0, flexShrink: 0 }}><Building2 size={19} /></div><div><strong>{t.display_name}</strong><div className="small muted" style={{ marginTop: 4 }}>{t.slug} · Shop code {t.code}</div><div className="small muted" style={{ marginTop: 4 }}>{[t.locality, t.city, t.district, t.state].filter(Boolean).join(", ") || "Location not specified"}</div><div className="small muted" style={{ marginTop: 4 }}>Created {new Date(t.created_at).toLocaleDateString("en-IN")} · Plan {sub?.subscription_plans?.name ?? "—"} · Subscription {sub?.status ?? "—"}</div>{sub?.trial_ends_at && <div className="small muted">Trial ends {new Date(sub.trial_ends_at).toLocaleDateString("en-IN")}</div>}</div></div><span className={"pill " + (t.status === "active" ? "pill-green" : "pill-demo")}>{t.status}</span></div>
            {canManage && <div className="action-row" style={{ marginTop: 12 }}>{(["trial", "active", "suspended", "cancelled"] as const).filter(s => s !== t.status).map(s => <button key={s} className="btn btn-secondary" type="button" disabled={busyTenant === t.id} onClick={() => void changeStatus(t, s)}>{busyTenant === t.id ? "Updating…" : "Set " + s}</button>)}</div>}
          </article>;
        })}</div>}
      </section>
    </>}
    <div className="notice" style={{ marginTop: 18 }}><ShieldCheck size={15} style={{ flexShrink: 0 }} /><span>The browser never receives the service-role key. If the initial platform-admin record or server key is missing, this page remains inaccessible.</span></div>
  </div></main>;
}
