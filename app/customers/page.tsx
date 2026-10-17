"use client";

import Link from "next/link";
import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowLeft, CircleAlert, Search, UserRoundPlus, Users } from "lucide-react";
import { createClient } from "@/lib/supabase/client";

type Membership = { tenant_id: string; role: string; tenants: { display_name: string; slug: string } | null };
type Customer = { id: string; customer_code: string; full_name: string; mobile_e164: string; city: string | null; status: string; created_at: string };

export default function CustomersPage() {
  const router = useRouter();
  const [memberships, setMemberships] = useState<Membership[]>([]);
  const [tenantId, setTenantId] = useState("");
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [fullName, setFullName] = useState("");
  const [mobile, setMobile] = useState("");
  const [city, setCity] = useState("");
  const [search, setSearch] = useState("");
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
      } catch {
        if (alive) setError("Could not load shop memberships. Check Supabase configuration and database migrations.");
      } finally { if (alive) setLoading(false); }
    })();
    return () => { alive = false; };
  }, [router]);

  const loadCustomers = useCallback(async () => {
    if (!tenantId) { setCustomers([]); return; }
    const supabase = createClient();
    const { data, error: queryError } = await supabase.from("tenant_customers")
      .select("id, customer_code, full_name, mobile_e164, city, status, created_at")
      .eq("tenant_id", tenantId).order("created_at", { ascending: false }).limit(100);
    if (queryError) { setError("Customer records could not be loaded. Confirm your shop membership and RLS configuration."); return; }
    setCustomers((data ?? []) as Customer[]);
  }, [tenantId]);

  useEffect(() => { void loadCustomers(); }, [loadCustomers]);

  const currentMember = memberships.find((m) => m.tenant_id === tenantId);
  const canCreate = ["owner","manager","accountant","cashier","scheme_manager","employee"].includes(currentMember?.role ?? "");
  const filteredCustomers = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return customers;
    return customers.filter((c) => c.full_name.toLowerCase().includes(q) || c.mobile_e164.includes(q) || c.customer_code.toLowerCase().includes(q));
  }, [customers, search]);

  async function addCustomer(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setError(""); setNotice("");
    const digits = mobile.replace(/[^\d+]/g, "");
    const phone = digits.startsWith("+") ? digits : "+91" + digits.replace(/^0+/, "");
    if (!/^\+[1-9]\d{7,14}$/.test(phone)) { setError("Enter a valid mobile number with country code, such as +919876543210."); return; }
    if (!tenantId) { setError("Create or select a shop before adding customers."); return; }
    setSaving(true);
    try {
      const supabase = createClient();
      const { data: existing, error: checkError } = await supabase.from("tenant_customers").select("id").eq("tenant_id", tenantId).eq("mobile_e164", phone).maybeSingle();
      if (checkError) { setError("Could not check for a duplicate mobile number."); return; }
      if (existing) { setError("A customer with that mobile number already exists in this shop."); return; }
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) { router.replace("/login"); return; }
      const { error: insertError } = await supabase.from("tenant_customers").insert({
        tenant_id: tenantId, customer_code: "CUS-" + crypto.randomUUID().slice(0, 8).toUpperCase(),
        full_name: fullName.trim(), mobile_e164: phone, city: city.trim() || null, created_by: user.id
      });
      if (insertError) { setError("Customer was not saved. Your role may not have permission to add customer records."); return; }
      setFullName(""); setMobile(""); setCity(""); setNotice("Customer record created. Account activation and consent-based messaging are separate workflows.");
      await loadCustomers();
    } catch { setError("Could not save the customer. Check the connection and try again."); }
    finally { setSaving(false); }
  }

  return <main><div className="page-wrap">
    <Link className="link-text small" href="/dashboard"><ArrowLeft size={13} style={{ display: "inline", verticalAlign: "middle" }} /> Back to workspace</Link>
    <div style={{ marginTop: 20, marginBottom: 24 }}><div className="eyebrow"><Users size={14} /> Customer relationship management</div><h1 style={{ marginTop: 12 }}>Customers</h1><p className="lead">Create shop-scoped customer profiles and search recent records. Customer data is protected by tenant RLS, not just frontend filtering.</p></div>
    {error && <div role="alert" className="notice" style={{ marginBottom: 15 }}><CircleAlert size={16} style={{ flexShrink: 0 }} /><span>{error}</span></div>}
    {notice && <div className="notice" style={{ marginBottom: 15, color: "#1f5c3e", background: "#edf7ef", borderColor: "#cfe4d4" }}>{notice}</div>}
    {loading ? <div className="panel">Loading shop access…</div> : memberships.length === 0 ? <div className="panel"><h2>No shop linked</h2><p className="muted">Set up your shop before registering customers.</p><Link href="/onboarding" className="btn btn-primary">Set up your shop</Link></div> : <div className="calc-layout">
      <section className="panel">
        <h2>New customer</h2><p className="small muted">Only collect details needed to operate the shop. Avoid collecting sensitive identifiers without a justified requirement.</p>
        {memberships.length > 1 && <div className="field" style={{ marginBottom: 15 }}><label htmlFor="tenant">Shop</label><select id="tenant" value={tenantId} onChange={(e) => setTenantId(e.target.value)}>{memberships.map((m) => <option key={m.tenant_id} value={m.tenant_id}>{m.tenants?.display_name ?? m.tenant_id}</option>)}</select></div>}
        {canCreate ? <form onSubmit={addCustomer}>
          <div className="field"><label htmlFor="fullName">Full name *</label><input id="fullName" value={fullName} onChange={(e) => setFullName(e.target.value)} required maxLength={160} /></div>
          <div className="field" style={{ marginTop: 14 }}><label htmlFor="mobile">Mobile number *</label><input id="mobile" value={mobile} onChange={(e) => setMobile(e.target.value)} required autoComplete="tel" placeholder="+91 98765 43210" inputMode="tel" /></div>
          <div className="field" style={{ marginTop: 14 }}><label htmlFor="city">City or town (optional)</label><input id="city" value={city} onChange={(e) => setCity(e.target.value)} maxLength={100} /></div>
          <button className="btn btn-primary" type="submit" disabled={saving} style={{ width: "100%", marginTop: 20 }}>{saving ? "Saving customer…" : <><UserRoundPlus size={15} /> Add customer</>}</button>
        </form> : <div className="notice">Your membership can view customers, but does not have permission to create them.</div>}
      </section>
      <section className="panel">
        <div style={{ display: "flex", justifyContent: "space-between", gap: 14, alignItems: "start" }}><div><h2>Customer directory</h2><p className="small muted">{customers.length} recent records loaded</p></div><span className="pill pill-green">Shop scoped</span></div>
        <div className="field" style={{ marginBottom: 14 }}><label htmlFor="search">Search name, mobile or customer code</label><div style={{ position: "relative" }}><Search size={15} style={{ position: "absolute", left: 12, top: 14, color: "#72796e" }} /><input id="search" style={{ paddingLeft: 36 }} value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search customers…" /></div></div>
        {filteredCustomers.length === 0 ? <p className="small muted">No matching customers in the recent record set.</p> : <div style={{ display: "grid", gap: 10 }}>{filteredCustomers.map((customer) => <article className="list-card" key={customer.id} style={{ alignItems: "flex-start" }}>
          <div style={{ minWidth: 0 }}><strong>{customer.full_name}</strong><div className="small muted" style={{ marginTop: 4 }}>{customer.customer_code} · {customer.mobile_e164}</div><div className="small muted" style={{ marginTop: 4 }}>{customer.city || "City not added"} · Added {new Date(customer.created_at).toLocaleDateString("en-IN")}</div></div><span className="pill pill-green">{customer.status}</span>
        </article>)}</div>}
      </section>
    </div>}
  </div></main>;
}
