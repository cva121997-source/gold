"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowLeft, CircleAlert, Clock3, Plus, RefreshCw } from "lucide-react";
import { createClient } from "@/lib/supabase/client";

type Membership = { tenant_id: string; branch_id: string | null; role: string; tenants: { display_name: string; slug: string } | null };
type Metal = { id: number; code: string; name: string };
type Purity = { id: number; metal_id: number; code: string; label: string; fineness: number };
type RateRow = { id: string; tenant_id: string; metal_id: number; purity_id: number; price_per_gram: number; state: string | null; district: string | null; city: string | null; locality: string | null; source_type: string; source_label: string | null; status: string; is_public: boolean; effective_at: string };

export default function RatesPage() {
  const router = useRouter();
  const [memberships, setMemberships] = useState<Membership[]>([]);
  const [tenantId, setTenantId] = useState("");
  const [metals, setMetals] = useState<Metal[]>([]);
  const [purities, setPurities] = useState<Purity[]>([]);
  const [rates, setRates] = useState<RateRow[]>([]);
  const [metalId, setMetalId] = useState("");
  const [purityId, setPurityId] = useState("");
  const [price, setPrice] = useState("");
  const [publicOnBoard, setPublicOnBoard] = useState(false);
  const [stateName, setStateName] = useState("Tamil Nadu");
  const [district, setDistrict] = useState("");
  const [city, setCity] = useState("");
  const [locality, setLocality] = useState("");
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
        const [membershipResult, metalResult, purityResult] = await Promise.all([
          supabase.from("tenant_memberships").select("tenant_id, branch_id, role, tenants(display_name, slug)").eq("user_id", user.id).eq("is_active", true),
          supabase.from("metals").select("id, code, name").eq("is_active", true).order("id"),
          supabase.from("purity_definitions").select("id, metal_id, code, label, fineness").eq("is_active", true).order("fineness", { ascending: false })
        ]);
        if (!alive) return;
        if (membershipResult.error) throw membershipResult.error;
        if (metalResult.error) throw metalResult.error;
        if (purityResult.error) throw purityResult.error;
        const memberRows = (membershipResult.data ?? []) as unknown as Membership[];
        const metalRows = (metalResult.data ?? []) as Metal[];
        setMemberships(memberRows); setMetals(metalRows); setPurities((purityResult.data ?? []) as Purity[]);
        setTenantId(memberRows[0]?.tenant_id ?? "");
        setMetalId(String(metalRows.find((m) => m.code === "gold")?.id ?? metalRows[0]?.id ?? ""));
      } catch {
        if (alive) setError("Could not load rates. Check the Supabase configuration and apply the Gold database migration.");
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => { alive = false; };
  }, [router]);

  const selectedMembership = memberships.find((m) => m.tenant_id === tenantId);
  const canManage = selectedMembership?.role === "owner" || selectedMembership?.role === "manager";
  const availablePurities = useMemo(() => purities.filter((p) => String(p.metal_id) === metalId), [purities, metalId]);

  useEffect(() => {
    if (!availablePurities.some((p) => String(p.id) === purityId)) setPurityId(String(availablePurities[0]?.id ?? ""));
  }, [availablePurities, purityId]);

  const loadRates = useCallback(async () => {
    if (!tenantId) { setRates([]); return; }
    const supabase = createClient();
    const { data, error: queryError } = await supabase.from("gold_rates")
      .select("id, tenant_id, metal_id, purity_id, price_per_gram, state, district, city, locality, source_type, source_label, status, is_public, effective_at")
      .eq("tenant_id", tenantId).order("effective_at", { ascending: false }).limit(30);
    if (queryError) { setError("Could not read the shop rate history. Confirm migration and read permissions."); return; }
    setRates((data ?? []) as RateRow[]);
  }, [tenantId]);

  useEffect(() => { void loadRates(); }, [loadRates]);

  async function saveRate(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault(); setError(""); setNotice("");
    if (!tenantId || !metalId || !purityId || !Number.isFinite(Number(price)) || Number(price) <= 0) {
      setError("Select a shop, metal and purity, then enter a price greater than zero."); return;
    }
    setSaving(true);
    try {
      const supabase = createClient();
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) { router.replace("/login"); return; }
      const { error: insertError } = await supabase.from("gold_rates").insert({
        tenant_id: tenantId, branch_id: memberships.find((m) => m.tenant_id === tenantId)?.branch_id ?? null, metal_id: Number(metalId), purity_id: Number(purityId),
        price_per_gram: Number(Number(price).toFixed(2)), state: stateName.trim() || null,
        district: district.trim() || null, city: city.trim() || null, locality: locality.trim() || null,
        source_type: "manual", source_label: "Manual rate entered by shop staff", status: "verified", is_public: publicOnBoard,
        effective_at: new Date().toISOString(), updated_by: user.id
      });
      if (insertError) { setError("Rate not saved. Only shop owners and managers can publish rates; check the selected shop permissions."); return; }
      setPrice(""); setPublicOnBoard(false); setNotice("Rate saved with a timestamp. The previous rate remains in history.");
      await loadRates();
    } catch {
      setError("Could not save this rate. Check your connection and shop access.");
    } finally { setSaving(false); }
  }

  const money = (n: number) => new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 2 }).format(Number(n));
  const labelFor = (rate: RateRow) => {
    const metal = metals.find((m) => m.id === rate.metal_id)?.name ?? "Metal";
    const purity = purities.find((p) => p.id === rate.purity_id)?.label ?? "Purity";
    return metal + " · " + purity;
  };

  return <main><div className="page-wrap">
    <Link className="link-text small" href="/dashboard"><ArrowLeft size={13} style={{ display: "inline", verticalAlign: "middle" }} /> Back to workspace</Link>
    <div style={{ marginTop: 20, marginBottom: 24 }}><div className="eyebrow">Local price management</div><h1 style={{ marginTop: 12 }}>Gold rates</h1><p className="lead">Enter authorised shop rates by metal, purity and locality. Each save creates a historical snapshot instead of overwriting yesterday’s quote.</p></div>
    {error && <div role="alert" className="notice" style={{ marginBottom: 16 }}><CircleAlert size={16} style={{ flexShrink: 0 }} /><span>{error}</span></div>}
    {notice && <div className="notice" style={{ marginBottom: 16, color: "#1f5c3e", background: "#edf7ef", borderColor: "#cfe4d4" }}><RefreshCw size={15} style={{ flexShrink: 0 }} /><span>{notice}</span></div>}
    {loading ? <div className="panel">Loading shop rate settings…</div> : <div className="calc-layout">
      <section className="panel">
        <h2>Publish a manual rate</h2><p className="small muted">This rate is identified as manually entered. No live market provider is connected yet.</p>
        {memberships.length > 1 && <div className="field" style={{ marginBottom: 15 }}><label htmlFor="tenant">Shop</label><select id="tenant" value={tenantId} onChange={(e) => setTenantId(e.target.value)}>{memberships.map((m) => <option key={m.tenant_id} value={m.tenant_id}>{m.tenants?.display_name ?? m.tenant_id}</option>)}</select></div>}
        {memberships.length === 0 ? <div className="notice"><CircleAlert size={16} /> No shop membership found. <Link className="link-text" href="/onboarding">Set up your shop</Link> first.</div> : canManage ? <form onSubmit={saveRate}>
          <div className="form-grid">
            <div className="field"><label htmlFor="metal">Metal</label><select id="metal" value={metalId} onChange={(e) => setMetalId(e.target.value)}>{metals.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}</select></div>
            <div className="field"><label htmlFor="purity">Purity</label><select id="purity" value={purityId} onChange={(e) => setPurityId(e.target.value)}>{availablePurities.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}</select></div>
            <div className="field"><label htmlFor="price">Price per gram (₹)</label><input id="price" type="number" min="0.01" step="0.01" value={price} onChange={(e) => setPrice(e.target.value)} required /></div>
            <div className="field"><label htmlFor="stateName">State</label><input id="stateName" value={stateName} onChange={(e) => setStateName(e.target.value)} /></div>
            <div className="field"><label htmlFor="district">District</label><input id="district" value={district} onChange={(e) => setDistrict(e.target.value)} /></div>
            <div className="field"><label htmlFor="city">City or town</label><input id="city" value={city} onChange={(e) => setCity(e.target.value)} /></div>
            <div className="field"><label htmlFor="locality">Locality or market</label><input id="locality" value={locality} onChange={(e) => setLocality(e.target.value)} /></div>
          </div>
          <label style={{display:"flex",gap:9,alignItems:"flex-start",fontSize:12,lineHeight:1.5,marginTop:14}}><input type="checkbox" checked={publicOnBoard} onChange={e=>setPublicOnBoard(e.target.checked)}/><span>Publish this rate on the public shop rate board. The public board will mark old/non-verified rates as stale rather than presenting them as live.</span></label><button className="btn btn-primary" type="submit" disabled={saving} style={{ width: "100%", marginTop: 20 }}>{saving ? "Saving rate…" : <><Plus size={15} /> Save rate snapshot</>}</button>
        </form> : <div className="notice">You can view rate history, but publishing rates requires an owner or manager role.</div>}
      </section>
      <section className="panel">
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10 }}><div><h2>Recent rate history</h2><p className="small muted">Newest first · India Standard Time</p></div><button type="button" className="btn btn-secondary" onClick={() => void loadRates()}><RefreshCw size={14} /> Refresh</button></div>
        {rates.length === 0 ? <p className="muted small">No rates have been entered for this shop yet.</p> : <div style={{ display: "grid", gap: 10 }}>{rates.map((rate) => <article className="list-card" key={rate.id} style={{ alignItems: "flex-start" }}>
          <div style={{ minWidth: 0 }}><strong>{labelFor(rate)}</strong><div style={{ marginTop: 5, fontSize: 20, fontWeight: 750 }}>{money(Number(rate.price_per_gram))}<span className="small muted"> / gram</span></div><div className="small muted" style={{ marginTop: 4 }}>{[rate.locality, rate.city, rate.district, rate.state].filter(Boolean).join(", ") || "No locality saved"}</div><div className="small muted" style={{ marginTop: 4 }}><Clock3 size={12} style={{ display: "inline", verticalAlign: "middle" }} /> {new Date(rate.effective_at).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })}</div></div>
          <div style={{display:"grid",gap:5,justifyItems:"end"}}><span className={"pill " + (rate.status === "verified" ? "pill-green" : "pill-demo")}>{rate.status}</span>{rate.is_public&&<span className="pill pill-green">public</span>}</div>
        </article>)}</div>}
      </section>
    </div>}
  </div></main>;
}
