"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowLeft, BarChart3, CircleAlert, Download, RefreshCw } from "lucide-react";
import { createClient } from "@/lib/supabase/client";

type Membership={tenant_id:string;branch_id:string|null;role:string;tenants:{display_name:string;slug:string}|null};
type Branch={id:string;name:string;branch_code:string};
type Payment={id:string;amount:number;status:string;payment_method:string;created_at:string;confirmed_at:string|null;branch_id:string|null};
type Invoice={id:string;invoice_number:string;status:string;total_amount:number;invoice_date:string;created_at:string;branch_id:string|null};
type CreditNote={id:string;credit_note_number:string;status:string;total_amount:number;created_at:string;issued_at:string|null;branch_id:string|null};
type Enrolment={id:string;status:string;maturity_date:string|null;start_date:string;branch_id:string};
type Installment={id:string;status:string;amount_due:number;amount_paid:number;due_date:string;branch_id:string};

function dateInIndia(d:Date){return new Intl.DateTimeFormat("en-CA",{timeZone:"Asia/Kolkata",year:"numeric",month:"2-digit",day:"2-digit"}).format(d);}
function startIndiaDay(day:string){return new Date(day+"T00:00:00+05:30").toISOString();}
function nextDate(day:string){const d=new Date(day+"T00:00:00Z");d.setUTCDate(d.getUTCDate()+1);return d.toISOString().slice(0,10);}

export default function ReportsPage(){
 const router=useRouter();
 const [memberships,setMemberships]=useState<Membership[]>([]);
 const [tenantId,setTenantId]=useState("");
 const [branches,setBranches]=useState<Branch[]>([]);
 const [branchId,setBranchId]=useState("");
 const [fromDate,setFromDate]=useState(()=>dateInIndia(new Date()));
 const [toDate,setToDate]=useState(()=>dateInIndia(new Date()));
 const [payments,setPayments]=useState<Payment[]>([]);
 const [invoices,setInvoices]=useState<Invoice[]>([]);
 const [creditNotes,setCreditNotes]=useState<CreditNote[]>([]);
 const [enrolments,setEnrolments]=useState<Enrolment[]>([]);
 const [installments,setInstallments]=useState<Installment[]>([]);
 const [customersCount,setCustomersCount]=useState(0);
 const [itemsCount,setItemsCount]=useState(0);
 const [authLoading,setAuthLoading]=useState(true);
 const [reportsLoading,setReportsLoading]=useState(false);
 const [error,setError]=useState("");
 const [lastRefreshed,setLastRefreshed]=useState<Date|null>(null);

 useEffect(()=>{let active=true;void(async()=>{try{
   const supabase=createClient();const {data:{user}}=await supabase.auth.getUser();
   if(!user){router.replace("/login");return;}
   const {data,error:membershipError}=await supabase.from("tenant_memberships").select("tenant_id,branch_id,role,tenants(display_name,slug)").eq("user_id",user.id).eq("is_active",true);
   if(membershipError)throw membershipError;if(!active)return;
   const rows=(data??[]) as unknown as Membership[];
   setMemberships(rows);setTenantId(rows[0]?.tenant_id??"");
   if(rows[0]?.branch_id)setBranchId(rows[0].branch_id);
 }catch{if(active)setError("Could not load report access.");}finally{if(active)setAuthLoading(false)}})();return()=>{active=false}},[router]);

 const load=useCallback(async()=>{
  if(!tenantId){setPayments([]);setInvoices([]);setCreditNotes([]);setEnrolments([]);setInstallments([]);setCustomersCount(0);setItemsCount(0);setBranches([]);return;}
  if(!fromDate||!toDate||fromDate>toDate){setError("Choose a valid report date range.");return;}
  setReportsLoading(true);setError("");
  try{
   const supabase=createClient();const start=startIndiaDay(fromDate);const end=startIndiaDay(nextDate(toDate));
   let paymentQuery=supabase.from("payments").select("id,amount,status,payment_method,created_at,confirmed_at,branch_id").eq("tenant_id",tenantId).gte("created_at",start).lt("created_at",end).order("created_at",{ascending:false}).limit(2000);
   let invoiceQuery=supabase.from("invoices").select("id,invoice_number,status,total_amount,invoice_date,created_at,branch_id").eq("tenant_id",tenantId).gte("invoice_date",fromDate).lte("invoice_date",toDate).order("created_at",{ascending:false}).limit(2000);
   let creditQuery=supabase.from("credit_notes").select("id,credit_note_number,status,total_amount,created_at,issued_at,branch_id").eq("tenant_id",tenantId).eq("status","issued").gte("issued_at",start).lt("issued_at",end).order("issued_at",{ascending:false}).limit(2000);
   let enrolmentQuery=supabase.from("scheme_enrolments").select("id,status,maturity_date,start_date,branch_id").eq("tenant_id",tenantId).limit(2000);
   let installmentQuery=supabase.from("scheme_installments").select("id,status,amount_due,amount_paid,due_date,branch_id").eq("tenant_id",tenantId).limit(2000);
   let customerQuery=supabase.from("tenant_customers").select("id",{count:"exact",head:true}).eq("tenant_id",tenantId);
   let stockQuery=supabase.from("inventory_items").select("id",{count:"exact",head:true}).eq("tenant_id",tenantId);
   if(branchId){paymentQuery=paymentQuery.eq("branch_id",branchId);invoiceQuery=invoiceQuery.eq("branch_id",branchId);creditQuery=creditQuery.eq("branch_id",branchId);enrolmentQuery=enrolmentQuery.eq("branch_id",branchId);installmentQuery=installmentQuery.eq("branch_id",branchId);customerQuery=customerQuery.eq("branch_id",branchId);stockQuery=stockQuery.eq("branch_id",branchId);}
   const [p,i,cn,e,s,c,stock,b]=await Promise.all([
    paymentQuery,invoiceQuery,creditQuery,enrolmentQuery,installmentQuery,customerQuery,stockQuery,
    supabase.from("branches").select("id,name,branch_code").eq("tenant_id",tenantId).eq("is_active",true).order("name")
   ]);
   if(p.error||i.error||cn.error||e.error||s.error||c.error||stock.error||b.error)throw new Error("Report queries failed");
   setPayments((p.data??[]) as Payment[]);setInvoices((i.data??[]) as Invoice[]);setCreditNotes((cn.data??[]) as CreditNote[]);
   setEnrolments((e.data??[]) as Enrolment[]);setInstallments((s.data??[]) as Installment[]);
   setCustomersCount(c.count??0);setItemsCount(stock.count??0);setBranches((b.data??[]) as Branch[]);setLastRefreshed(new Date());
  }catch{setError("Some report data could not be loaded. Check table permissions, RLS and the date range.");}
  finally{setReportsLoading(false);}
 },[tenantId,fromDate,toDate,branchId]);
 useEffect(()=>{void load()},[load]);

 const today=dateInIndia(new Date());
 const totalCollection=payments.filter(p=>p.status==="confirmed").reduce((sum,p)=>sum+Number(p.amount),0);
 const paymentsByMethod=useMemo(()=>{const grouped=new Map<string,{count:number;amount:number}>();for(const p of payments.filter(x=>x.status==="confirmed")){const old=grouped.get(p.payment_method)??{count:0,amount:0};grouped.set(p.payment_method,{count:old.count+1,amount:old.amount+Number(p.amount)});}return Array.from(grouped.entries()).sort((a,b)=>b[1].amount-a[1].amount)},[payments]);
 const activeSchemes=enrolments.filter(e=>e.status==="active").length;
 const overdue=installments.filter(i=>["upcoming","due","partial","overdue"].includes(i.status)&&i.due_date<today&&Number(i.amount_paid)<Number(i.amount_due));
 const outstanding=installments.filter(i=>!["paid","waived","cancelled"].includes(i.status)).reduce((sum,i)=>sum+Math.max(0,Number(i.amount_due)-Number(i.amount_paid)),0);
 const issuedInvoiceValue=invoices.filter(i=>i.status!=="draft"&&i.status!=="void").reduce((sum,i)=>sum+Number(i.total_amount),0);
 const creditedValue=creditNotes.reduce((sum,c)=>sum+Number(c.total_amount),0);
 const money=(v:number)=>new Intl.NumberFormat("en-IN",{style:"currency",currency:"INR",maximumFractionDigits:2}).format(Number(v)||0);

 function exportCsv(){
  const rows=[["Type","Reference","Date","Status","Amount INR","Method","Branch"],
   ...payments.map(p=>["Payment",p.id,p.created_at,p.status,String(p.amount),p.payment_method,branches.find(b=>b.id===p.branch_id)?.name??""]),
   ...invoices.map(i=>["Invoice",i.invoice_number,i.invoice_date,i.status,String(i.total_amount),"",branches.find(b=>b.id===i.branch_id)?.name??""]),
   ...creditNotes.map(c=>["Credit note",c.credit_note_number,c.issued_at??c.created_at,c.status,String(c.total_amount),"",branches.find(b=>b.id===c.branch_id)?.name??""])];
  const csv=rows.map(row=>row.map(value=>'"'+String(value??"").replaceAll('"','""')+'"').join(",")).join("\r\n");
  const blob=new Blob(["\ufeff"+csv],{type:"text/csv;charset=utf-8;"});const url=URL.createObjectURL(blob);const link=document.createElement("a");
  link.href=url;link.download="gold-report-"+fromDate+"-to-"+toDate+".csv";link.click();URL.revokeObjectURL(url);
 }

 return <main><div className="page-wrap">
  <Link className="link-text small" href="/dashboard"><ArrowLeft size={13} style={{display:"inline",verticalAlign:"middle"}}/> Back to workspace</Link>
  <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",gap:15,flexWrap:"wrap",marginTop:20,marginBottom:24}}>
   <div><div className="eyebrow"><BarChart3 size={14}/> Business intelligence</div><h1 style={{marginTop:12}}>Reports & analytics</h1><p className="lead">Tenant-scoped business metrics with a selectable reporting period and branch filter.</p></div>
   <div className="action-row" style={{marginTop:0}}><button className="btn btn-secondary" type="button" onClick={()=>void load()} disabled={reportsLoading}><RefreshCw size={14}/> {reportsLoading?"Refreshing…":"Refresh"}</button><button className="btn btn-primary" type="button" onClick={exportCsv} disabled={reportsLoading}><Download size={14}/> Export CSV</button></div>
  </div>
  {error&&<div role="alert" className="notice" style={{marginBottom:14}}><CircleAlert size={16}/>{error}</div>}
  {authLoading?<div className="panel">Loading report access…</div>:memberships.length===0?<div className="panel"><h2>No shop linked</h2><Link href="/onboarding" className="btn btn-primary">Set up your shop</Link></div>:<>
   <div className="form-grid" style={{marginBottom:18}}>
    <div className="field"><label htmlFor="tenant">Shop</label><select id="tenant" value={tenantId} onChange={e=>{setTenantId(e.target.value);setBranchId("");}}>{memberships.map(m=><option key={m.tenant_id} value={m.tenant_id}>{m.tenants?.display_name??m.tenant_id}</option>)}</select></div>
    <div className="field"><label htmlFor="report-from">From date</label><input id="report-from" type="date" value={fromDate} max={toDate||undefined} onChange={e=>setFromDate(e.target.value)}/></div>
    <div className="field"><label htmlFor="report-to">To date</label><input id="report-to" type="date" value={toDate} min={fromDate||undefined} onChange={e=>setToDate(e.target.value)}/></div>
    <div className="field"><label htmlFor="report-branch">Branch</label><select id="report-branch" value={branchId} onChange={e=>setBranchId(e.target.value)}><option value="">All accessible branches</option>{branches.map(b=><option key={b.id} value={b.id}>{b.name} · {b.branch_code}</option>)}</select></div>
   </div>
   <div className="dashboard-grid">
    <div className="metric-card"><div className="small muted">Confirmed collections in range</div><div className="metric-value">{money(totalCollection)}</div><p className="small muted" style={{marginBottom:0}}>{payments.filter(p=>p.status==="confirmed").length} confirmed payments · {fromDate} to {toDate}</p></div>
    <div className="metric-card"><div className="small muted">Issued invoice value in range</div><div className="metric-value">{money(issuedInvoiceValue)}</div><p className="small muted" style={{marginBottom:0}}>{invoices.filter(i=>i.status!=="draft"&&i.status!=="void").length} non-draft invoice(s)</p></div>
    <div className="metric-card"><div className="small muted">Issued credit notes in range</div><div className="metric-value">{money(creditedValue)}</div><p className="small muted" style={{marginBottom:0}}>{creditNotes.length} issued credit note(s), shown separately from cash refunds</p></div>
    <div className="metric-card"><div className="small muted">Customer profiles</div><div className="metric-value">{customersCount}</div><p className="small muted" style={{marginBottom:0}}>Current count for the selected branch, when filtered</p></div>
    <div className="metric-card"><div className="small muted">Active scheme members</div><div className="metric-value">{activeSchemes}</div><p className="small muted" style={{marginBottom:0}}>Across the selected branch where applicable</p></div>
    <div className="metric-card"><div className="small muted">Outstanding instalments</div><div className="metric-value">{money(outstanding)}</div><p className="small muted" style={{marginBottom:0}}>{overdue.length} overdue unpaid schedule(s) as of {today}</p></div>
    <div className="metric-card"><div className="small muted">Tracked stock items</div><div className="metric-value">{itemsCount}</div><p className="small muted" style={{marginBottom:0}}>Inventory items visible to your role</p></div>
   </div>
   <div className="calc-layout" style={{marginTop:20}}>
    <section className="panel"><h2>Collections by payment method</h2>{paymentsByMethod.length===0?<p className="small muted">No confirmed collections returned for this period.</p>:<div style={{display:"grid",gap:10,marginTop:12}}>{paymentsByMethod.map(([method,data])=><div className="list-card" key={method}><div><strong>{method.replaceAll("_"," ")}</strong><div className="small muted">{data.count} payment(s)</div></div><strong>{money(data.amount)}</strong></div>)}</div>}</section>
    <section className="panel"><h2>Due-date watchlist</h2>{installments.filter(i=>!["paid","waived","cancelled"].includes(i.status)).sort((a,b)=>a.due_date.localeCompare(b.due_date)).slice(0,20).map(i=><div key={i.id} className="list-card" style={{marginTop:8}}><div><strong>{i.due_date}</strong><div className="small muted">{i.status}</div></div><strong>{money(Math.max(0,Number(i.amount_due)-Number(i.amount_paid)))}</strong></div>)}{installments.length===0&&<p className="small muted">No instalment schedules found.</p>}</section>
   </div>
   <p className="small muted" style={{marginTop:14}}>Branch: {branches.find(b=>b.id===branchId)?.name??"All accessible branches"} · Last refreshed: {lastRefreshed?.toLocaleString("en-IN",{timeZone:"Asia/Kolkata"})??"—"}. Detail queries are capped at 2,000 records per source; use pagination before using exports for formal accounting and tax filing.</p>
  </>}
 </div></main>;
}
