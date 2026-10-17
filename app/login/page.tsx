"use client";
import Link from "next/link";
import { FormEvent, useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowLeft, LockKeyhole, Smartphone } from "lucide-react";
import { createClient } from "@/lib/supabase/client";

export default function LoginPage() {
  const router = useRouter();
  const [phone, setPhone] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setError(""); setBusy(true);
    const digits = phone.replace(/[^\d+]/g, "");
    const e164Phone = digits.startsWith("+") ? digits : "+91" + digits.replace(/^0+/, "");
    try {
      const supabase = createClient();
      const { error: signInError } = await supabase.auth.signInWithPassword({ phone: e164Phone, password });
      setBusy(false);
      if (signInError) {
        setError("Sign-in failed. Check the mobile number and password, and confirm phone/password sign-in is enabled in Supabase Auth.");
        return;
      }
      const { data: { user } } = await supabase.auth.getUser();
      const membershipResult = user ? await supabase.from("tenant_memberships").select("tenant_id").eq("user_id", user.id).eq("is_active", true).limit(1) : { data: [] };
      router.push(membershipResult.data && membershipResult.data.length > 0 ? "/dashboard" : "/my-account");
      router.refresh();
    } catch {
      setBusy(false);
      setError("Supabase is not configured yet. Add the project URL and publishable/anon key to your environment, then try again.");
    }
  }

  return <main><div className="page-wrap" style={{ maxWidth: 620 }}>
    <Link className="link-text small" href="/"><ArrowLeft size={13} style={{ display: "inline", verticalAlign: "middle" }} /> Back to overview</Link>
    <div style={{ marginTop: 22 }} className="panel">
      <div className="feature-icon"><LockKeyhole size={21} /></div>
      <div className="eyebrow">Secure workspace access</div><h1 style={{ marginTop: 12, fontSize: 34 }}>Sign in to Gold</h1>
      <p className="muted" style={{ lineHeight: 1.65 }}>Use the verified mobile number associated with your Gold account. Shop membership and data access are determined by the authenticated account and database policies.</p>
      <form onSubmit={handleSubmit}>
        <div className="field" style={{ marginTop: 18 }}><label htmlFor="phone"><Smartphone size={14} style={{ display: "inline", verticalAlign: "middle", marginRight: 5 }} /> Mobile number</label><input id="phone" inputMode="tel" autoComplete="tel" placeholder="+91 98765 43210" value={phone} onChange={(e) => setPhone(e.target.value)} required /><span className="small muted">Indian numbers without a country code are prefixed with +91.</span></div>
        <div className="field" style={{ marginTop: 15 }}><label htmlFor="password">Password</label><input id="password" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required /></div>
        {error && <p role="alert" className="error-text" style={{ marginTop: 14 }}>{error}</p>}
        <button className="btn btn-primary" type="submit" disabled={busy} style={{ width: "100%", marginTop: 20, opacity: busy ? .7 : 1 }}>{busy ? "Signing in…" : "Sign in securely"}</button>
      </form>
      <div className="action-row" style={{marginTop:16}}>
        <Link className="link-text small" href="/activate">Activate customer account</Link>
        <Link className="link-text small" href="/platform-admin">Platform administrator</Link>
        <Link className="link-text small" href="/recover">Forgot password?</Link>
      </div>
      <div className="notice" style={{ marginTop: 18 }}><LockKeyhole size={15} style={{ flexShrink: 0, marginTop: 1 }} /><span>This page never stores passwords in the application database. Configure and test phone/password sign-in in Supabase Auth before production use.</span></div>
    </div>
  </div></main>;
}
