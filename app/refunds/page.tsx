"use client";

import Link from "next/link";
import { FormEvent, useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowLeft, Banknote, CircleAlert, RefreshCw, ShieldCheck } from "lucide-react";
import { createClient } from "@/lib/supabase/client";

type Membership = { tenant_id: string; branch_id: string | null; role: string; tenants: { display_name: string; slug: string } | null };
type Payment = { id: string; amount: number; payment_method: string; status: string; reference: string | null; provider: string | null; created_at: string; customer_id: string | null };
type Refund = { id: string; payment_id: string; amount: number; reason: string; status: string; provider_ref: string | null; external_reference: string | null; decline_reason: string | null; created_at: string; completed_at: string | null };

const inr = (value: number) => new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 2 }).format(Number(value) || 0);
const dateText = (value: string | null) => value ? new Date(value).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" }) : "—";

export default function RefundsPage() {
  const router = useRouter();
  const [memberships, setMemberships] = useState<Membership[]>([]);
  const [tenantId, setTenantId] = useState("");
  const [payments, setPayments] = useState<Payment[]>([]);
  const [refunds, setRefunds] = useState<Refund[]>([]);
  const [paymentId, setPaymentId] = useState("");
  const [amount, setAmount] = useState("");
  const [reason, setReason] = useState("");
  const [references, setReferences] = useState<Record<string, string>>({});
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
        const { data, error: queryError } = await supabase.from("tenant_memberships")
          .select("tenant_id,branch_id,role,tenants(display_name,slug)").eq("user_id", user.id).eq("is_active", true);
        if (queryError) throw queryError;
        if (!active) return;
        const rows = (data ?? []) as unknown as Membership[];
        setMemberships(rows);
        setTenantId(rows[0]?.tenant_id ?? "");
      } catch {
        if (active) setError("Refund workspace could not load. Sign in with a shop account and verify your Supabase setup.");
      } finally { if (active) setLoading(false); }
    })();
    return () => { active = false; };
  }, [router]);

  const load = useCallback(async () => {
    if (!tenantId) { setPayments([]); setRefunds([]); return; }
    setError("");
    const supabase = createClient();
    const [p, r] = await Promise.all([
      supabase.from("payments").select("id,amount,payment_method,status,reference,provider,created_at,customer_id")
        .eq("tenant_id", tenantId).eq("status", "confirmed").order("confirmed_at", { ascending: false }).limit(250),
      supabase.from("refunds").select("id,payment_id,amount,reason,status,provider_ref,external_reference,decline_reason,created_at,completed_at")
        .eq("tenant_id", tenantId).order("created_at", { ascending: false }).limit(500)
    ]);
    if (p.error || r.error) {
      setError("Refund records need owner, manager or accountant access. Confirm the latest lifecycle SQL migration is applied.");
      setPayments([]); setRefunds([]); return;
    }
    setPayments((p.data ?? []) as Payment[]);
    setRefunds((r.data ?? []) as Refund[]);
  }, [tenantId]);

  useEffect(() => { void load(); }, [load]);

  const current = memberships.find((m) => m.tenant_id === tenantId);
  const canReview = ["owner", "manager", "accountant"].includes(current?.role ?? "");
  const paymentMap = new Map(payments.map((payment) => [payment.id, payment]));
  const reservedByPayment = new Map<string, number>();
  for (const item of refunds) {
    if (!["rejected", "failed"].includes(item.status)) reservedByPayment.set(item.payment_id, (reservedByPayment.get(item.payment_id) ?? 0) + Number(item.amount));
  }
  const refundablePayments = payments.filter((p) => Number(p.amount) - (reservedByPayment.get(p.id) ?? 0) > 0.009);

  async function submitRequest(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(""); setNotice("");
    if (!tenantId || !paymentId || !reason.trim()) { setError("Choose a confirmed payment and enter a refund reason."); return; }
    const value = Number(amount);
    if (!Number.isFinite(value) || value <= 0) { setError("Refund amount must be greater than ₹0."); return; }
    setSaving(true);
    try {
      const { error: rpcError } = await createClient().rpc("request_refund", {
        p_tenant_id: tenantId, p_payment_id: paymentId, p_amount: value, p_reason: reason.trim()
      });
      if (rpcError) throw rpcError;
      setNotice("Refund request recorded for review. No money is marked as returned until a payout is verified.");
      setPaymentId(""); setAmount(""); setReason("");
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Refund request failed. Check the payment status and refundable balance.");
    } finally { setSaving(false); }
  }

  async function review(refund: Refund, action: "approve" | "reject") {
    setError(""); setNotice("");
    const reasonText = action === "reject" ? (typeof window !== "undefined" ? window.prompt("Reason for rejecting this refund?") : null) : null;
    if (action === "reject" && !reasonText?.trim()) return;
    setSaving(true);
    try {
      const { error: rpcError } = await createClient().rpc("review_refund_request", {
        p_tenant_id: tenantId, p_refund_id: refund.id, p_action: action, p_reason: reasonText
      });
      if (rpcError) throw rpcError;
      setNotice(action === "approve" ? "Refund approved. Complete the payout using the gateway or payment source; approval alone does not refund money." : "Refund request rejected and audited.");
      await load();
    } catch (e) { setError(e instanceof Error ? e.message : "Refund review failed."); }
    finally { setSaving(false); }
  }

  async function completeManual(refund: Refund) {
    const reference = (references[refund.id] ?? "").trim();
    if (reference.length < 3) { setError("Enter the bank/cash payout reference before completing the refund."); return; }
    setError(""); setNotice(""); setSaving(true);
    try {
      const { error: rpcError } = await createClient().rpc("complete_manual_refund", {
        p_tenant_id: tenantId, p_refund_id: refund.id, p_reference: reference
      });
      if (rpcError) throw rpcError;
      setNotice("Manual refund recorded with a payout reference and audit trail.");
      setReferences((current) => ({ ...current, [refund.id]: "" }));
      await load();
    } catch (e) { setError(e instanceof Error ? e.message : "Manual refund could not be completed."); }
    finally { setSaving(false); }
  }

  async function gatewayRefund(refund: Refund) {
    setError(""); setNotice(""); setSaving(true);
    try {
      const response = await fetch("/api/payments/razorpay/refund", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tenantId, refundId: refund.id }),
        cache: "no-store"
      });
      const raw: unknown = await response.json().catch(() => null);
      const body = raw && typeof raw === "object" && !Array.isArray(raw)
        ? raw as { ok?: unknown; status?: unknown; message?: unknown; error?: unknown }
        : {};
      const message = typeof body.message === "string" ? body.message
        : typeof body.error === "string" ? body.error : "Razorpay refund status could not be reconciled.";
      if (!response.ok && response.status !== 202) {
        setError(message);
      } else {
        setNotice(message);
      }
      await load();
    } catch {
      setError("Refund request could not be confirmed. Refresh or reconcile the existing Razorpay refund before taking any further action.");
      await load();
    } finally { setSaving(false); }
  }

  return <main><div className="page-wrap">
    <Link className="link-text small" href="/dashboard"><ArrowLeft size={13} style={{ display: "inline", verticalAlign: "middle" }} /> Back to workspace</Link>
    <div style={{ marginTop: 20, marginBottom: 24 }}>
      <div className="eyebrow"><Banknote size={14} /> Financial controls</div>
      <h1 style={{ marginTop: 12 }}>Refunds & reversals</h1>
      <p className="lead">Track the original payment, request approval, record the actual payout and keep an auditable trail. A refund request never silently edits a confirmed payment.</p>
    </div>
    {error && <div role="alert" className="notice" style={{ marginBottom: 14 }}><CircleAlert size={16} /> {error}</div>}
    {notice && <div role="status" className="notice" style={{ marginBottom: 14, color: "#1f5c3e", background: "#edf7ef", borderColor: "#cfe4d4" }}>{notice}</div>}
    {loading ? <section className="panel">Loading refund permissions…</section> : memberships.length === 0 ? <section className="panel"><h2>No shop is linked</h2><Link className="btn btn-primary" href="/onboarding">Set up your shop</Link></section> : <>
      <div className="field" style={{ maxWidth: 420, marginBottom: 18 }}>
        <label htmlFor="refund-tenant">Shop</label>
        <select id="refund-tenant" value={tenantId} onChange={(e) => setTenantId(e.target.value)}>
          {memberships.map((m) => <option key={m.tenant_id} value={m.tenant_id}>{m.tenants?.display_name ?? m.tenant_id}</option>)}
        </select>
      </div>
      {!canReview && <section className="panel" style={{ marginBottom: 18 }}>Refund controls are limited to shop owners, managers and accountants.</section>}
      <div className="calc-layout">
        <section className="panel">
          <h2>Request a refund</h2>
          <p className="small muted">Only confirmed payments are eligible. Existing open or completed refunds reduce the remaining refundable amount.</p>
          <form onSubmit={submitRequest}>
            <div className="field"><label htmlFor="refund-payment">Original confirmed payment</label>
              <select id="refund-payment" value={paymentId} onChange={(e) => setPaymentId(e.target.value)} required disabled={!canReview}>
                <option value="">Choose payment…</option>
                {refundablePayments.map((p) => <option key={p.id} value={p.id}>{inr(Number(p.amount) - (reservedByPayment.get(p.id) ?? 0))} remaining · {p.payment_method} · {p.reference || p.id.slice(0, 8)} · {dateText(p.created_at)}</option>)}
              </select>
            </div>
            <div className="field" style={{ marginTop: 12 }}><label htmlFor="refund-amount">Refund amount (₹)</label>
              <input id="refund-amount" inputMode="decimal" type="number" min="0.01" step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} required disabled={!canReview} />
            </div>
            <div className="field" style={{ marginTop: 12 }}><label htmlFor="refund-reason">Reason</label>
              <textarea id="refund-reason" rows={3} value={reason} onChange={(e) => setReason(e.target.value)} required minLength={4} maxLength={2000} disabled={!canReview} placeholder="Describe why the payment is being returned." />
            </div>
            <button className="btn btn-primary" type="submit" disabled={saving || !canReview} style={{ width: "100%", marginTop: 18 }}>{saving ? "Saving…" : "Submit refund request"}</button>
          </form>
        </section>
        <section className="panel">
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
            <h2>Refund queue</h2><button className="btn btn-secondary" type="button" onClick={() => void load()} disabled={saving}><RefreshCw size={15} /> Refresh</button>
          </div>
          {refunds.length === 0 ? <p className="muted" style={{ marginTop: 18 }}>No refund requests recorded for this shop.</p> : <div style={{ display: "grid", gap: 12, marginTop: 14 }}>
            {refunds.map((refund) => {
              const payment = paymentMap.get(refund.payment_id);
              const isGateway = payment?.provider?.toLowerCase() === "razorpay" || ["razorpay", "card", "gateway"].includes((payment?.payment_method ?? "").toLowerCase());
              return <article key={refund.id} style={{ border: "1px solid var(--line, #ded8cd)", borderRadius: 14, padding: 14, minWidth: 0 }}>
                <div style={{ display: "flex", alignItems: "start", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
                  <div><strong>{inr(Number(refund.amount))}</strong><div className="small muted">{payment?.reference || refund.payment_id.slice(0, 8)} · {payment?.payment_method ?? "Original payment"}</div></div>
                  <span className="pill">{refund.status.replaceAll("_", " ")}</span>
                </div>
                <p style={{ margin: "10px 0 4px" }}>{refund.reason}</p>
                <p className="small muted" style={{ margin: 0 }}>Requested {dateText(refund.created_at)}{refund.completed_at ? " · Completed " + dateText(refund.completed_at) : ""}</p>
                {refund.decline_reason && <p className="small" style={{ color: "#a33", marginBottom: 0 }}>Reason: {refund.decline_reason}</p>}
                {canReview && refund.status === "requested" && <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 12 }}>
                  <button className="btn btn-primary" type="button" disabled={saving} onClick={() => void review(refund, "approve")}>Approve</button>
                  <button className="btn btn-secondary" type="button" disabled={saving} onClick={() => void review(refund, "reject")}>Reject</button>
                </div>}
                {canReview && refund.status === "approved" && !isGateway && <div style={{ marginTop: 12 }}>
                  <div className="field"><label htmlFor={"refund-ref-" + refund.id}>Payout reference (cash/bank)</label>
                    <input id={"refund-ref-" + refund.id} value={references[refund.id] ?? ""} onChange={(e) => setReferences((current) => ({ ...current, [refund.id]: e.target.value }))} placeholder="Bank UTR or receipt reference" />
                  </div>
                  <button className="btn btn-primary" style={{ marginTop: 10 }} type="button" disabled={saving} onClick={() => void completeManual(refund)}>Record actual payout</button>
                </div>}
                {canReview && isGateway && ["approved", "processing"].includes(refund.status) && <div style={{ marginTop: 12 }}>
                  <p className="small muted" style={{ marginBottom: 8 }}>{refund.status === "approved"
                    ? "This submits the approved refund to Razorpay. Gold records completion only after a provider response or signed webhook confirms the outcome."
                    : "The gateway request is already processing. This action checks Razorpay for the existing refund and does not create a second refund automatically."}</p>
                  <button className="btn btn-primary" type="button" disabled={saving} onClick={() => void gatewayRefund(refund)}>
                    <RefreshCw size={14} /> {refund.status === "approved" ? "Submit Razorpay refund" : "Reconcile Razorpay refund"}
                  </button>
                </div>}
                {refund.external_reference && <p className="small muted" style={{ marginBottom: 0 }}>Payout reference: {refund.external_reference}</p>}
                <p className="small muted" style={{ marginBottom: 0, marginTop: 8 }}>Audit ID: {refund.id}</p>
              </article>;
            })}
          </div>}
        </section>
      </div>
      <section className="panel" style={{ marginTop: 18 }}><h2><ShieldCheck size={18} style={{ display: "inline", verticalAlign: "middle" }} /> Financial integrity rules</h2>
        <p className="small muted" style={{ marginBottom: 0 }}>The database reserves open refunds against the original amount, records review actions, and disallows staff completion for Razorpay/card/gateway payments. Razorpay refunds remain pending until the provider refund endpoint and signed refund events are configured and tested.</p>
      </section>
    </>}
  </div></main>;
}
