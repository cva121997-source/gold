"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { ArrowLeft, Banknote, CheckCircle2, CircleAlert, Download, FileText, Plus, RefreshCw, ReceiptText, Undo2 } from "lucide-react";
import { createClient } from "@/lib/supabase/client";

type Membership={tenant_id:string;branch_id:string|null;role:string;tenants:{display_name:string;slug:string}|null};
type Branch={id:string;name:string;branch_code:string};
type Supplier={id:string;supplier_code:string;name:string;is_active:boolean};
type Order={id:string;tenant_id:string;branch_id:string;supplier_id:string;po_number:string;status:string;total_amount:number};
type Bill={id:string;tenant_id:string;branch_id:string;supplier_id:string;purchase_order_id:string|null;supplier_invoice_number:string|null;invoice_date:string;due_date:string|null;status:string;subtotal:number;tax_amount:number;total_amount:number;paid_amount:number;balance_amount:number;notes:string|null;source_reference:string|null;created_by:string;posted_at:string|null;price_variance_approved_by:string|null;price_variance_approved_at:string|null;price_variance_reason:string|null;created_at:string;updated_at:string};
type POLine={id:string;purchase_order_id:string;product_code:string;description:string;ordered_quantity:number;received_quantity:number;unit_cost:number;tax_rate:number};
type BillLine={id:string;supplier_bill_id:string;purchase_order_line_id:string|null;description:string;quantity:number;unit_cost:number;tax_rate:number;line_subtotal:number;tax_amount:number;line_total:number;notes:string|null};
type Payment={id:string;payment_number:string;amount:number;payment_method:string;payment_reference:string|null;payment_date:string;status:string;created_by:string;reversed_at:string|null;reversal_reason:string|null};
const today=()=>new Date().toISOString().slice(0,10);
const money=(n:number|null|undefined)=>new Intl.NumberFormat("en-IN",{style:"currency",currency:"INR",maximumFractionDigits:2}).format(Number(n??0));

export default function SupplierBillsPage(){
 const router=useRouter();
 const [userId,setUserId]=useState("");
 const [memberships,setMemberships]=useState<Membership[]>([]);
 const [tenantId,setTenantId]=useState("");
 const [branches,setBranches]=useState<Branch[]>([]);
 const [suppliers,setSuppliers]=useState<Supplier[]>([]);
 const [orders,setOrders]=useState<Order[]>([]);
 const [bills,setBills]=useState<Bill[]>([]);
 const [selectedId,setSelectedId]=useState("");
 const [lines,setLines]=useState<BillLine[]>([]);
 const [payments,setPayments]=useState<Payment[]>([]);
 const [poLines,setPoLines]=useState<POLine[]>([]);
 const [branchId,setBranchId]=useState("");
 const [supplierId,setSupplierId]=useState("");
 const [purchaseOrderId,setPurchaseOrderId]=useState("");
 const [invoiceNumber,setInvoiceNumber]=useState("");
 const [invoiceDate,setInvoiceDate]=useState(today());
 const [dueDate,setDueDate]=useState("");
 const [billNotes,setBillNotes]=useState("");
 const [sourceReference,setSourceReference]=useState("");
 const [selectedPOLineId,setSelectedPOLineId]=useState("");
 const [lineDescription,setLineDescription]=useState("");
 const [lineQuantity,setLineQuantity]=useState("1");
 const [lineCost,setLineCost]=useState("0");
 const [lineTax,setLineTax]=useState("0");
 const [paymentAmount,setPaymentAmount]=useState("");
 const [paymentMethod,setPaymentMethod]=useState("bank_transfer");
 const [paymentReference,setPaymentReference]=useState("");
 const [paymentDate,setPaymentDate]=useState(today());
 const [paymentIdempotencyKey,setPaymentIdempotencyKey]=useState("");
 const [reversingId,setReversingId]=useState("");
 const [reversalReason,setReversalReason]=useState("");
 const [varianceReason,setVarianceReason]=useState("");
 const [voidReason,setVoidReason]=useState("");
 const [showVoidForm,setShowVoidForm]=useState(false);
 const [loading,setLoading]=useState(true);
 const [busy,setBusy]=useState(false);
 const [error,setError]=useState("");
 const [notice,setNotice]=useState("");

 const member=memberships.find(x=>x.tenant_id===tenantId);
 const canManage=["owner","manager","accountant"].includes(member?.role??"");
 const selected=bills.find(x=>x.id===selectedId)??null;
 const supplierMap=useMemo(()=>new Map(suppliers.map(x=>[x.id,x])),[suppliers]);
 const branchMap=useMemo(()=>new Map(branches.map(x=>[x.id,x])),[branches]);
 const selectedOrder=orders.find(x=>x.id===selected?.purchase_order_id)??null;
 const draftPOLines=poLines.filter(x=>x.received_quantity>0);
 const priceVarianceLines=lines.filter(line=>{const po=poLines.find(x=>x.id===line.purchase_order_line_id);return !!po&&(Math.abs(Number(line.unit_cost)-Number(po.unit_cost))>0.01||Math.abs(Number(line.tax_rate)-Number(po.tax_rate))>0.001);});
 const varianceApproved=!!selected?.price_variance_approved_by&&!!selected?.price_variance_approved_at&&String(selected?.price_variance_reason??"").trim().length>=5&&selected.price_variance_approved_by!==selected.created_by;
 const canApproveVariance=["owner","manager"].includes(member?.role??"");
 const totalOutstanding=bills.filter(x=>["posted","partially_paid"].includes(x.status)).reduce((sum,x)=>sum+Number(x.balance_amount),0);
 const overdueBills=bills.filter(x=>["posted","partially_paid"].includes(x.status)&&x.due_date&&x.due_date<today());

 useEffect(()=>{let active=true;void(async()=>{try{
  const supabase=createClient();const {data:{user}}=await supabase.auth.getUser();if(!user){router.replace("/login");return;}if(active)setUserId(user.id);
  const {data,error:queryError}=await supabase.from("tenant_memberships").select("tenant_id,branch_id,role,tenants(display_name,slug)").eq("user_id",user.id).eq("is_active",true);
  if(queryError)throw queryError;if(!active)return;const rows=(data??[]) as unknown as Membership[];setMemberships(rows);setTenantId(rows[0]?.tenant_id??"");if(rows[0]?.branch_id)setBranchId(rows[0].branch_id);
 }catch{if(active)setError("Could not load shop access. Check sign-in and Supabase configuration.");}finally{if(active)setLoading(false)}})();return()=>{active=false}},[router]);

 const load=useCallback(async()=>{
  if(!tenantId){setBranches([]);setSuppliers([]);setOrders([]);setBills([]);return;}
  const supabase=createClient();
  const [b,s,o,bi]=await Promise.all([
   supabase.from("branches").select("id,name,branch_code").eq("tenant_id",tenantId).eq("is_active",true).order("name"),
   supabase.from("suppliers").select("id,supplier_code,name,is_active").eq("tenant_id",tenantId).eq("is_active",true).order("name").limit(2000),
   supabase.from("purchase_orders").select("id,tenant_id,branch_id,supplier_id,po_number,status,total_amount").eq("tenant_id",tenantId).in("status",["ordered","partially_received","received"]).order("order_date",{ascending:false}).limit(2000),
   supabase.from("supplier_bills").select("id,tenant_id,branch_id,supplier_id,purchase_order_id,supplier_invoice_number,invoice_date,due_date,status,subtotal,tax_amount,total_amount,paid_amount,balance_amount,notes,source_reference,created_by,posted_at,price_variance_approved_by,price_variance_approved_at,price_variance_reason,created_at,updated_at").eq("tenant_id",tenantId).order("created_at",{ascending:false}).limit(2000)
  ]);
  if(b.error||s.error||o.error||bi.error){setError("Could not load accounts payable. Verify supplier-bill migration and branch permissions.");return;}
  setBranches((b.data??[]) as Branch[]);setSuppliers((s.data??[]) as Supplier[]);setOrders((o.data??[]) as Order[]);setBills((bi.data??[]) as Bill[]);
  if(!branchId){const current=memberships.find(m=>m.tenant_id===tenantId);const first=current?.branch_id??(b.data??[])[0]?.id??"";if(first)setBranchId(first);}
  setError("");
 },[tenantId,memberships,branchId]);
 useEffect(()=>{void load()},[load]);

 async function loadBillDetails(id:string){
  setSelectedId(id);setError("");setNotice("");setReversingId("");setReversalReason("");
  const supabase=createClient();
  const [billRecord,l,p]=await Promise.all([
   supabase.from("supplier_bills").select("purchase_order_id").eq("tenant_id",tenantId).eq("id",id).maybeSingle(),
   supabase.from("supplier_bill_lines").select("id,supplier_bill_id,purchase_order_line_id,description,quantity,unit_cost,tax_rate,line_subtotal,tax_amount,line_total,notes").eq("tenant_id",tenantId).eq("supplier_bill_id",id).order("created_at"),
   supabase.from("supplier_bill_payments").select("id,payment_number,amount,payment_method,payment_reference,payment_date,status,created_by,reversed_at,reversal_reason").eq("tenant_id",tenantId).eq("supplier_bill_id",id).order("payment_date",{ascending:false}).limit(200)
  ]);
  if(billRecord.error||l.error||p.error){setError("Could not load bill, line or payment history.");return;}
  setLines((l.data??[]) as BillLine[]);setPayments((p.data??[]) as Payment[]);
  if(billRecord.data?.purchase_order_id){
   const {data,error:lineError}=await supabase.from("purchase_order_lines").select("id,purchase_order_id,product_code,description,ordered_quantity,received_quantity,unit_cost,tax_rate").eq("tenant_id",tenantId).eq("purchase_order_id",billRecord.data.purchase_order_id).order("line_number");
   if(lineError){setError("Could not load linked order lines.");return;}setPoLines((data??[]) as POLine[]);
  }else{setPoLines([]);}
  setSelectedPOLineId("");setLineDescription("");setLineQuantity("1");setLineCost("0");setLineTax("0");setVarianceReason("");
 }

 async function createBill(e:FormEvent<HTMLFormElement>){
  e.preventDefault();setError("");setNotice("");
  if(!tenantId||!branchId||!supplierId||!invoiceNumber.trim()){setError("Shop, branch, supplier and supplier invoice number are required.");return;}
  const order=orders.find(o=>o.id===purchaseOrderId);
  if(order&&(order.supplier_id!==supplierId||order.branch_id!==branchId)){setError("Linked purchase order must have the same supplier and branch as the bill.");return;}
  setBusy(true);
  try{
   const {data,error:insertError}=await createClient().from("supplier_bills").insert({
    tenant_id:tenantId,branch_id:branchId,supplier_id:supplierId,purchase_order_id:purchaseOrderId||null,
    supplier_invoice_number:invoiceNumber.trim(),invoice_date:invoiceDate,due_date:dueDate||null,status:"draft",
    notes:billNotes.trim()||null,source_reference:sourceReference.trim()||null
   }).select("id").single();
   if(insertError||!data)throw insertError??new Error("No bill id");
   setInvoiceNumber("");setBillNotes("");setSourceReference("");setDueDate("");setPurchaseOrderId("");
   await load();await loadBillDetails(data.id);setNotice("Draft supplier invoice created. Add and reconcile invoice lines, then post it to accounts payable.");
  }catch{setError("Bill could not be created. Check for duplicate supplier invoice number and ensure the supplier and branch belong to this shop.");}
  finally{setBusy(false);}
 }

 async function addLine(e:FormEvent<HTMLFormElement>){
  e.preventDefault();setError("");setNotice("");
  if(!selected||selected.status!=="draft"){setError("Only draft bills can be edited.");return;}
  const poLine=poLines.find(x=>x.id===selectedPOLineId);
  const qty=Number(lineQuantity),cost=Number(lineCost),tax=Number(lineTax);
  const description=selected.purchase_order_id?(poLine?.description??"") : lineDescription.trim();
  if(selected.purchase_order_id&&!poLine){setError("Choose a received purchase-order line to match.");return;}
  if(!selected.purchase_order_id&&description.length<2){setError("Enter a line description.");return;}
  if(!Number.isFinite(qty)||qty<=0||!Number.isFinite(cost)||cost<0||!Number.isFinite(tax)||tax<0||tax>100){setError("Enter positive quantity, non-negative cost and tax between 0 and 100.");return;}
  if(selected.purchase_order_id&&poLine&&qty>poLine.received_quantity){setError("Invoice line quantity cannot exceed the total received quantity for this order line; the database also checks quantities previously billed.");return;}
  setBusy(true);
  try{
   const {error:lineError}=await createClient().from("supplier_bill_lines").insert({
    tenant_id:tenantId,supplier_bill_id:selected.id,purchase_order_line_id:selected.purchase_order_id?poLine?.id:null,
    description,quantity:qty,unit_cost:cost,tax_rate:tax
   });
   if(lineError)throw lineError;
   await loadBillDetails(selected.id);setNotice("Invoice line added. PO-linked invoices are matched against received quantities when posted.");
  }catch{setError("Invoice line was not saved. Verify the linked order line and that the bill is still a draft.");}
  finally{setBusy(false);}
 }

 async function postBill(){
  if(!selected)return;
  if(priceVarianceLines.length>0&&!varianceApproved){setError("A separate owner/manager must approve the purchase price or tax variance before this bill can be posted.");return;}
  setBusy(true);setError("");setNotice("");
  try{const {error:rpcError}=await createClient().rpc("post_supplier_bill",{p_tenant_id:tenantId,p_bill_id:selected.id});if(rpcError)throw rpcError;
   await load();await loadBillDetails(selected.id);setNotice("Supplier invoice posted. Subtotal, tax and total were calculated from its lines and the open payable balance is now tracked.");
  }catch(e){const m=e&&typeof e==="object"&&"message" in e?String((e as {message?:unknown}).message??""):"";setError(m&&m.length<240?m:"Invoice posting failed. Check invoice number, PO/branch/supplier matching and whether billed quantities exceed received quantities.");}
  finally{setBusy(false);}
 }

 async function approveVariance(){
  if(!selected||!canApproveVariance){setError("Only an owner or manager may approve a purchase price variance.");return;}
  if(selected.created_by===userId){setError("The bill creator cannot approve their own purchase price variance.");return;}
  if(varianceReason.trim().length<5||varianceReason.trim().length>500){setError("Enter an approval reason between 5 and 500 characters.");return;}
  setBusy(true);setError("");setNotice("");
  try{
   const {error:rpcError}=await createClient().rpc("approve_supplier_bill_price_variance",{p_tenant_id:tenantId,p_bill_id:selected.id,p_reason:varianceReason.trim()});
   if(rpcError)throw rpcError;
   const id=selected.id;setVarianceReason("");await load();await loadBillDetails(id);
   setNotice("Purchase price/tax variance approved by a separate owner or manager. Editing any bill line clears this approval.");
  }catch(e){const m=e&&typeof e==="object"&&"message" in e?String((e as {message?:unknown}).message??""):"";setError(m&&m.length<240?m:"Variance approval failed. A different owner/manager with access to this branch must provide a reason.");}
  finally{setBusy(false);}
 }

 async function voidBill(){
  if(!selected)return;
  if(voidReason.trim().length<5||voidReason.trim().length>500){setError("Enter a void reason between 5 and 500 characters.");return;}
  setBusy(true);setError("");setNotice("");
  try{
   const id=selected.id;
   const {error:rpcError}=await createClient().rpc("void_supplier_bill",{p_tenant_id:tenantId,p_bill_id:id,p_reason:voidReason.trim()});
   if(rpcError)throw rpcError;
   await load();setSelectedId("");setLines([]);setPayments([]);setPoLines([]);setVoidReason("");setShowVoidForm(false);
   setNotice("Supplier bill voided with an audit reason. Existing payment history is never erased; paid or partially paid bills must use payment reversals first.");
  }catch(e){const m=e&&typeof e==="object"&&"message" in e?String((e as {message?:unknown}).message??""):"";setError(m&&m.length<240?m:"Bill could not be voided. Only a draft or unpaid posted bill can be voided with the required role and reason.");}
  finally{setBusy(false);}
 }

 async function recordPayment(e:FormEvent<HTMLFormElement>){
  e.preventDefault();setError("");setNotice("");if(!selected)return;
  const amount=Number(paymentAmount);
  if(!Number.isFinite(amount)||amount<=0||amount>Number(selected.balance_amount)){setError("Payment must be positive and not exceed this bill's current outstanding balance.");return;}
  setBusy(true);
  try{
   const idempotencyKey=paymentIdempotencyKey||("supplier-payment-"+crypto.randomUUID());
   setPaymentIdempotencyKey(idempotencyKey);
   const {error:rpcError}=await createClient().rpc("record_supplier_bill_payment",{
    p_tenant_id:tenantId,p_bill_id:selected.id,p_amount:amount,p_payment_method:paymentMethod,
    p_payment_reference:paymentReference.trim()||null,p_payment_date:paymentDate,
    p_idempotency_key:idempotencyKey
   });
   if(rpcError)throw rpcError;
   setPaymentAmount("");setPaymentReference("");setPaymentIdempotencyKey("");await load();await loadBillDetails(selected.id);
   setNotice("Supplier payment recorded against the bill. Bill balance and audit history were updated atomically.");
  }catch{setError("Payment failed. Recheck the balance, method, branch permission and bill status. No direct cash/bank account integration is implied by this ledger entry.");}
  finally{setBusy(false);}
 }

 async function reversePayment(payment:Payment){
  if(reversalReason.trim().length<5){setError("Enter a reversal reason of at least 5 characters.");return;}
  setBusy(true);setError("");setNotice("");
  try{
   const {error:rpcError}=await createClient().rpc("reverse_supplier_bill_payment",{p_tenant_id:tenantId,p_payment_id:payment.id,p_reason:reversalReason.trim()});
   if(rpcError)throw rpcError;setReversalReason("");setReversingId("");await load();if(selected)await loadBillDetails(selected.id);
   setNotice("Payment entry reversed with a reason. The bill's balance was recalculated; this is a ledger reversal, not a bank refund.");
  }catch{setError("Payment reversal failed. Only a confirmed payment with accounts-payable permission can be reversed.");}
  finally{setBusy(false);}
 }

 function exportBills(){
  const rows=[["Supplier","Supplier invoice","Purchase order","Branch","Invoice date","Due date","Status","Subtotal","Tax","Total","Paid","Balance"],
   ...bills.map(b=>[supplierMap.get(b.supplier_id)?.name??"",b.supplier_invoice_number??"",orders.find(o=>o.id===b.purchase_order_id)?.po_number??"",branchMap.get(b.branch_id)?.name??"",b.invoice_date,b.due_date??"",b.status,String(b.subtotal),String(b.tax_amount),String(b.total_amount),String(b.paid_amount),String(b.balance_amount)])];
  const csv=rows.map(row=>row.map(v=>'"'+String(v??"").replaceAll('"','""')+'"').join(",")).join("\r\n");
  const blob=new Blob(["\ufeff"+csv],{type:"text/csv;charset=utf-8;"});const url=URL.createObjectURL(blob);const a=document.createElement("a");a.href=url;a.download="supplier-payables-"+today()+".csv";a.click();URL.revokeObjectURL(url);
 }

 return <main><div className="page-wrap">
  <Link className="link-text small" href="/dashboard"><ArrowLeft size={13} style={{display:"inline",verticalAlign:"middle"}}/> Back to workspace</Link>
  <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",gap:16,flexWrap:"wrap",marginTop:20,marginBottom:24}}><div><div className="eyebrow"><ReceiptText size={14}/> Accounts payable</div><h1 style={{marginTop:12}}>Supplier invoices & payments</h1><p className="lead">Match supplier invoices to received purchase-order quantities, post payable balances and keep a traceable record of supplier payments and reversals.</p></div><div className="action-row" style={{marginTop:0}}><button className="btn btn-secondary" type="button" onClick={()=>void load()} disabled={busy}><RefreshCw size={14}/> Refresh</button><button className="btn btn-primary" type="button" onClick={exportBills} disabled={bills.length===0}><Download size={14}/> Export payables CSV</button></div></div>
  {error&&<div role="alert" className="notice" style={{marginBottom:14}}><CircleAlert size={16}/>{error}</div>}{notice&&<div role="status" className="notice" style={{marginBottom:14,background:"#edf7ef",borderColor:"#cfe4d4",color:"#1f5c3e"}}><CheckCircle2 size={16}/>{notice}</div>}
  {loading?<section className="panel">Loading accounts payable…</section>:memberships.length===0?<section className="panel"><h2>No shop linked</h2><Link className="btn btn-primary" href="/onboarding">Set up your shop</Link></section>:<>
   <div className="form-grid" style={{marginBottom:18}}>{memberships.length>1&&<div className="field"><label htmlFor="bill-shop">Shop</label><select id="bill-shop" value={tenantId} onChange={e=>{setTenantId(e.target.value);setSelectedId("");setLines([]);setPayments([])}}>{memberships.map(m=><option key={m.tenant_id} value={m.tenant_id}>{m.tenants?.display_name??m.tenant_id}</option>)}</select></div>}<div className="field"><label htmlFor="bill-branch">Branch</label><select id="bill-branch" value={branchId} onChange={e=>{setBranchId(e.target.value);setPurchaseOrderId("")}}><option value="">Choose branch</option>{branches.map(b=><option key={b.id} value={b.id}>{b.name} · {b.branch_code}</option>)}</select></div></div>
   <div className="dashboard-grid" style={{marginBottom:18}}><div className="metric-card"><div className="small muted">Open supplier payables</div><div className="metric-value">{money(totalOutstanding)}</div><p className="small muted">Posted balances not yet paid in full</p></div><div className="metric-card"><div className="small muted">Overdue invoices</div><div className="metric-value">{overdueBills.length}</div><p className="small muted">Past due date with a remaining payable balance</p></div><div className="metric-card"><div className="small muted">Supplier invoices</div><div className="metric-value">{bills.length}</div><p className="small muted">Across branches visible to your role</p></div></div>
   <div className="calc-layout">
    <section className="panel"><div className="section-head" style={{marginTop:0}}><div><div className="eyebrow">Invoice capture</div><h2 style={{marginTop:8}}>Create supplier bill</h2></div><FileText size={22}/></div>
     {!canManage?<div className="notice">Your role cannot manage supplier invoices.</div>:suppliers.length===0?<div className="notice">Add an active supplier before entering an invoice.</div>:<form onSubmit={createBill}><div className="form-grid">
      <div className="field"><label htmlFor="bill-supplier">Supplier *</label><select id="bill-supplier" required value={supplierId} onChange={e=>{setSupplierId(e.target.value);setPurchaseOrderId("")}}><option value="">Choose supplier</option>{suppliers.map(s=><option key={s.id} value={s.id}>{s.name} · {s.supplier_code}</option>)}</select></div>
      <div className="field"><label htmlFor="bill-order">Match purchase order (optional)</label><select id="bill-order" value={purchaseOrderId} onChange={e=>setPurchaseOrderId(e.target.value)}><option value="">Non-PO / expense invoice</option>{orders.filter(o=>o.supplier_id===supplierId&&o.branch_id===branchId).map(o=><option key={o.id} value={o.id}>{o.po_number} · {o.status} · {money(Number(o.total_amount))}</option>)}</select></div>
      <div className="field"><label htmlFor="bill-number">Supplier invoice number *</label><input id="bill-number" required maxLength={120} minLength={2} value={invoiceNumber} onChange={e=>setInvoiceNumber(e.target.value)} placeholder="Supplier's original invoice number"/></div>
      <div className="field"><label htmlFor="bill-date">Invoice date *</label><input id="bill-date" type="date" required value={invoiceDate} onChange={e=>setInvoiceDate(e.target.value)}/></div>
      <div className="field"><label htmlFor="bill-due">Payment due date</label><input id="bill-due" type="date" min={invoiceDate} value={dueDate} onChange={e=>setDueDate(e.target.value)}/></div>
      <div className="field"><label htmlFor="bill-source">Source/reference</label><input id="bill-source" maxLength={160} value={sourceReference} onChange={e=>setSourceReference(e.target.value)} placeholder="Invoice photo/file or internal reference"/></div>
      <div className="field"><label htmlFor="bill-notes">Notes</label><input id="bill-notes" maxLength={500} value={billNotes} onChange={e=>setBillNotes(e.target.value)} placeholder="Payment terms, freight, remarks"/></div>
     </div><button className="btn btn-primary" style={{marginTop:14}} type="submit" disabled={busy||!branchId||!supplierId||!invoiceNumber.trim()}>Create draft bill</button></form>}
     <div className="notice" style={{marginTop:14}}><ShieldCheckIcon/><span>Posting a PO-matched bill checks supplier/branch identity and total billed quantities against goods actually received. Supplier payments are ledger entries; they do not initiate a bank transfer.</span></div>
    </section>
    <section className="panel"><div className="section-head" style={{marginTop:0}}><div><div className="eyebrow">Payables register</div><h2 style={{marginTop:8}}>Supplier invoices</h2></div></div>
     {bills.length===0?<p className="small muted">No supplier bills recorded yet.</p>:<div style={{display:"grid",gap:8}}>{bills.map(b=><button key={b.id} className="list-card" type="button" onClick={()=>void loadBillDetails(b.id)} style={{display:"flex",alignItems:"flex-start",gap:12,textAlign:"left",width:"100%",cursor:"pointer",color:"inherit",background:selectedId===b.id?"#f1f6f1":undefined,borderColor:selectedId===b.id?"#b7d4be":undefined}}><div style={{flex:1,minWidth:0}}><strong>{b.supplier_invoice_number||"Unnumbered draft"}</strong><div className="small muted">{supplierMap.get(b.supplier_id)?.name??"Supplier"} · {branchMap.get(b.branch_id)?.name??"Branch"}</div><div className="small muted">{b.invoice_date} · Total {money(Number(b.total_amount))} · Balance {money(Number(b.balance_amount))}</div></div><span className={"pill "+(b.status==="paid"?"pill-green":b.status==="draft"?"pill-demo":"pill-blue")}>{b.status.replaceAll("_"," ")}</span></button>)}</div>}
    </section>
   </div>
   {selected&&<section className="panel" style={{marginTop:18}}>
    <div className="section-head" style={{marginTop:0,alignItems:"flex-start"}}><div><div className="eyebrow">Invoice details</div><h2 style={{marginTop:8}}>{selected.supplier_invoice_number??"Draft bill"}</h2><p className="small muted" style={{marginBottom:0}}>{supplierMap.get(selected.supplier_id)?.name??"Supplier"} · {branchMap.get(selected.branch_id)?.name??"Branch"} · {selected.purchase_order_id?selectedOrder?.po_number??"Linked purchase order":"Non-PO bill"}</p><p className="small muted" style={{marginTop:4}}>Invoice {selected.invoice_date} · Due {selected.due_date??"Not set"}</p></div><div style={{textAlign:"right"}}><strong>{money(Number(selected.total_amount))}</strong><div className="small muted">Total incl. line tax</div><div className="small muted">Paid {money(Number(selected.paid_amount))} · Due {money(Number(selected.balance_amount))}</div><span className="pill pill-blue" style={{display:"inline-flex",marginTop:6}}>{selected.status}</span></div></div>
    {selected.notes&&<p className="small muted">{selected.notes}</p>}
    {selected.status==="draft"&&selected.purchase_order_id&&priceVarianceLines.length>0&&<section className="notice" style={{display:"block",marginBottom:14}}>
     <strong>Purchase price/tax variance review</strong>
     <p className="small" style={{marginTop:6,marginBottom:8}}>{priceVarianceLines.length} invoice line(s) differ from their received purchase-order price or tax rate. A separate owner/manager must approve this variance before posting. Editing any bill line clears this approval.</p>
     {varianceApproved?<div className="small">Approved by a separate owner/manager. Reason: {selected.price_variance_reason}</div>:canApproveVariance&&selected.created_by!==userId?<div className="form-grid"><div className="field"><label htmlFor="bill-variance-reason">Approval reason *</label><input id="bill-variance-reason" minLength={5} maxLength={500} required value={varianceReason} onChange={e=>setVarianceReason(e.target.value)} placeholder="Supplier price update, documented exception…"/></div><div className="field" style={{alignSelf:"end"}}><button className="btn btn-primary" type="button" disabled={busy||varianceReason.trim().length<5} onClick={()=>void approveVariance()}><CheckCircle2 size={14}/> Approve price/tax variance</button></div></div>:<p className="small" style={{marginBottom:0}}>Only an owner/manager other than the bill creator can approve this variance.</p>}
    </section>}
    {selected.status==="draft"&&canManage&&<form onSubmit={addLine} style={{marginBottom:18}}><h3>Add invoice line</h3>
     {selected.purchase_order_id?<div className="notice" style={{marginBottom:12}}>Choose a received PO line; each linked invoice line must match a line on {selectedOrder?.po_number??"the selected order"}. The post action checks cumulative billed quantity.</div>:null}
     <div className="form-grid">
      {selected.purchase_order_id?<div className="field"><label htmlFor="bill-po-line">Received purchase-order line *</label><select id="bill-po-line" required value={selectedPOLineId} onChange={e=>{setSelectedPOLineId(e.target.value);const p=poLines.find(x=>x.id===e.target.value);setLineDescription(p?.description??"");setLineCost(String(Number(p?.unit_cost??0)));setLineTax(String(Number(p?.tax_rate??0)));setLineQuantity("1")}}><option value="">Choose received line</option>{draftPOLines.map(p=><option key={p.id} value={p.id}>{p.product_code} · {p.description} · received {p.received_quantity}/{p.ordered_quantity}</option>)}</select></div>:<div className="field"><label htmlFor="bill-line-desc">Description *</label><input id="bill-line-desc" required minLength={2} maxLength={250} value={lineDescription} onChange={e=>setLineDescription(e.target.value)} placeholder="Freight, service, material, other charge"/></div>}
      <div className="field"><label htmlFor="bill-line-qty">Quantity *</label><input id="bill-line-qty" required type="number" min="0.001" step={selected.purchase_order_id?"1":"0.001"} value={lineQuantity} onChange={e=>setLineQuantity(e.target.value)}/></div>
      <div className="field"><label htmlFor="bill-line-cost">Unit cost (₹) *</label><input id="bill-line-cost" required type="number" min="0" step="0.01" value={lineCost} onChange={e=>setLineCost(e.target.value)}/></div>
      <div className="field"><label htmlFor="bill-line-tax">Tax (%)</label><input id="bill-line-tax" type="number" min="0" max="100" step="0.001" value={lineTax} onChange={e=>setLineTax(e.target.value)}/></div>
     </div><button className="btn btn-secondary" type="submit" disabled={busy||!!selected.purchase_order_id&&!selectedPOLineId} style={{marginTop:12}}><Plus size={14}/> Add line</button>
    </form>}
    <div style={{overflowX:"auto"}}><table style={{width:"100%",borderCollapse:"collapse",minWidth:700}}><thead><tr>{["Description","Quantity","Unit cost","Tax","Line total","Match"].map(h=><th key={h} style={{textAlign:"left",padding:9,borderBottom:"1px solid #e2e8e2",fontSize:12}}>{h}</th>)}</tr></thead><tbody>
    {lines.map(l=><tr key={l.id}><td style={{padding:9,borderBottom:"1px solid #edf0ed"}}><strong>{l.description}</strong>{l.notes&&<div className="small muted">{l.notes}</div>}</td><td style={{padding:9,borderBottom:"1px solid #edf0ed"}}>{Number(l.quantity)}</td><td style={{padding:9,borderBottom:"1px solid #edf0ed"}}>{money(Number(l.unit_cost))}</td><td style={{padding:9,borderBottom:"1px solid #edf0ed"}}>{Number(l.tax_rate)}%</td><td style={{padding:9,borderBottom:"1px solid #edf0ed"}}>{money(Number(l.line_total))}</td><td style={{padding:9,borderBottom:"1px solid #edf0ed"}}>{l.purchase_order_line_id?<span className="pill pill-green">PO matched</span>:<span className="pill pill-demo">Manual</span>}</td></tr>)}
    {lines.length===0&&<tr><td colSpan={6} style={{padding:14}} className="small muted">No invoice lines yet.</td></tr>}
    </tbody></table></div>
    {selected.status==="draft"&&canManage&&<div className="action-row" style={{marginTop:14}}><button className="btn btn-primary" type="button" disabled={busy||lines.length===0||(priceVarianceLines.length>0&&!varianceApproved)} onClick={()=>void postBill()}><CheckCircle2 size={14}/> {priceVarianceLines.length>0&&!varianceApproved?"Approve variance before posting":"Match & post bill"}</button></div>}
    {["posted","partially_paid"].includes(selected.status)&&canManage&&<section style={{borderTop:"1px solid #e7ece7",marginTop:20,paddingTop:18}}><h3>Record supplier payment</h3><p className="small muted">Outstanding balance: {money(Number(selected.balance_amount))}. The payment is logged against this bill; it is not a bank integration.</p><form onSubmit={recordPayment}><div className="form-grid">
     <div className="field"><label htmlFor="supplier-payment-amount">Payment amount (₹) *</label><input id="supplier-payment-amount" required type="number" min="0.01" max={Number(selected.balance_amount)} step="0.01" value={paymentAmount} onChange={e=>{setPaymentAmount(e.target.value);setPaymentIdempotencyKey("");}}/></div>
     <div className="field"><label htmlFor="supplier-payment-method">Method *</label><select id="supplier-payment-method" value={paymentMethod} onChange={e=>{setPaymentMethod(e.target.value);setPaymentIdempotencyKey("");}}>{["bank_transfer","upi","neft","rtgs","cheque","cash","other"].map(m=><option key={m} value={m}>{m.replaceAll("_"," ")}</option>)}</select></div>
     <div className="field"><label htmlFor="supplier-payment-date">Payment date *</label><input id="supplier-payment-date" type="date" required value={paymentDate} onChange={e=>{setPaymentDate(e.target.value);setPaymentIdempotencyKey("");}}/></div>
     <div className="field"><label htmlFor="supplier-payment-ref">Reference</label><input id="supplier-payment-ref" maxLength={160} value={paymentReference} onChange={e=>{setPaymentReference(e.target.value);setPaymentIdempotencyKey("");}} placeholder="UTR, cheque no, receipt reference"/></div>
    </div><button className="btn btn-primary" type="submit" disabled={busy||Number(paymentAmount)<=0||Number(paymentAmount)>Number(selected.balance_amount)} style={{marginTop:12}}><Banknote size={14}/> Record payment</button></form></section>}
    <div style={{marginTop:20}}><h3>Payment history</h3>{payments.length===0?<p className="small muted">No supplier payments recorded against this bill.</p>:<div style={{display:"grid",gap:8}}>{payments.map(p=><div className="list-card" key={p.id} style={{display:"grid",gap:10}}><div style={{display:"flex",justifyContent:"space-between",gap:12,flexWrap:"wrap"}}><div><strong>{p.payment_number}</strong><div className="small muted">{p.payment_date} · {p.payment_method.replaceAll("_"," ")}{p.payment_reference?" · Ref "+p.payment_reference:""}</div>{p.reversal_reason&&<div className="small muted">Reversal: {p.reversal_reason}</div>}</div><div><strong>{money(Number(p.amount))}</strong><div className="small muted">{p.status}</div></div></div>
     {p.status==="confirmed"&&canManage&&<div>{reversingId!==p.id?<button type="button" className="btn btn-secondary" disabled={busy} onClick={()=>setReversingId(p.id)}><Undo2 size={14}/> Reverse payment entry</button>:<div className="form-grid"><div className="field"><label htmlFor={"reverse-"+p.id}>Reason *</label><input id={"reverse-"+p.id} minLength={5} maxLength={500} value={reversalReason} onChange={e=>setReversalReason(e.target.value)} placeholder="Bank return, duplicate entry, correction…"/></div><div className="field" style={{alignSelf:"end"}}><button type="button" className="btn btn-secondary" disabled={busy||reversalReason.trim().length<5} onClick={()=>void reversePayment(p)}>Confirm reversal</button></div></div>}</div>}
    </div>)}</div>}</div>
   </section>}
   {selected&&(selected.status==="draft"||(selected.status==="posted"&&Number(selected.paid_amount)===0))&&canManage&&<section className="panel" style={{marginTop:18}}>
    <h3>Void supplier bill</h3><p className="small muted">Voiding is allowed only for drafts or unpaid posted bills. Paid or partially paid invoices cannot be erased; reverse confirmed supplier payment entries first. A reason is recorded in the audit log.</p>
    {!showVoidForm?<button className="btn btn-secondary" type="button" onClick={()=>setShowVoidForm(true)} disabled={busy}>Void supplier bill</button>:<div className="form-grid"><div className="field"><label htmlFor="supplier-bill-void-reason">Void reason *</label><input id="supplier-bill-void-reason" minLength={5} maxLength={500} required value={voidReason} onChange={e=>setVoidReason(e.target.value)} placeholder="Duplicate invoice, cancelled purchase…"/></div><div className="field" style={{alignSelf:"end",display:"flex",gap:8,flexWrap:"wrap"}}><button className="btn btn-primary" type="button" disabled={busy||voidReason.trim().length<5} onClick={()=>void voidBill()}>Confirm void</button><button className="btn btn-secondary" type="button" disabled={busy} onClick={()=>{setShowVoidForm(false);setVoidReason("");}}>Cancel</button></div></div>}
   </section>}
   <div className="action-row" style={{marginTop:16}}><Link className="btn btn-secondary" href="/purchasing">Purchase orders & receipts</Link><Link className="btn btn-secondary" href="/suppliers">Supplier register</Link></div>
  </>}
 </div></main>;
}

function ShieldCheckIcon(){return <span aria-hidden="true" style={{fontSize:15}}>✓</span>}
