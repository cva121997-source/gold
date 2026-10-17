"use client";

import { useRef, useState } from "react";

type PaymentPurpose = "scheme_contribution" | "invoice";
type CheckoutResult = {
  orderId: string;
  orderCode: string;
  providerOrderRef: string;
  keyId: string;
  amount: number;
  amountPaise: number;
  currency: "INR";
  purpose: string;
  shopName: string;
};

type CheckoutOptions = {
  key: string;
  amount: number;
  currency: string;
  name: string;
  description: string;
  order_id: string;
  theme?: { color?: string };
  handler: (response: { razorpay_payment_id?: string; razorpay_order_id?: string; razorpay_signature?: string }) => void;
  modal?: { ondismiss?: () => void };
};

declare global {
  interface Window {
    Razorpay?: new (options: CheckoutOptions) => {
      open: () => void;
      on: (eventName: string, callback: (response: { error?: { description?: string } }) => void) => void;
    };
  }
}

type Props = {
  tenantId: string;
  branchId?: string | null;
  customerId?: string | null;
  purpose: PaymentPurpose;
  amount: number;
  invoiceId?: string;
  enrolmentId?: string;
  description: string;
  allowAmountEdit?: boolean;
  onStatus?: (message: string) => void;
};

function inr(value: number) {
  return new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 2 }).format(value);
}

async function ensureCheckoutLoaded() {
  if (window.Razorpay) return;
  await new Promise<void>((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>('script[data-gold-razorpay="true"]');
    if (existing) {
      existing.addEventListener("load", () => resolve(), { once: true });
      existing.addEventListener("error", () => reject(new Error("Razorpay checkout could not load.")), { once: true });
      if (window.Razorpay) resolve();
      return;
    }
    const script = document.createElement("script");
    script.src = "https://checkout.razorpay.com/v1/checkout.js";
    script.async = true;
    script.dataset.goldRazorpay = "true";
    script.onload = () => resolve();
    script.onerror = () => reject(new Error("Razorpay checkout could not load. Check your connection or content security policy."));
    document.head.appendChild(script);
  });
}

export default function RazorpayCheckoutButton(props: Props) {
  const [amountText, setAmountText] = useState(String(props.amount));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const attemptKey = useRef("");

  async function pay() {
    setError("");
    setNotice("");
    const amount = Number(props.allowAmountEdit ? amountText : props.amount);
    if (!Number.isFinite(amount) || amount <= 0 || Math.round(amount * 100) !== amount * 100) {
      setError("Enter a valid amount with no more than two decimal places.");
      return;
    }
    if (!attemptKey.current) attemptKey.current = crypto.randomUUID();
    setBusy(true);
    try {
      const response = await fetch("/api/payments/create-order", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        cache: "no-store",
        body: JSON.stringify({
          tenantId: props.tenantId,
          branchId: props.branchId ?? null,
          customerId: props.customerId ?? null,
          purpose: props.purpose,
          amount,
          invoiceId: props.invoiceId,
          enrolmentId: props.enrolmentId,
          idempotencyKey: attemptKey.current,
        }),
      });
      const data = await response.json() as CheckoutResult & { error?: string };
      if (!response.ok) {
        setError(data.error ?? "Online payment could not be started.");
        return;
      }
      await ensureCheckoutLoaded();
      if (!window.Razorpay) throw new Error("Razorpay checkout did not initialise.");
      const checkout = new window.Razorpay({
        key: data.keyId,
        amount: data.amountPaise,
        currency: data.currency,
        name: data.shopName || "Gold",
        description: props.description,
        order_id: data.providerOrderRef,
        theme: { color: "#1f5c3e" },
        handler: () => {
          const message = "Checkout response received. Gold will show this payment as confirmed only after the signed Razorpay webhook is verified.";
          setNotice(message);
          props.onStatus?.(message);
        },
        modal: {
          ondismiss: () => setNotice("Checkout closed. No payment has been marked confirmed by Gold."),
        },
      });
      checkout.on("payment.failed", (event) => {
        setError(event.error?.description ?? "Razorpay reports that the payment failed. No scheme balance was credited.");
      });
      checkout.open();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to open online checkout.");
    } finally {
      setBusy(false);
    }
  }

  return <div style={{ display: "grid", gap: 8, marginTop: 12 }}>
    {props.allowAmountEdit && <div className="field">
      <label htmlFor={"online-amount-" + props.enrolmentId}>Contribution amount (₹)</label>
      <input id={"online-amount-" + props.enrolmentId} type="number" inputMode="decimal" min="0.01" step="0.01" value={amountText} onChange={(event) => setAmountText(event.target.value)} />
    </div>}
    <button className="btn btn-primary" type="button" onClick={() => void pay()} disabled={busy} style={{ width: "100%" }}>
      {busy ? "Preparing secure checkout…" : "Pay online · " + inr(Number(props.allowAmountEdit ? amountText : props.amount) || 0)}
    </button>
    {error && <p role="alert" className="small" style={{ color: "#a33b32", margin: 0 }}>{error}</p>}
    {notice && <p role="status" className="small muted" style={{ margin: 0 }}>{notice}</p>}
    <p className="small muted" style={{ margin: 0 }}>Payment confirmation comes from Gold’s verified server webhook—not the checkout browser response.</p>
  </div>;
}
