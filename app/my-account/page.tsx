"use client";

import Link from "next/link";
import { FormEvent, useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowLeft, CircleAlert, Coins, Link2, LogOut, Receipt, ShieldCheck } from "lucide-react";
import { createClient } from "@/lib/supabase/client";

type LinkRow={tenant_id:string;customer_id:string;tenants:{display_name:string;slug:string}|null};
type Customer={id:string;tenant_id:string;customer_code:string;full_name:string;mobile_e164:string;city:string|null;status:string};
type Enrolment={id:string;tenant_id:string;customer_id:string;enrolment_code:string;status:string;start_date:string;maturity_date:string|null;agreed_terms:Record<string,unknown>;scheme_version_id:string};
type Payment={id:string;tenant_id:string;customer_id:string|null;enrolment_id:string|null;amount:number;payment_method:string;status:string;reference:string|null;created_at:string;confirmed_at:string|null};
type Installment={id:string;tenant_id:string;enrolment_id:string;installment_no:number;due_date:string;amount_due:number;amount_paid:number;status:string};
type ReceiptRow={id:string;tenant_id:string;receipt_number:string;receipt_type:string;payment_id:string|null;enrolment_id:string|null;issued_at:string;snapshot:Record<string,unknown>};

export default function CustomerPortalPage(){
 const router=useRouter();
 const [links,setLinks]=useState<LinkRow[]>([]);const [customers,setCustomers]=useState<Customer[]>([]);const [enrolments,setEnrolments]=useState<Enrolment[]>([]);const [payments,setPayments]=useState<Payment[]>([]);const [installments,setInstallments]=useState<Installment[]>([]);const [receipts,setReceipts]=useState<ReceiptRow[]>([]);
 const [slug,setSlug]=useState("");const [linking,setLinking]=useState(false);const [loading,setLoading]=useState(true);const [error,setError]=useState("");const [notice,setNotice]=useState("");
 const load=useCallback(async()=>{
  const supabase=createClient();const {data:{user}}=await supabase.auth.getUser();if(!user){router.replace("/login");return;}
  const linkResult=await supabase.from("customer_auth_links").select("tenant_id,customer_id,tenants(display_name,slug)").eq("auth_user_id",user.id).not("verified_at","is",null);
  if(linkResult.error){setError("Could not load linked customer profiles. Check database migrations and authentication settings.");return;}
  const linkRows=(linkResult.data??[]) as unknown as LinkRow[];setLinks(linkRows);
  if(!linkRows.length){setCustomers([]);setEnrolments([]);setPayments([]);setInstallments([]);setReceipts([]);return;}
  const collectedCustomers:Customer[]=[];const collectedEnrolments:Enrolment[]=[];const collectedPayments:Payment[]=[];const collectedInstallments:Installment[]=[];const collectedReceipts:ReceiptRow[]=[];
  for(const link of linkRows){
    const [c,e,p]=await Promise.all([
      supabase.from("tenant_customers").select("id,tenant_id,customer_code,full_name,mobile_e164,city,status").eq("tenant_id",link.tenant_id).eq("id",link.customer_id).maybeSingle(),
      supabase.from("scheme_enrolments").select("id,tenant_id,customer_id,enrolment_code,status,start_date,maturity_date,agreed_terms,scheme_version_id").eq("tenant_id",link.tenant_id).eq("customer_id",link.customer_id).order("created_at",{ascending:false}).limit(200),
      supabase.from("payments").select("id,tenant_id,customer_id,enrolment_id,amount,payment_method,status,reference,created_at,confirmed_at").eq("tenant_id",link.tenant_id).eq("customer_id",link.customer_id).order("created_at",{ascending:false}).limit(200)
    ]);
    if(c.data)collectedCustomers.push(c.data as Customer);
    if(e.data)collectedEnrolments.push(...(e.data as Enrolment[]));
    if(p.data)collectedPayments.push(...(p.data as Payment[]));
  }
  for(const link of linkRows){
    const tenantEnrolments=collectedEnrolments.filter(e=>e.tenant_id===link.tenant_id);
    if(tenantEnrolments.length){
      const [i,r]=await Promise.all([
        supabase.from("scheme_installments").select("id,tenant_id,enrolment_id,installment_no,due_date,amount_due,amount_paid,status").eq("tenant_id",link.tenant_id).in("enrolment_id",tenantEnrolments.map(e=>e.id)).order("due_date").limit(1000),
        supabase.from("receipts").select("id,tenant_id,receipt_number,receipt_type,payment_id,enrolment_id,issued_at,snapshot").eq("tenant_id",link.tenant_id).order("issued_at",{ascending:false}).limit(500)
      ]);
      if(i.data)collectedInstallments.push(...(i.data as Installment[]));
      if(r.data)collectedReceipts.push(...(r.data as ReceiptRow[]));
    } else {
      const r=await supabase.from("receipts").select("id,tenant_id,receipt_number,receipt_type,payment_id,enrolment_id,issued_at,snapshot").eq("tenant_id",link.tenant_id).order("issued_at",{ascending:false}).limit(500);
      if(r.data)collectedReceipts.push(...(r.data as ReceiptRow[]));
    }
  }
  setCustomers(collectedCustomers);setEnrolments(collectedEnrolments);setPayments(collectedPayments);setInstallments(collectedInstallments);setReceipts(collectedReceipts);
 },[router]);

 useEffect(()=>{let active=true;void(async()=>{try{await load()}catch{if(active)setError("Customer portal is not available. Check the Supabase configuration.")}finally{if(active)setLoading(false)}})();return()=>{active=false}},[load]);

 async function linkShop(event:FormEvent<HTMLFormElement>){event.preventDefault();setError("");setNotice("");setLinking(true);try{const supabase=createClient();const {error}=await supabase.rpc("link_my_customer_profile_by_slug",{p_shop_slug:slug.trim()});if(error){setError("Profile linking failed. Sign in using the same verified mobile number registered with the shop and check the shop URL slug.");return;}setNotice("Customer account linked to the shop successfully.");setSlug("");await load();}catch{setError("Unable to link the shop profile. Verify the mobile number and try again.")}finally{setLinking(false)}}

 async function logout(){const supabase=createClient();await supabase.auth.signOut();router.replace("/login");router.refresh();}
 const money=(v:number)=>new Intl.NumberFormat("en-IN",{style:"currency",currency:"INR",maximumFractionDigits:2}).format(Number(v));
 const customerByTenant=new Map(customers.map(c=>[c.tenant_id,c]));
 const linkedCustomerTotal=payments.filter(p=>p.status==="confirmed").reduce((sum,p)=>sum+Number(p.amount),0);
 const outstanding=installments.filter(i=>!["paid","waived","cancelled"].includes(i.status)).reduce((sum,i)=>sum+Math.max(0,Number(i.amount_due)-Number(i.amount_paid)),0);
 return <main><div className="page-wrap">
  <div style={{display:"flex",justifyContent:"space-between",alignItems:"start",gap:14,flexWrap:"wrap"}}><div><Link className="link-text small" href="/"><ArrowLeft size={13} style={{display:"inline",verticalAlign:"middle"}}/> Gold home</Link><div className="eyebrow" style={{marginTop:20}}><Coins size={14}/> Customer savings portal</div><h1 style={{marginTop:12}}>My Gold account</h1><p className="lead">View your linked shop profiles, scheme progress, confirmed payments and receipts. Each shop connection is verified separately.</p></div><button className="btn btn-secondary" type="button" onClick={()=>void logout()}><LogOut size={15}/> Sign out</button></div>
  {error&&<div role="alert" className="notice" style={{marginBottom:14}}><CircleAlert size={16}/>{error}</div>}{notice&&<div className="notice" style={{marginBottom:14,color:"#1f5c3e",background:"#edf7ef",borderColor:"#cfe4d4"}}>{notice}</div>}
  {loading?<div className="panel">Loading your linked shop records…</div>:<><div className="dashboard-grid"><div className="metric-card"><div className="small muted">Confirmed payments</div><div className="metric-value">{money(linkedCustomerTotal)}</div><p className="small muted">From payment records linked to your account</p></div><div className="metric-card"><div className="small muted">Savings schemes</div><div className="metric-value">{enrolments.length}</div><p className="small muted">Across {links.length} linked shop(s)</p></div><div className="metric-card"><div className="small muted">Scheduled outstanding</div><div className="metric-value">{money(outstanding)}</div><p className="small muted">Due amounts after recorded instalment allocations</p></div></div>
  <div className="calc-layout" style={{marginTop:18}}><section className="panel"><h2>Link a jewellery shop</h2><p className="small muted">Use the shop URL slug given by your jewellery shop. Your Supabase Auth phone number must already be verified and must match the mobile registered by the shop.</p><form onSubmit={linkShop}><div className="field"><label htmlFor="shopSlug">Shop URL slug *</label><input id="shopSlug" value={slug} onChange={e=>setSlug(e.target.value.toLowerCase().trim())} required maxLength={60} pattern="[a-z0-9]+(-[a-z0-9]+)*" placeholder="sri-lakshmi-gold-house"/></div><button className="btn btn-primary" type="submit" disabled={linking} style={{width:"100%",marginTop:16}}>{linking?"Verifying profile…":<><Link2 size={15}/> Verify and link account</>}</button></form><div className="notice" style={{marginTop:16}}><ShieldCheck size={15} style={{flexShrink:0}}/><span>Gold never lets you choose another customer&apos;s ID to link. It matches your verified Auth mobile number on the server and records an audit event.</span></div></section>
  <section className="panel"><h2>Linked shops</h2>{links.length===0?<p className="small muted">No customer profile is linked yet. Link a shop above after signing in with your verified registered mobile number.</p>:<div style={{display:"grid",gap:11}}>{links.map(link=>{const c=customerByTenant.get(link.tenant_id);const shopEnrolments=enrolments.filter(e=>e.tenant_id===link.tenant_id);return <article className="list-card" key={link.tenant_id} style={{display:"block"}}><div style={{display:"flex",justifyContent:"space-between",gap:12}}><div><strong>{link.tenants?.display_name??"Jewellery shop"}</strong><div className="small muted" style={{marginTop:4}}>{c?.full_name??"Customer profile"} · Customer ID {c?.customer_code??""}</div><div className="small muted" style={{marginTop:4}}>{c?.mobile_e164??""} {c?.city?"· "+c.city:""}</div></div><span className="pill pill-green">Verified link</span></div><div className="small muted" style={{marginTop:10}}>{shopEnrolments.length} scheme enrolment(s) · {payments.filter(p=>p.tenant_id===link.tenant_id&&p.status==="confirmed").length} confirmed payment(s)</div></article>})}</div>}</section></div>
  <section className="panel" style={{marginTop:18}}><h2>My savings schemes</h2>{enrolments.length===0?<p className="small muted">No scheme enrolments are linked to your customer profiles yet.</p>:<div style={{display:"grid",gap:12}}>{enrolments.map(e=>{const customer=customerByTenant.get(e.tenant_id);const schedule=installments.filter(i=>i.enrolment_id===e.id);const scheduled=schedule.reduce((sum,i)=>sum+Number(i.amount_due),0);const paid=schedule.reduce((sum,i)=>sum+Number(i.amount_paid),0);const weight=payments.filter(p=>p.enrolment_id===e.id&&p.status==="confirmed");return <article className="list-card" key={e.id} style={{display:"block"}}><div style={{display:"flex",justifyContent:"space-between",gap:12,flexWrap:"wrap"}}><div><strong>{e.enrolment_code}</strong><div className="small muted" style={{marginTop:4}}>{(links.find(l=>l.tenant_id===e.tenant_id)?.tenants?.display_name??"")}{customer?" · ":""}{customerByTenant.get(e.tenant_id)?.full_name??"Customer"}</div></div><span className={"pill "+(e.status==="active"?"pill-green":"pill-demo")}>{e.status}</span></div><div className="small muted" style={{marginTop:8}}>Started {e.start_date}{e.maturity_date?" · Maturity "+e.maturity_date:""}</div><div className="breakdown-row"><span>Confirmed scheme contributions</span><strong>{money(weight.reduce((sum,p)=>sum+Number(p.amount),0))}</strong></div>{schedule.length>0&&<><div className="breakdown-row"><span>Scheduled instalments</span><strong>{schedule.filter(i=>i.status==="paid").length} / {schedule.length}</strong></div><div className="breakdown-row total"><span>Scheduled paid / outstanding</span><strong>{money(paid)} / {money(Math.max(0,scheduled-paid))}</strong></div></>}<p className="small muted" style={{marginTop:8,marginBottom:0}}>Benefits are governed by the version of the scheme terms accepted at enrolment. This portal reports confirmed records; it does not promise unapproved benefits.</p></article>})}</div>}</section>
  <div className="calc-layout" style={{marginTop:18}}><section className="panel"><h2>Payment history</h2>{payments.length===0?<p className="small muted">No payment records found for linked profiles.</p>:<div style={{display:"grid",gap:9}}>{payments.map(p=><article className="list-card" key={p.id}><div style={{minWidth:0}}><strong>{money(Number(p.amount))}</strong><div className="small muted" style={{marginTop:4}}>{p.payment_method.replaceAll("_"," ")} · {new Date(p.created_at).toLocaleString("en-IN",{timeZone:"Asia/Kolkata"})}</div>{p.reference&&<div className="small muted">Ref: {p.reference}</div>}</div><span className={"pill "+(p.status==="confirmed"?"pill-green":"pill-demo")}>{p.status}</span></article>)}</div>}</section><section className="panel"><h2>Receipts & instalments</h2><h3 style={{marginTop:15}}>Recent receipts</h3>{receipts.length===0?<p className="small muted">No receipts found for the linked records.</p>:<div style={{display:"grid",gap:8}}>{receipts.slice(0,30).map(r=><article className="list-card" key={r.id}><div><strong>{r.receipt_number}</strong><div className="small muted">{r.receipt_type.replaceAll("_"," ")} · {new Date(r.issued_at).toLocaleDateString("en-IN")}</div></div><Receipt size={16}/></article>)}</div>}<h3 style={{marginTop:22}}>Upcoming instalments</h3>{installments.filter(i=>!["paid","waived","cancelled"].includes(i.status)).sort((a,b)=>a.due_date.localeCompare(b.due_date)).slice(0,20).map(i=><article className="list-card" key={i.id} style={{marginTop:8}}><div><strong>{i.due_date}</strong><div className="small muted">Instalment {i.installment_no} · {i.status}</div></div><strong>{money(Math.max(0,Number(i.amount_due)-Number(i.amount_paid)))}</strong></article>)}{installments.filter(i=>!["paid","waived","cancelled"].includes(i.status)).length===0&&<p className="small muted">No unpaid instalments are currently scheduled.</p>}</section></div>
  </>}
 </div></main>;
}
