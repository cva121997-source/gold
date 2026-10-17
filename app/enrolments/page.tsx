"use client";

import Link from "next/link";
import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowLeft, CircleAlert, ClipboardList, Plus, ShieldCheck } from "lucide-react";
import { createClient } from "@/lib/supabase/client";

type Membership = { tenant_id: string; branch_id: string | null; role: string; tenants: { display_name: string; slug: string } | null };
type Customer = { id: string; full_name: string; customer_code: string; mobile_e164: string };
type Scheme = { id: string; name: string; scheme_type: string; status: string; current_version: number };
type Version = { id: string; scheme_id: string; version_no: number; terms: Record<string, unknown> };
type Enrolment = { id: string; enrolment_code: string; status: string; start_date: string; maturity_date: string | null; customer_id: string; scheme_version_id: string };
type Installment = { id: string; enrolment_id: string; installment_no: number; due_date: string; amount_due: number; amount_paid: number; status: string };

export default function EnrolmentsPage() {
  const router = useRouter();
  const [memberships,setMemberships]=useState<Membership[]>([]);
  const [tenantId,setTenantId]=useState("");
  const [customers,setCustomers]=useState<Customer[]>([]);
  const [schemes,setSchemes]=useState<Scheme[]>([]);
  const [versions,setVersions]=useState<Version[]>([]);
  const [enrolments,setEnrolments]=useState<Enrolment[]>([]);
  const [installments,setInstallments]=useState<Installment[]>([]);
  const [customerId,setCustomerId]=useState("");
  const [versionId,setVersionId]=useState("");
  const [accepted,setAccepted]=useState(false);
  const [loading,setLoading]=useState(true);
  const [saving,setSaving]=useState(false);
  const [error,setError]=useState("");
  const [notice,setNotice]=useState("");

  useEffect(()=>{let active=true; void(async()=>{try{
    const supabase=createClient(); const {data:{user}}=await supabase.auth.getUser(); if(!user){router.replace("/login");return;}
    const {data,error}=await supabase.from("tenant_memberships").select("tenant_id, branch_id, role, tenants(display_name, slug)").eq("user_id",user.id).eq("is_active",true);
    if(error) throw error; if(!active)return; const rows=(data??[]) as unknown as Membership[]; setMemberships(rows);setTenantId(rows[0]?.tenant_id??"");
  }catch{if(active)setError("Could not load shop access. Apply all Gold SQL migrations and check Supabase configuration.");}finally{if(active)setLoading(false);}})();return()=>{active=false;}},[router]);

  const load=useCallback(async()=>{
    if(!tenantId){setCustomers([]);setSchemes([]);setVersions([]);setEnrolments([]);setInstallments([]);return;}
    const supabase=createClient();
    const [c,s,e]=await Promise.all([
      supabase.from("tenant_customers").select("id,full_name,customer_code,mobile_e164").eq("tenant_id",tenantId).eq("status","active").order("full_name").limit(500),
      supabase.from("scheme_templates").select("id,name,scheme_type,status,current_version").eq("tenant_id",tenantId).eq("status","published").order("name"),
      supabase.from("scheme_enrolments").select("id,enrolment_code,status,start_date,maturity_date,customer_id,scheme_version_id").eq("tenant_id",tenantId).order("created_at",{ascending:false}).limit(100)
    ]);
    if(c.error||s.error||e.error){setError("Could not load customers or schemes. Confirm the SQL migrations and branch permissions.");return;}
    const cs=(c.data??[]) as Customer[]; const ss=(s.data??[]) as Scheme[]; const es=(e.data??[]) as Enrolment[];
    setCustomers(cs);setSchemes(ss);setEnrolments(es);
    if(!cs.some(x=>x.id===customerId))setCustomerId(cs[0]?.id??"");
    const sids=ss.map(x=>x.id);
    let vs:Version[]=[];
    if(sids.length){const result=await supabase.from("scheme_versions").select("id,scheme_id,version_no,terms").eq("tenant_id",tenantId).in("scheme_id",sids); if(result.error){setError("Could not load the published terms versions.");return;} vs=(result.data??[]) as Version[];}
    vs=vs.filter(v=>ss.some(sch=>sch.id===v.scheme_id&&sch.current_version===v.version_no));setVersions(vs);
    if(!vs.some(v=>v.id===versionId))setVersionId(vs[0]?.id??"");
    if(es.length){const ir=await supabase.from("scheme_installments").select("id,enrolment_id,installment_no,due_date,amount_due,amount_paid,status").eq("tenant_id",tenantId).in("enrolment_id",es.map(x=>x.id)).order("due_date").limit(500);if(!ir.error)setInstallments((ir.data??[]) as Installment[]);else setInstallments([]);}else setInstallments([]);
  },[tenantId,customerId,versionId]);

  useEffect(()=>{void load()},[load]);
  const currentMember=memberships.find(m=>m.tenant_id===tenantId);
  const selectedVersion=versions.find(v=>v.id===versionId);
  const selectedScheme=schemes.find(s=>s.id===selectedVersion?.scheme_id);
  const customerMap=useMemo(()=>new Map(customers.map(c=>[c.id,c])),[customers]);

  async function createEnrolment(event:FormEvent<HTMLFormElement>){
    event.preventDefault();setError("");setNotice("");
    if(!accepted){setError("Confirm the customer has received and accepted the displayed scheme terms.");return;}
    if(!tenantId||!customerId||!versionId){setError("Select a customer and a currently published scheme.");return;}
    setSaving(true);
    try{const supabase=createClient();const {data,error}=await supabase.rpc("create_scheme_enrolment",{p_tenant_id:tenantId,p_branch_id:currentMember?.branch_id??null,p_customer_id:customerId,p_scheme_version_id:versionId,p_terms_accepted:true});
      if(error){setError("Enrolment could not be created. Verify that the scheme is published, its terms are complete, and the selected branch has access.");return;}
      setNotice("Enrolment "+String(data).slice(0,8)+"… created with a terms snapshot. Instalment schedule, where applicable, was generated in the database.");setAccepted(false);await load();
    }catch{setError("Unable to create enrolment. Check the connection and retry.");}finally{setSaving(false);}
  }

  const money=(v:number)=>new Intl.NumberFormat("en-IN",{style:"currency",currency:"INR",maximumFractionDigits:2}).format(Number(v));
  const termsText=(terms:Record<string,unknown>)=>[
    terms.tenure_months?String(terms.tenure_months)+" months":"",
    terms.monthly_instalment_inr?"₹"+Number(terms.monthly_instalment_inr).toLocaleString("en-IN")+" monthly":"",
    terms.benefit_type?"Benefit: "+String(terms.benefit_type).replaceAll("_"," "):"",
    terms.valuation_method?"Valuation: "+String(terms.valuation_method).replaceAll("_"," "):""
  ].filter(Boolean).join(" · ");

  return <main><div className="page-wrap">
    <Link className="link-text small" href="/dashboard"><ArrowLeft size={13} style={{display:"inline",verticalAlign:"middle"}}/> Back to workspace</Link>
    <div style={{marginTop:20,marginBottom:24}}><div className="eyebrow"><ClipboardList size={14}/> Scheme lifecycle</div><h1 style={{marginTop:12}}>Enrolments</h1><p className="lead">Enrol a customer into a published scheme version. The accepted terms snapshot and any monthly due-date schedule are stored together.</p></div>
    {error&&<div role="alert" className="notice" style={{marginBottom:14}}><CircleAlert size={16}/>{error}</div>}
    {notice&&<div className="notice" style={{marginBottom:14,color:"#1f5c3e",background:"#edf7ef",borderColor:"#cfe4d4"}}>{notice}</div>}
    {loading?<div className="panel">Loading your shop’s customers and schemes…</div>:memberships.length===0?<div className="panel"><h2>Set up your shop first</h2><Link href="/onboarding" className="btn btn-primary">Start onboarding</Link></div>:<div className="calc-layout">
      <section className="panel"><h2>New scheme enrolment</h2><p className="small muted">Only published schemes can accept enrolments. The customer acceptance checkbox is a staff attestation; retain consent evidence according to shop policy.</p>
        {customers.length===0?<div className="notice">Add a customer before starting an enrolment. <Link className="link-text" href="/customers">Open customer management</Link></div>:schemes.length===0?<div className="notice">No published schemes are available. Create and publish reviewed terms in <Link className="link-text" href="/schemes">Schemes</Link>.</div>:<form onSubmit={createEnrolment}>
          <div className="field"><label htmlFor="customer">Customer *</label><select id="customer" value={customerId} onChange={e=>setCustomerId(e.target.value)}>{customers.map(c=><option key={c.id} value={c.id}>{c.full_name} · {c.customer_code} · {c.mobile_e164}</option>)}</select></div>
          <div className="field" style={{marginTop:14}}><label htmlFor="scheme">Published scheme version *</label><select id="scheme" value={versionId} onChange={e=>setVersionId(e.target.value)}>{versions.map(v=>{const s=schemes.find(x=>x.id===v.scheme_id);return <option key={v.id} value={v.id}>{s?.name??"Scheme"} · v{v.version_no}</option>})}</select></div>
          {selectedVersion&&<div style={{background:"#f4f5ef",borderRadius:12,padding:14,marginTop:14}}><strong>{selectedScheme?.name}</strong><p className="small muted" style={{margin:"7px 0 0"}}>{termsText(selectedVersion.terms)||"Review published scheme terms with the customer."}</p><p className="small muted" style={{margin:"7px 0 0"}}>These exact terms will be stored with the enrolment; later versions do not change this enrolment automatically.</p></div>}
          <label style={{display:"flex",gap:9,alignItems:"flex-start",fontSize:12,lineHeight:1.55,marginTop:16}}><input type="checkbox" required checked={accepted} onChange={e=>setAccepted(e.target.checked)}/><span>I confirm the customer received and accepted this scheme’s displayed version and terms; the shop will retain its consent evidence.</span></label>
          <button className="btn btn-primary" type="submit" disabled={saving||!versionId||!customerId} style={{width:"100%",marginTop:18}}>{saving?"Creating enrolment…":<><Plus size={15}/> Create enrolment</>}</button>
        </form>}
      </section>
      <section className="panel"><div className="section-head" style={{marginTop:0}}><div><h2>Recent enrolments</h2><p className="small muted">{enrolments.length} recent records</p></div><span className="pill pill-green">Tenant scoped</span></div>
        {enrolments.length===0?<p className="small muted">No enrolments recorded yet.</p>:<div style={{display:"grid",gap:11}}>{enrolments.map(e=>{const c=customerMap.get(e.customer_id);const payments=installments.filter(i=>i.enrolment_id===e.id);const total=payments.reduce((sum,i)=>sum+Number(i.amount_due),0);const paid=payments.reduce((sum,i)=>sum+Number(i.amount_paid),0);return <article className="list-card" key={e.id} style={{display:"block"}}><div style={{display:"flex",justifyContent:"space-between",gap:12}}><div><strong>{e.enrolment_code}</strong><div className="small muted" style={{marginTop:4}}>{c?.full_name??"Customer"} · {c?.customer_code??""}</div></div><span className={"pill "+(e.status==="active"?"pill-green":"pill-demo")}>{e.status}</span></div><div className="small muted" style={{marginTop:8}}>Started {e.start_date}{e.maturity_date?" · Maturity "+e.maturity_date:""}</div>{payments.length>0&&<div style={{marginTop:11,background:"#f4f5ef",padding:10,borderRadius:10}}><div style={{display:"flex",justifyContent:"space-between",gap:12,fontSize:12}}><span>Instalments paid</span><strong>{payments.filter(i=>i.status==="paid").length} / {payments.length}</strong></div><div className="small muted" style={{marginTop:4}}>Scheduled {money(total)} · Paid {money(paid)}</div></div>}</article>})}</div>}
      </section>
    </div>}
    <div className="notice" style={{marginTop:18}}><ShieldCheck size={16} style={{flexShrink:0}}/><span>Payment, maturity benefit and redemption eligibility must be calculated from confirmed ledger events and published terms—not from enrolment alone.</span></div>
  </div></main>;
}
