"use client";

import Link from "next/link";
import { FormEvent, useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowLeft, CircleAlert, Receipt, ShieldCheck } from "lucide-react";
import { createClient } from "@/lib/supabase/client";

type Membership={tenant_id:string;branch_id:string|null;role:string;tenants:{display_name:string;slug:string}|null};
type Customer={id:string;full_name:string;customer_code:string;mobile_e164:string};
type Enrolment={id:string;enrolment_code:string;customer_id:string;status:string;scheme_version_id:string};
type Payment={id:string;tenant_id:string;branch_id:string|null;customer_id:string|null;enrolment_id:string|null;payment_method:string;status:string;amount:number;reference:string|null;created_at:string;confirmed_at:string|null};
type ReceiptRow={receipt_number:string;receipt_type:string;payment_id:string|null;issued_at:string};

export default function CollectionsPage(){
 const router=useRouter();
 const [memberships,setMemberships]=useState<Membership[]>([]);const [tenantId,setTenantId]=useState("");
 const [customers,setCustomers]=useState<Customer[]>([]);const [enrolments,setEnrolments]=useState<Enrolment[]>([]);
 const [customerId,setCustomerId]=useState("");const [enrolmentId,setEnrolmentId]=useState("");
 const [amount,setAmount]=useState("");const [method,setMethod]=useState("cash");const [reference,setReference]=useState("");const [notes,setNotes]=useState("");
 const [payments,setPayments]=useState<Payment[]>([]);const [receipts,setReceipts]=useState<ReceiptRow[]>([]);
 const [loading,setLoading]=useState(true);const [saving,setSaving]=useState(false);const [error,setError]=useState("");const [notice,setNotice]=useState("");

 useEffect(()=>{let active=true;void(async()=>{try{const supabase=createClient();const {data:{user}}=await supabase.auth.getUser();if(!user){router.replace("/login");return;}const {data,error}=await supabase.from("tenant_memberships").select("tenant_id,branch_id,role,tenants(display_name,slug)").eq("user_id",user.id).eq("is_active",true);if(error)throw error;if(!active)return;const rows=(data??[]) as unknown as Membership[];setMemberships(rows);setTenantId(rows[0]?.tenant_id??"");}catch{if(active)setError("Could not load shop access. Check migrations and Supabase configuration.");}finally{if(active)setLoading(false);}})();return()=>{active=false}},[router]);

 const load=useCallback(async()=>{if(!tenantId){setCustomers([]);setEnrolments([]);setPayments([]);setReceipts([]);return;}const supabase=createClient();
 const [c,e,p,r]=await Promise.all([
 supabase.from("tenant_customers").select("id,full_name,customer_code,mobile_e164").eq("tenant_id",tenantId).eq("status","active").order("full_name").limit(500),
 supabase.from("scheme_enrolments").select("id,enrolment_code,customer_id,status,scheme_version_id").eq("tenant_id",tenantId).in("status",["active","pending"]).order("created_at",{ascending:false}).limit(500),
 supabase.from("payments").select("id,tenant_id,branch_id,customer_id,enrolment_id,payment_method,status,amount,reference,created_at,confirmed_at").eq("tenant_id",tenantId).order("created_at",{ascending:false}).limit(100),
 supabase.from("receipts").select("receipt_number,receipt_type,payment_id,issued_at").eq("tenant_id",tenantId).order("issued_at",{ascending:false}).limit(100)
 ]);
 if(c.error||e.error||p.error){setError("Could not load collection records. Check shop permissions and applied SQL.");return;}
 setCustomers((c.data??[]) as Customer[]);setEnrolments((e.data??[]) as Enrolment[]);setPayments((p.data??[]) as Payment[]);setReceipts((r.data??[]) as ReceiptRow[]);
 },[tenantId]);
 useEffect(()=>{void load()},[load]);
 const member=memberships.find(m=>m.tenant_id===tenantId);const selectedEnrolment=enrolments.find(e=>e.id===enrolmentId);
 async function submit(event:FormEvent<HTMLFormElement>){event.preventDefault();setError("");setNotice("");if(!tenantId||!member){setError("Select a shop first.");return;}const v=Number(amount);if(!Number.isFinite(v)||v<=0){setError("Enter a payment amount greater than zero.");return;}if(enrolmentId&&selectedEnrolment&&customerId&&customerId!==selectedEnrolment.customer_id){setError("Selected customer does not match the scheme enrolment.");return;}setSaving(true);
 try{const supabase=createClient();const {data,error}=await supabase.rpc("record_manual_payment",{p_tenant_id:tenantId,p_branch_id:member.branch_id,p_customer_id:enrolmentId?(selectedEnrolment?.customer_id??customerId||null):(customerId||null),p_enrolment_id:enrolmentId||null,p_amount:v,p_method:method,p_reference:reference.trim()||null,p_idempotency_key:crypto.randomUUID(),p_notes:notes.trim()||null});
 if(error){setError("Payment not recorded. Verify your role, branch, the enrolment status, and that the method is a staff-collected payment (not a gateway payment).");return;}
 setNotice("Payment confirmed by staff. The receipt and any available instalment allocation were recorded atomically. Payment ID: "+String(data));setAmount("");setReference("");setNotes("");setEnrolmentId("");await load();
 }catch{setError("Unable to record the payment. Check the connection.");}finally{setSaving(false);}}
 const money=(v:number)=>new Intl.NumberFormat("en-IN",{style:"currency",currency:"INR",maximumFractionDigits:2}).format(Number(v));
 const customerById=new Map(customers.map(c=>[c.id,c]));
 const receiptByPayment=new Map(receipts.filter(r=>r.payment_id).map(r=>[r.payment_id!,r.receipt_number]));
 const total=payments.filter(p=>p.status==="confirmed").reduce((s,p)=>s+Number(p.amount),0);
 return <main><div className="page-wrap"><Link className="link-text small" href="/dashboard"><ArrowLeft size={13} style={{display:"inline",verticalAlign:"middle"}}/> Back to workspace</Link>
 <div style={{marginTop:20,marginBottom:24}}><div className="eyebrow"><Receipt size={14}/> Collections & receipts</div><h1 style={{marginTop:12}}>Collections</h1><p className="lead">Record cash, UPI, cheque or bank-transfer collections with idempotency protection, an audit event, receipt snapshot and automatic FIFO instalment allocation where a schedule exists.</p></div>
 {error&&<div role="alert" className="notice" style={{marginBottom:14}}><CircleAlert size={16}/>{error}</div>}
 {notice&&<div className="notice" style={{marginBottom:14,color:"#1f5c3e",background:"#edf7ef",borderColor:"#cfe4d4"}}>{notice}</div>}
 {loading?<div className="panel">Loading collections…</div>:memberships.length===0?<div className="panel"><h2>No shop linked</h2><Link href="/onboarding" className="btn btn-primary">Set up your shop</Link></div>:<div className="calc-layout">
 <section className="panel"><h2>Record a payment</h2><p className="small muted">Use only after cash/bank/UPI collection has actually been received and verified by authorised staff.</p>
 {memberships.length>1&&<div className="field" style={{marginBottom:14}}><label htmlFor="tenant">Shop</label><select id="tenant" value={tenantId} onChange={e=>setTenantId(e.target.value)}>{memberships.map(m=><option key={m.tenant_id} value={m.tenant_id}>{m.tenants?.display_name??m.tenant_id}</option>)}</select></div>}
 <form onSubmit={submit}>
 <div className="field"><label htmlFor="customer">Customer (optional for non-scheme payment)</label><select id="customer" value={customerId} onChange={e=>setCustomerId(e.target.value)}><option value="">No customer linked</option>{customers.map(c=><option key={c.id} value={c.id}>{c.full_name} · {c.customer_code} · {c.mobile_e164}</option>)}</select></div>
 <div className="field" style={{marginTop:14}}><label htmlFor="enrolment">Scheme enrolment (optional)</label><select id="enrolment" value={enrolmentId} onChange={e=>{const id=e.target.value;setEnrolmentId(id);const en=enrolments.find(x=>x.id===id);if(en)setCustomerId(en.customer_id);}}><option value="">No scheme enrolment</option>{enrolments.map(e=><option key={e.id} value={e.id}>{e.enrolment_code} · {customerById.get(e.customer_id)?.full_name??"Customer"} · {e.status}</option>)}</select></div>
 <div className="form-grid" style={{marginTop:14}}><div className="field"><label htmlFor="amount">Amount (₹) *</label><input id="amount" type="number" min="0.01" step="0.01" value={amount} onChange={e=>setAmount(e.target.value)} required/></div><div className="field"><label htmlFor="method">Payment method *</label><select id="method" value={method} onChange={e=>setMethod(e.target.value)}><option value="cash">Cash</option><option value="upi">UPI (received and verified)</option><option value="bank_transfer">Bank transfer</option><option value="cheque">Cheque (as permitted)</option><option value="other">Other staff-collected</option></select></div></div>
 <div className="field" style={{marginTop:14}}><label htmlFor="reference">Transaction / receipt reference</label><input id="reference" value={reference} onChange={e=>setReference(e.target.value)} maxLength={180}/></div>
 <div className="field" style={{marginTop:14}}><label htmlFor="notes">Notes</label><input id="notes" value={notes} onChange={e=>setNotes(e.target.value)} maxLength={500}/></div>
 <button className="btn btn-primary" type="submit" disabled={saving} style={{width:"100%",marginTop:18}}>{saving?"Recording payment…":"Confirm collected payment"}</button>
 </form>
 <div className="notice" style={{marginTop:16}}><ShieldCheck size={15} style={{flexShrink:0}}/><span>Gateway, card and online UPI checkout payments cannot be confirmed using this staff form. Those require provider signatures and verified webhooks.</span></div></section>
 <section className="panel"><h2>Recent collection summary</h2><div className="result-hero" style={{marginTop:14}}><div className="label">Confirmed payments in the latest 100 records</div><strong>{money(total)}</strong><div className="label">{payments.filter(p=>p.status==="confirmed").length} confirmed transaction(s)</div></div>
 <div style={{display:"grid",gap:10,marginTop:15}}>{payments.length===0?<p className="small muted">No payment records found yet.</p>:payments.map(p=><article className="list-card" key={p.id} style={{alignItems:"flex-start"}}><div style={{minWidth:0}}><strong>{money(Number(p.amount))}</strong><div className="small muted" style={{marginTop:4}}>{customerById.get(p.customer_id??"")?.full_name??"No customer"} · {p.payment_method.replaceAll("_"," ")}</div><div className="small muted" style={{marginTop:4}}>{receiptByPayment.get(p.id)??"Receipt not found"} · {new Date(p.created_at).toLocaleString("en-IN",{timeZone:"Asia/Kolkata"})}</div>{p.reference&&<div className="small muted">Ref: {p.reference}</div>}</div><span className={"pill "+(p.status==="confirmed"?"pill-green":"pill-demo")}>{p.status}</span></article>)}</div>
 </section></div>}
 </div></main>;
}
