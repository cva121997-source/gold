"use client";

import Link from "next/link";
import { FormEvent, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowLeft, Building2, CheckCircle2 } from "lucide-react";
import { createClient } from "@/lib/supabase/client";

export default function OnboardingPage() {
  const router = useRouter();
  const [ready, setReady] = useState(false);
  const [displayName, setDisplayName] = useState("");
  const [slug, setSlug] = useState("");
  const [state, setState] = useState("Tamil Nadu");
  const [district, setDistrict] = useState("");
  const [city, setCity] = useState("");
  const [locality, setLocality] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState(false);

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const supabase = createClient();
        const { data } = await supabase.auth.getUser();
        if (!alive) return;
        if (!data.user) router.replace("/login");
        else setReady(true);
      } catch {
        if (alive) { setReady(true); setError("Set the Supabase project URL and publishable/anon key before creating a shop."); }
      }
    })();
    return () => { alive = false; };
  }, [router]);

  function changeName(value: string) {
    setDisplayName(value);
    setSlug(value.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60));
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setError(""); setBusy(true);
    try {
      const supabase = createClient();
      const { data: userResult } = await supabase.auth.getUser();
      if (!userResult.user) { router.replace("/login"); return; }
      const { error: rpcError } = await supabase.rpc("create_tenant_onboarding", {
        p_display_name: displayName.trim(),
        p_slug: slug.trim(),
        p_state: state.trim() || null,
        p_city: city.trim() || null,
        p_district: district.trim() || null,
        p_locality: locality.trim() || null
      });
      if (rpcError) {
        setError("The shop could not be created. Check the name and unique URL slug, and confirm the Gold database migration is applied.");
        setBusy(false);
        return;
      }
      setSuccess(true); setBusy(false);
      router.push("/dashboard"); router.refresh();
    } catch {
      setError("Supabase is not configured or the onboarding service is unavailable. Check the environment and database migration.");
      setBusy(false);
    }
  }

  return <main><div className="page-wrap" style={{ maxWidth: 760 }}>
    <Link className="link-text small" href="/dashboard"><ArrowLeft size={13} style={{ display: "inline", verticalAlign: "middle" }} /> Back to workspace</Link>
    <div style={{ marginTop: 22 }} className="panel">
      <div className="feature-icon"><Building2 size={21} /></div>
      <div className="eyebrow">Shop setup</div><h1 style={{ marginTop: 12, fontSize: 34 }}>Set up your jewellery shop</h1>
      <p className="muted" style={{ lineHeight: 1.7 }}>Create your tenant workspace. Gold assigns the authenticated account as the shop owner using a database function; the browser cannot assign itself a role.</p>
      {!ready ? <p className="muted">Checking sign-in…</p> : <form onSubmit={handleSubmit}>
        <div className="form-grid">
          <div className="field"><label htmlFor="displayName">Shop display name *</label><input id="displayName" value={displayName} onChange={(e) => changeName(e.target.value)} required minLength={2} maxLength={120} placeholder="Sri Lakshmi Gold House" /></div>
          <div className="field"><label htmlFor="slug">Shop URL slug *</label><input id="slug" value={slug} onChange={(e) => setSlug(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, "").slice(0, 60))} required pattern="[a-z0-9]+(-[a-z0-9]+)*" maxLength={60} placeholder="sri-lakshmi-gold-house" /><span className="small muted">Lowercase letters, numbers and hyphens. Must be unique.</span></div>
          <div className="field"><label htmlFor="state">State</label><input id="state" value={state} onChange={(e) => setState(e.target.value)} maxLength={100} /></div>
          <div className="field"><label htmlFor="district">District</label><input id="district" value={district} onChange={(e) => setDistrict(e.target.value)} maxLength={100} placeholder="Krishnagiri" /></div>
          <div className="field"><label htmlFor="city">City or town</label><input id="city" value={city} onChange={(e) => setCity(e.target.value)} maxLength={100} placeholder="Hosur" /></div>
          <div className="field"><label htmlFor="locality">Locality or market</label><input id="locality" value={locality} onChange={(e) => setLocality(e.target.value)} maxLength={120} placeholder="Main market" /></div>
        </div>
        {error && <p role="alert" className="error-text" style={{ marginTop: 15 }}>{error}</p>}
        {success && <p className="success-text" style={{ marginTop: 15 }}><CheckCircle2 size={14} style={{ display: "inline", verticalAlign: "middle" }} /> Shop created. Opening your workspace…</p>}
        <button className="btn btn-primary" type="submit" disabled={busy || !displayName.trim() || !slug.trim()} style={{ marginTop: 20, width: "100%", opacity: busy ? .7 : 1 }}>{busy ? "Creating secure workspace…" : "Create shop workspace"}</button>
      </form>}
      <div className="notice" style={{ marginTop: 18 }}><Building2 size={15} style={{ flexShrink: 0, marginTop: 1 }} /><span>This first setup form creates a tenant and its default branch. Staff invitations, billing, and the remaining onboarding checklist are planned follow-on modules.</span></div>
    </div>
  </div></main>;
}
