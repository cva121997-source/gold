"use client";

import Link from "next/link";
import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowLeft, CircleAlert, MessageSquareText, RefreshCw, ShieldCheck, Users } from "lucide-react";
import { createClient } from "@/lib/supabase/client";

type Membership = { tenant_id: string; branch_id: string | null; role: string; tenants: { display_name: string; slug: string } | null };
type Customer = { id: string; customer_code: string; full_name: string; mobile_e164: string; city: string | null; status: string };
type Note = { id: string; customer_id: string; note: string; note_type: string; created_by: string | null; created_at: string };
type Interaction = { id: string; customer_id: string; interaction_type: string; summary: string; follow_up_at: string | null; created_by: string | null; created_at: string };
type Consent = { id: string; customer_id: string; consent_type: string; consented: boolean; terms_version: string | null; source: string; captured_at: string; withdrawn_at: string | null };
const dateText = (value: string) => new Date(value).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" });

export default function CustomerHistoryPage() {
  const router = useRouter();
  const [memberships, setMemberships] = useState<Membership[]>([]);
  const [tenantId, setTenantId] = useState("");
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [customerId, setCustomerId] = useState("");
  const [search, setSearch] = useState("");
  const [notes, setNotes] = useState<Note[]>([]);
  const [interactions, setInteractions] = useState<Interaction[]>([]);
  const [consents, setConsents] = useState<Consent[]>([]);
  const [note, setNote] = useState("");
  const [noteType, setNoteType] = useState("general");
  const [interactionType, setInteractionType] = useState("call");
  const [summary, setSummary] = useState("");
  const [followUp, setFollowUp] = useState("");
  const [consentType, setConsentType] = useState("sms");
  const [consented, setConsented] = useState("true");
  const [termsVersion, setTermsVersion] = useState("");
  const [source, setSource] = useState("staff_entry");
  const [consentNote, setConsentNote] = useState("");
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
        const { data, error: queryError } = await supabase.from("tenant_memberships")
          .select("tenant_id,branch_id,role,tenants(display_name,slug)").eq("user_id", user.id).eq("is_active", true);
        if (queryError) throw queryError;
        if (!alive) return;
        const list = (data ?? []) as unknown as Membership[];
        setMemberships(list); setTenantId(list[0]?.tenant_id ?? "");
      } catch { if (alive) setError("Customer history access could not be loaded. Check sign-in and shop membership."); }
      finally { if (alive) setLoading(false); }
    })();
    return () => { alive = false; };
  }, [router]);

  const loadCustomers = useCallback(async () => {
    if (!tenantId) { setCustomers([]); setCustomerId(""); return; }
    const { data, error: queryError } = await createClient().from("tenant_customers")
      .select("id,customer_code,full_name,mobile_e164,city,status").eq("tenant_id", tenantId)
      .order("full_name").limit(1000);
    if (queryError) { setError("Could not load the customer directory. Confirm your membership and RLS."); setCustomers([]); return; }
    const rows = (data ?? []) as Customer[];
    setCustomers(rows);
    if (!rows.some((row) => row.id === customerId)) setCustomerId(rows[0]?.id ?? "");
  }, [tenantId, customerId]);
  useEffect(() => { void loadCustomers(); }, [loadCustomers]);

  const loadHistory = useCallback(async () => {
    if (!tenantId || !customerId) { setNotes([]); setInteractions([]); setConsents([]); return; }
    setError("");
    const supabase = createClient();
    const [n, i, c] = await Promise.all([
      supabase.from("customer_notes").select("id,customer_id,note,note_type,created_by,created_at")
        .eq("tenant_id", tenantId).eq("customer_id", customerId).order("created_at", { ascending: false }).limit(200),
      supabase.from("customer_interactions").select("id,customer_id,interaction_type,summary,follow_up_at,created_by,created_at")
        .eq("tenant_id", tenantId).eq("customer_id", customerId).order("created_at", { ascending: false }).limit(200),
      supabase.from("customer_consents").select("id,customer_id,consent_type,consented,terms_version,source,captured_at,withdrawn_at")
        .eq("tenant_id", tenantId).eq("customer_id", customerId).order("captured_at", { ascending: false }).limit(200)
    ]);
    if (n.error || i.error || c.error) { setError("One or more history sections are not accessible. Check the latest CRM migration and your staff branch permissions."); return; }
    setNotes((n.data ?? []) as Note[]);
    setInteractions((i.data ?? []) as Interaction[]);
    setConsents((c.data ?? []) as Consent[]);
  }, [tenantId, customerId]);
  useEffect(() => { void loadHistory(); }, [loadHistory]);

  const current = memberships.find((m) => m.tenant_id === tenantId);
  const canWrite = ["owner", "manager", "accountant", "cashier", "scheme_manager", "employee"].includes(current?.role ?? "");
  const selectedCustomer = customers.find((item) => item.id === customerId);
  const filteredCustomers = useMemo(() => {
    const q = search.trim().toLowerCase();
    return customers.filter((c) => !q || [c.full_name, c.mobile_e164, c.customer_code, c.city].some((x) => String(x ?? "").toLowerCase().includes(q)));
  }, [customers, search]);

  async function addNote(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setError(""); setNotice("");
    const trimmed = note.trim();
    if (!tenantId || !customerId || trimmed.length < 1) { setError("Choose a customer and enter a note."); return; }
    setSaving(true);
    try {
      const { data: { user } } = await createClient().auth.getUser();
      if (!user) { router.replace("/login"); return; }
      const { error: insertError } = await createClient().from("customer_notes").insert({
        tenant_id: tenantId, branch_id: current?.branch_id ?? null, customer_id: customerId,
        note: trimmed, note_type: noteType, created_by: user.id
      });
      if (insertError) throw insertError;
      setNote(""); setNotice("Customer note appended to the history.");
      await loadHistory();
    } catch (e) { setError(e instanceof Error ? e.message : "Customer note could not be saved."); }
    finally { setSaving(false); }
  }

  async function addInteraction(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setError(""); setNotice("");
    const trimmed = summary.trim();
    if (!tenantId || !customerId || trimmed.length < 1) { setError("Choose a customer and summarize the interaction."); return; }
    setSaving(true);
    try {
      const { data: { user } } = await createClient().auth.getUser();
      if (!user) { router.replace("/login"); return; }
      const { error: insertError } = await createClient().from("customer_interactions").insert({
        tenant_id: tenantId, branch_id: current?.branch_id ?? null, customer_id: customerId,
        interaction_type: interactionType, summary: trimmed, follow_up_at: followUp ? new Date(followUp).toISOString() : null,
        created_by: user.id
      });
      if (insertError) throw insertError;
      setSummary(""); setFollowUp(""); setNotice("Customer interaction added.");
      await loadHistory();
    } catch (e) { setError(e instanceof Error ? e.message : "Customer interaction could not be saved."); }
    finally { setSaving(false); }
  }

  async function saveConsent(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setError(""); setNotice("");
    setSaving(true);
    try {
      const { error: rpcError } = await createClient().rpc("record_customer_consent", {
        p_tenant_id: tenantId, p_branch_id: current?.branch_id ?? null, p_customer_id: customerId,
        p_consent_type: consentType, p_consented: consented === "true",
        p_terms_version: termsVersion.trim() || null, p_source: source,
        p_metadata: { staff_note: consentNote.trim() || null, interface: "customer-history" }
      });
      if (rpcError) throw rpcError;
      setConsentNote("");
      setNotice(consented === "true" ? "Consent was recorded with an audit event." : "Consent withdrawal was recorded; previous active consent rows were marked withdrawn.");
      await loadHistory();
    } catch (e) { setError(e instanceof Error ? e.message : "Consent could not be recorded."); }
    finally { setSaving(false); }
  }

  return <main><div className="page-wrap">
    <Link className="link-text small" href="/customers"><ArrowLeft size={13} style={{ display: "inline", verticalAlign: "middle" }} /> Back to customers</Link>
    <div style={{ marginTop: 20, marginBottom: 24 }}>
      <div className="eyebrow"><MessageSquareText size={14} /> CRM & consent management</div>
      <h1 style={{ marginTop: 12 }}>Customer history</h1>
      <p className="lead">Keep service notes, follow-up activity and consent changes tied to one customer and one shop. Records are tenant- and branch-scoped; notes/interactions are append-only.</p>
    </div>
    {error && <div role="alert" className="notice" style={{ marginBottom: 14 }}><CircleAlert size={16} /> {error}</div>}
    {notice && <div role="status" className="notice" style={{ marginBottom: 14, color: "#1f5c3e", background: "#edf7ef", borderColor: "#cfe4d4" }}>{notice}</div>}
    {loading ? <section className="panel">Checking customer-history access…</section> : memberships.length === 0 ? <section className="panel"><h2>No shop linked</h2><Link className="btn btn-primary" href="/onboarding">Set up your shop</Link></section> : <>
      <section className="panel" style={{ marginBottom: 18 }}>
        <div className="form-grid">
          <div className="field"><label htmlFor="history-shop">Shop</label>
            <select id="history-shop" value={tenantId} onChange={(e) => setTenantId(e.target.value)}>{memberships.map((m) => <option key={m.tenant_id} value={m.tenant_id}>{m.tenants?.display_name ?? m.tenant_id}</option>)}</select>
          </div>
          <div className="field"><label htmlFor="history-search">Find customer</label><input id="history-search" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Name, mobile, code or city" /></div>
          <div className="field"><label htmlFor="history-customer">Customer ({filteredCustomers.length} shown)</label>
            <select id="history-customer" value={customerId} onChange={(e) => setCustomerId(e.target.value)}>{filteredCustomers.map((c) => <option key={c.id} value={c.id}>{c.full_name} · {c.customer_code} · {c.mobile_e164}</option>)}</select>
          </div>
          {selectedCustomer && <div style={{ alignSelf: "end" }}><strong>{selectedCustomer.full_name}</strong><div className="small muted">{selectedCustomer.mobile_e164}{selectedCustomer.city ? " · " + selectedCustomer.city : ""} · {selectedCustomer.status}</div></div>}
        </div>
        {!canWrite && <p className="small muted" style={{ marginTop: 12 }}>Your role can read available history but cannot append notes or update consent.</p>}
      </section>
      {selectedCustomer && <div className="calc-layout">
        <section className="panel">
          <h2>Append a note</h2>
          <form onSubmit={addNote}>
            <div className="field"><label htmlFor="note-type">Note category</label>
              <select id="note-type" value={noteType} onChange={(e) => setNoteType(e.target.value)} disabled={!canWrite}><option value="general">General</option><option value="service">Service</option><option value="scheme">Scheme</option><option value="complaint">Complaint</option><option value="kyc_review">KYC review</option></select>
            </div>
            <div className="field" style={{ marginTop: 12 }}><label htmlFor="customer-note">Internal note</label><textarea id="customer-note" rows={4} maxLength={5000} value={note} onChange={(e) => setNote(e.target.value)} required disabled={!canWrite} placeholder="Write only information needed to serve this customer." /></div>
            <button className="btn btn-primary" style={{ width: "100%", marginTop: 14 }} disabled={saving || !canWrite}>Save note</button>
          </form>
        </section>
        <section className="panel">
          <h2>Log an interaction</h2>
          <form onSubmit={addInteraction}>
            <div className="field"><label htmlFor="interaction-type">Interaction type</label>
              <select id="interaction-type" value={interactionType} onChange={(e) => setInteractionType(e.target.value)} disabled={!canWrite}><option value="call">Phone call</option><option value="visit">Store visit</option><option value="complaint">Complaint</option><option value="scheme_help">Scheme help</option><option value="payment_followup">Payment follow-up</option><option value="other">Other</option></select>
            </div>
            <div className="field" style={{ marginTop: 12 }}><label htmlFor="interaction-summary">Summary</label><textarea id="interaction-summary" rows={3} maxLength={2000} value={summary} onChange={(e) => setSummary(e.target.value)} required disabled={!canWrite} placeholder="Summarize the customer interaction." /></div>
            <div className="field" style={{ marginTop: 12 }}><label htmlFor="follow-up">Follow-up date (optional)</label><input id="follow-up" type="datetime-local" value={followUp} onChange={(e) => setFollowUp(e.target.value)} disabled={!canWrite} /></div>
            <button className="btn btn-primary" style={{ width: "100%", marginTop: 14 }} disabled={saving || !canWrite}>Save interaction</button>
          </form>
        </section>
      </div>}
      {selectedCustomer && <section className="panel" style={{ marginTop: 18 }}>
        <h2>Consent & preferences</h2>
        <p className="small muted">Grant or record withdrawal for an individual channel/purpose. This logs a new consent event and audits the actor; it does not send a message.</p>
        <form onSubmit={saveConsent}>
          <div className="form-grid">
            <div className="field"><label htmlFor="consent-type">Consent purpose</label>
              <select id="consent-type" value={consentType} onChange={(e) => setConsentType(e.target.value)} disabled={!canWrite}><option value="privacy_notice">Privacy notice</option><option value="scheme_terms">Scheme terms</option><option value="sms">SMS</option><option value="whatsapp">WhatsApp</option><option value="email">Email</option><option value="promotional">Promotional messages</option><option value="data_processing">Data processing</option></select>
            </div>
            <div className="field"><label htmlFor="consent-decision">Record decision</label><select id="consent-decision" value={consented} onChange={(e) => setConsented(e.target.value)} disabled={!canWrite}><option value="true">Consent granted</option><option value="false">Consent withdrawn / not granted</option></select></div>
            <div className="field"><label htmlFor="consent-source">Evidence source</label><select id="consent-source" value={source} onChange={(e) => setSource(e.target.value)} disabled={!canWrite}><option value="staff_entry">Staff record</option><option value="customer_portal">Customer portal</option><option value="signed_form">Signed form</option><option value="phone">Phone</option><option value="email">Email</option><option value="website">Website</option><option value="import">Import</option></select></div>
            <div className="field"><label htmlFor="terms-version">Terms / notice version (optional)</label><input id="terms-version" value={termsVersion} onChange={(e) => setTermsVersion(e.target.value)} maxLength={100} disabled={!canWrite} placeholder="e.g. privacy-2026-10" /></div>
          </div>
          <div className="field" style={{ marginTop: 12 }}><label htmlFor="consent-note">Internal evidence note (optional)</label><input id="consent-note" value={consentNote} onChange={(e) => setConsentNote(e.target.value)} maxLength={1000} disabled={!canWrite} placeholder="Reference to paper form or conversation" /></div>
          <button className="btn btn-primary" style={{ marginTop: 14 }} disabled={saving || !canWrite}>Record consent event</button>
        </form>
      </section>}
      {selectedCustomer && <div className="calc-layout" style={{ marginTop: 18 }}>
        <section className="panel"><h2>Notes ({notes.length})</h2>
          {notes.length === 0 ? <p className="small muted">No notes yet.</p> : <div style={{ display: "grid", gap: 12 }}>{notes.map((item) => <article key={item.id} style={{ borderBottom: "1px solid var(--line)", paddingBottom: 12, overflowWrap: "anywhere" }}><span className="pill">{item.note_type.replaceAll("_", " ")}</span><p style={{ whiteSpace: "pre-wrap", marginTop: 8 }}>{item.note}</p><p className="small muted" style={{ marginBottom: 0 }}>{dateText(item.created_at)} · {item.created_by ?? "system"}</p></article>)}</div>}
        </section>
        <section className="panel"><h2>Interactions ({interactions.length})</h2>
          {interactions.length === 0 ? <p className="small muted">No interactions yet.</p> : <div style={{ display: "grid", gap: 12 }}>{interactions.map((item) => <article key={item.id} style={{ borderBottom: "1px solid var(--line)", paddingBottom: 12, overflowWrap: "anywhere" }}><span className="pill">{item.interaction_type.replaceAll("_", " ")}</span><p style={{ whiteSpace: "pre-wrap", marginTop: 8 }}>{item.summary}</p><p className="small muted" style={{ marginBottom: 0 }}>{dateText(item.created_at)}{item.follow_up_at ? " · Follow up: " + dateText(item.follow_up_at) : ""}</p></article>)}</div>}
        </section>
      </div>}
      {selectedCustomer && <section className="panel" style={{ marginTop: 18 }}><h2>Consent history ({consents.length})</h2>
        {consents.length === 0 ? <p className="small muted">No consent records found. Obtain and record the customer's decision where required.</p> : <div style={{ display: "grid", gap: 10 }}>{consents.map((item) => <article key={item.id} style={{ border: "1px solid var(--line)", borderRadius: 10, padding: 12, minWidth: 0, display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}><div><strong>{item.consent_type.replaceAll("_", " ")}</strong><div className="small muted">{item.source}{item.terms_version ? " · Version " + item.terms_version : ""}</div><div className="small muted">{dateText(item.captured_at)}</div></div><span className="pill">{item.consented && !item.withdrawn_at ? "Granted" : "Withdrawn / not granted"}</span></article>)}</div>}
      </section>}
      <section className="panel" style={{ marginTop: 18 }}><p className="small muted" style={{ margin: 0 }}><ShieldCheck size={15} style={{ display: "inline", verticalAlign: "middle" }} /> Keep notes relevant, minimal and respectful. Avoid storing passwords, payment-card information or unnecessary sensitive details in free-text fields.</p></section>
    </>}
  </div></main>;
}
