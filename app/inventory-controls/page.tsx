"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { ArrowLeft, AlertTriangle, Boxes, CheckCircle2, CircleAlert, Download, History, Plus, RefreshCw, Scale, ShieldCheck } from "lucide-react";
import { createClient } from "@/lib/supabase/client";

type Membership={tenant_id:string;branch_id:string|null;role:string;tenants:{display_name:string;slug:string}|null};
type Branch={id:string;name:string;branch_code:string};
type Product={id:string;product_code:string;name:string;is_active?:boolean};
type Item={id:string;tenant_id:string;branch_id:string;product_id:string;item_code:string;status:string;current_valuation:number|null;barcode:string|null;huid:string|null;gross_weight_grams:number|null;net_metal_weight_grams:number|null;stone_weight_grams:number|null};
type Rule={id:string;tenant_id:string;branch_id:string;product_id:string;minimum_stock:number;reorder_quantity:number;is_active:boolean;updated_at:string};
type ReorderStatus={tenant_id:string;branch_id:string;branch_name:string;product_id:string;product_code:string;product_name:string;minimum_stock:number;reorder_quantity:number;on_hand:number;shortage:number;is_low_stock:boolean};
type Valuation={id:string;tenant_id:string;branch_id:string|null;inventory_item_id:string;product_id:string|null;event_type:string;previous_value:number|null;new_value:number;delta_value:number;reason:string;source_reference:string|null;actor_user_id:string|null;created_at:string};

export default function InventoryControlsPage(){
 const router=useRouter();
 const [memberships,setMemberships]=useState<Membership[]>([]);
 const [tenantId,setTenantId]=useState("");
 const [branches,setBranches]=useState<Branch[]>([]);
 const [branchId,setBranchId]=useState("");
 const [products,setProducts]=useState<Product[]>([]);
 const [items,setItems]=useState<Item[]>([]);
 const [rules,setRules]=useState<Rule[]>([]);
 const [reorderStatus,setReorderStatus]=useState<ReorderStatus[]>([]);
 const [history,setHistory]=useState<Valuation[]>([]);
 const [productId,setProductId]=useState("");
 const [minimumStock,setMinimumStock]=useState("1");
 const [reorderQuantity,setReorderQuantity]=useState("1");
 const [valuationItemId,setValuationItemId]=useState("");
 const [newValuation,setNewValuation]=useState("");
 const [valuationReason,setValuationReason]=useState("");
 const [valuationReference,setValuationReference]=useState("");
 const [historySearch,setHistorySearch]=useState("");
 const [loading,setLoading]=useState(true);
 const [busy,setBusy]=useState(false);
 const [error,setError]=useState("");
 const [notice,setNotice]=useState("");
 const [lastRefreshed,setLastRefreshed]=useState<Date|null>(null);

 const member=memberships.find(m=>m.tenant_id===tenantId);
 const canManage=["owner","manager","inventory_manager"].includes(member?.role??"");
 const canRevalue=canManage;
 const productMap=useMemo(()=>new Map(products.map(p=>[p.id,p])),[products]);
 const itemMap=useMemo(()=>new Map(items.map(i=>[i.id,i])),[items]);
 const lowStockRules=reorderStatus.filter(x=>x.is_low_stock);
 const filteredHistory=history.filter(h=>{
  const item=itemMap.get(h.inventory_item_id);
  const product=productMap.get(h.product_id??item?.product_id??"");
  const query=historySearch.trim().toLowerCase();
  return !query||[item?.item_code,product?.product_code,product?.name,h.reason,h.source_reference,h.event_type].some(v=>String(v??"").toLowerCase().includes(query));
 });
 const valuationChoices=items.filter(i=>!branchId||i.branch_id===branchId);
 const selectedValuationItem=valuationChoices.find(i=>i.id===valuationItemId)??null;

 useEffect(()=>{let active=true;void(async()=>{try{
  const supabase=createClient();const {data:{user}}=await supabase.auth.getUser();if(!user){router.replace("/login");return;}
  const {data,error:queryError}=await supabase.from("tenant_memberships").select("tenant_id,branch_id,role,tenants(display_name,slug)").eq("user_id",user.id).eq("is_active",true);
  if(queryError)throw queryError;if(!active)return;const rows=(data??[]) as unknown as Membership[];setMemberships(rows);setTenantId(rows[0]?.tenant_id??"");if(rows[0]?.branch_id)setBranchId(rows[0].branch_id);
 }catch{if(active)setError("Could not load shop access. Check authentication and Supabase configuration.");}finally{if(active)setLoading(false)}})();return()=>{active=false}},[router]);

 const load=useCallback(async()=>{
  if(!tenantId){setBranches([]);setProducts([]);setItems([]);setRules([]);setReorderStatus([]);setHistory([]);return;}
  const supabase=createClient();
  let rulesQuery=supabase.from("inventory_reorder_rules").select("id,tenant_id,branch_id,product_id,minimum_stock,reorder_quantity,is_active,updated_at").eq("tenant_id",tenantId).order("updated_at",{ascending:false}).limit(2000);
  let historyQuery=supabase.from("inventory_valuation_history").select("id,tenant_id,branch_id,inventory_item_id,product_id,event_type,previous_value,new_value,delta_value,reason,source_reference,actor_user_id,created_at").eq("tenant_id",tenantId).order("created_at",{ascending:false}).limit(500);
  let itemQuery=supabase.from("inventory_items").select("id,tenant_id,branch_id,product_id,item_code,status,current_valuation,barcode,huid,gross_weight_grams,net_metal_weight_grams,stone_weight_grams").eq("tenant_id",tenantId).order("created_at",{ascending:false}).limit(5000);
  if(branchId){rulesQuery=rulesQuery.eq("branch_id",branchId);historyQuery=historyQuery.eq("branch_id",branchId);itemQuery=itemQuery.eq("branch_id",branchId);}
  const [b,p,it,r,rs,h]=await Promise.all([
   supabase.from("branches").select("id,name,branch_code").eq("tenant_id",tenantId).eq("is_active",true).order("name"),
   supabase.from("products").select("id,product_code,name,is_active").eq("tenant_id",tenantId).eq("is_active",true).order("name").limit(3000),
   itemQuery,rulesQuery,
   supabase.rpc("get_inventory_reorder_status",{p_tenant_id:tenantId,p_branch_id:branchId||null}),
   historyQuery
  ]);
  if(b.error||p.error||it.error||r.error||rs.error||h.error){setError("Some inventory-control data could not be loaded. Verify migrations and branch-level permissions.");return;}
  setBranches((b.data??[]) as Branch[]);setProducts((p.data??[]) as Product[]);setItems((it.data??[]) as Item[]);
  setRules((r.data??[]) as Rule[]);setReorderStatus((rs.data??[]) as ReorderStatus[]);setHistory((h.data??[]) as Valuation[]);setLastRefreshed(new Date());setError("");
  if(!branchId){const m=memberships.find(x=>x.tenant_id===tenantId);const initial=m?.branch_id??(b.data??[])[0]?.id??"";if(initial)setBranchId(initial);}
 },[tenantId,branchId,memberships]);
 useEffect(()=>{void load()},[load]);

 async function saveRule(e:FormEvent<HTMLFormElement>){
  e.preventDefault();setError("");setNotice("");
  const minimum=Number(minimumStock),quantity=Number(reorderQuantity);
  if(!branchId||!productId||!Number.isInteger(minimum)||minimum<0||!Number.isInteger(quantity)||quantity<1){setError("Choose a branch and product, a non-negative minimum stock and a whole-piece reorder quantity.");return;}
  setBusy(true);
  try{
   const {error:saveError}=await createClient().from("inventory_reorder_rules").upsert({
    tenant_id:tenantId,branch_id:branchId,product_id:productId,minimum_stock:minimum,reorder_quantity:quantity,is_active:true
   },{onConflict:"tenant_id,branch_id,product_id"});
   if(saveError)throw saveError;
   setProductId("");setMinimumStock("1");setReorderQuantity("1");await load();
   setNotice("Branch-specific low-stock rule saved. Current on-hand quantity is calculated from inventory records, not typed into the alert.");
  }catch{setError("Could not save the rule. Confirm the product is active and you have inventory-manager permission for this branch.");}
  finally{setBusy(false);}
 }

 async function deactivateRule(rule:Rule){
  setError("");setNotice("");setBusy(true);
  try{const {error:changeError}=await createClient().from("inventory_reorder_rules").update({is_active:false}).eq("tenant_id",tenantId).eq("id",rule.id);if(changeError)throw changeError;await load();setNotice("Reorder rule deactivated.");}
  catch{setError("Could not deactivate this rule. Refresh and check role permissions.");}
  finally{setBusy(false);}
 }

 async function revalue(e:FormEvent<HTMLFormElement>){
  e.preventDefault();setError("");setNotice("");
  const value=Number(newValuation);
  if(!selectedValuationItem||!Number.isFinite(value)||value<0||valuationReason.trim().length<5){setError("Choose a stock item, enter a non-negative valuation, and give a reason of at least 5 characters.");return;}
  setBusy(true);
  try{
   const {error:rpcError}=await createClient().rpc("revalue_inventory_item",{
    p_tenant_id:tenantId,p_branch_id:selectedValuationItem.branch_id,p_inventory_item_id:selectedValuationItem.id,
    p_new_value:value,p_reason:valuationReason.trim(),p_source_reference:valuationReference.trim()||null
   });
   if(rpcError)throw rpcError;
   setNewValuation("");setValuationReason("");setValuationReference("");await load();
   setNotice("Item valuation updated through the audited workflow. Previous and new values and the reason are now in valuation history.");
  }catch{setError("Revaluation failed. Check your role, selected branch, amount and reason. Direct unreasoned valuation updates are blocked.");}
  finally{setBusy(false);}
 }

 function exportHistory(){
  const rows=[["Date","Branch","Item code","Product code","Product","Event","Previous value","New value","Change","Reason","Source reference"],
   ...filteredHistory.map(h=>{const item=itemMap.get(h.inventory_item_id);const product=productMap.get(h.product_id??item?.product_id??"");return[
    h.created_at,branches.find(b=>b.id===h.branch_id)?.name??"",item?.item_code??h.inventory_item_id,product?.product_code??"",product?.name??"",
    h.event_type,h.previous_value==null?"":String(h.previous_value),String(h.new_value),String(h.delta_value),h.reason,h.source_reference??""
   ]})];
  const csv=rows.map(row=>row.map(v=>'"'+String(v??"").replaceAll('"','""')+'"').join(",")).join("\r\n");
  const blob=new Blob(["\ufeff"+csv],{type:"text/csv;charset=utf-8;"});const url=URL.createObjectURL(blob);const a=document.createElement("a");
  a.href=url;a.download="gold-valuation-history-"+new Date().toISOString().slice(0,10)+".csv";a.click();URL.revokeObjectURL(url);
 }
 const money=(v:number|null|undefined)=>new Intl.NumberFormat("en-IN",{style:"currency",currency:"INR",maximumFractionDigits:2}).format(Number(v??0));
 const itemLabel=(i:Item)=>{const p=productMap.get(i.product_id);return (p?.product_code??"ITEM")+" · "+(p?.name??"Product")+" · "+i.item_code;};

 return <main><div className="page-wrap">
  <Link href="/dashboard" className="link-text small"><ArrowLeft size={13} style={{display:"inline",verticalAlign:"middle"}}/> Back to workspace</Link>
  <div style={{marginTop:20,marginBottom:24}}><div className="eyebrow"><Boxes size={14}/> Inventory controls</div><h1 style={{marginTop:12}}>Stock alerts & valuation</h1><p className="lead">Configure branch-specific reorder thresholds and maintain an auditable history whenever a tracked item is revalued. Alerts use a server-side stock count, not a fixed demo total.</p></div>
  {error&&<div className="notice" role="alert" style={{marginBottom:14}}><CircleAlert size={16}/>{error}</div>}
  {notice&&<div className="notice" role="status" style={{marginBottom:14,background:"#edf7ef",borderColor:"#cfe4d4",color:"#1f5c3e"}}><CheckCircle2 size={16}/>{notice}</div>}
  {loading?<section className="panel">Loading shop access…</section>:memberships.length===0?<section className="panel"><h2>No shop linked</h2><Link className="btn btn-primary" href="/onboarding">Set up your shop</Link></section>:<>
   <div className="form-grid" style={{marginBottom:18}}>
    {memberships.length>1&&<div className="field"><label htmlFor="control-shop">Shop</label><select id="control-shop" value={tenantId} onChange={e=>{setTenantId(e.target.value);setBranchId("");setRules([]);setHistory([]);}}>{memberships.map(m=><option key={m.tenant_id} value={m.tenant_id}>{m.tenants?.display_name??m.tenant_id}</option>)}</select></div>}
    <div className="field"><label htmlFor="control-branch">Branch</label><select id="control-branch" value={branchId} onChange={e=>{setBranchId(e.target.value);setValuationItemId("");}}><option value="">All accessible branches</option>{branches.map(b=><option key={b.id} value={b.id}>{b.name} · {b.branch_code}</option>)}</select></div>
   </div>

   <section className="panel" style={{marginBottom:18}}>
    <div className="section-head" style={{marginTop:0}}><div><div className="eyebrow">Restock monitor</div><h2 style={{marginTop:8}}>Low-stock alerts</h2></div><AlertTriangle size={22}/></div>
    <div className="dashboard-grid"><div className="metric-card"><div className="small muted">Active reorder rules</div><div className="metric-value">{reorderStatus.length}</div></div><div className="metric-card"><div className="small muted">Products at / below minimum</div><div className="metric-value">{lowStockRules.length}</div></div></div>
    {canManage&&<form onSubmit={saveRule} style={{marginTop:18}}><h3>Configure reorder threshold</h3><div className="form-grid">
     <div className="field"><label htmlFor="rule-product">Product *</label><select id="rule-product" required value={productId} onChange={e=>setProductId(e.target.value)}><option value="">Choose product</option>{products.map(p=><option key={p.id} value={p.id}>{p.product_code} · {p.name}</option>)}</select></div>
     <div className="field"><label htmlFor="minimum-stock">Alert at or below (pieces) *</label><input id="minimum-stock" type="number" min="0" step="1" required value={minimumStock} onChange={e=>setMinimumStock(e.target.value)}/></div>
     <div className="field"><label htmlFor="reorder-qty">Suggested reorder quantity *</label><input id="reorder-qty" type="number" min="1" step="1" required value={reorderQuantity} onChange={e=>setReorderQuantity(e.target.value)}/></div>
    </div><button className="btn btn-primary" type="submit" disabled={busy||!branchId||!productId} style={{marginTop:12}}><Plus size={14}/> Save branch rule</button></form>}
    <div style={{overflowX:"auto",marginTop:18}}><table style={{width:"100%",borderCollapse:"collapse",minWidth:700}}><thead><tr>{["Branch","Product","On hand","Minimum","Suggested order","Status","Action"].map(h=><th key={h} style={{textAlign:"left",padding:9,borderBottom:"1px solid #e2e8e2",fontSize:12}}>{h}</th>)}</tr></thead><tbody>
     {reorderStatus.map(r=>{const rule=rules.find(x=>x.branch_id===r.branch_id&&x.product_id===r.product_id);return <tr key={r.branch_id+"-"+r.product_id}><td style={{padding:9,borderBottom:"1px solid #edf0ed"}}>{r.branch_name}</td><td style={{padding:9,borderBottom:"1px solid #edf0ed"}}><strong>{r.product_name}</strong><div className="small muted">{r.product_code}</div></td><td style={{padding:9,borderBottom:"1px solid #edf0ed"}}>{r.on_hand}</td><td style={{padding:9,borderBottom:"1px solid #edf0ed"}}>{r.minimum_stock}</td><td style={{padding:9,borderBottom:"1px solid #edf0ed"}}>{r.reorder_quantity}</td><td style={{padding:9,borderBottom:"1px solid #edf0ed"}}>{r.is_low_stock?<span className="pill" style={{background:"#fff4e5",color:"#824a00"}}>Low stock · short {r.shortage}</span>:<span className="pill pill-green">In range</span>}</td><td style={{padding:9,borderBottom:"1px solid #edf0ed"}}>{canManage&&rule&&<button type="button" className="btn btn-secondary" disabled={busy} onClick={()=>void deactivateRule(rule)}>Deactivate</button>}</td></tr>})}
     {reorderStatus.length===0&&<tr><td colSpan={7} className="small muted" style={{padding:14}}>No active reorder rules configured for the selected branch.</td></tr>}
    </tbody></table></div>
    <p className="small muted" style={{marginTop:12,marginBottom:0}}>An alert suggests a replenishment quantity; it does not automatically create a supplier order or purchase stock.</p>
   </section>

   {canRevalue&&<section className="panel" style={{marginBottom:18}}><div className="section-head" style={{marginTop:0}}><div><div className="eyebrow">Valuation controls</div><h2 style={{marginTop:8}}>Revalue a tracked piece</h2></div><Scale size={22}/></div>
    <form onSubmit={revalue}><div className="form-grid">
     <div className="field"><label htmlFor="valuation-item">Inventory item *</label><select id="valuation-item" required value={valuationItemId} onChange={e=>{setValuationItemId(e.target.value);const i=valuationChoices.find(x=>x.id===e.target.value);setNewValuation(i?.current_valuation==null?"":String(i.current_valuation));}}><option value="">Choose a piece</option>{valuationChoices.map(i=><option key={i.id} value={i.id}>{itemLabel(i)} · Current {money(i.current_valuation)}</option>)}</select></div>
     <div className="field"><label htmlFor="new-value">New valuation (₹) *</label><input id="new-value" required type="number" min="0" step="0.01" value={newValuation} onChange={e=>setNewValuation(e.target.value)}/></div>
     <div className="field"><label htmlFor="valuation-reason">Reason (required) *</label><input id="valuation-reason" required minLength={5} maxLength={500} value={valuationReason} onChange={e=>setValuationReason(e.target.value)} placeholder="Market revaluation, audited cost correction…"/></div>
     <div className="field"><label htmlFor="valuation-reference">Source / document reference</label><input id="valuation-reference" maxLength={160} value={valuationReference} onChange={e=>setValuationReference(e.target.value)} placeholder="Invoice, appraisal or audit note"/></div>
    </div><button className="btn btn-primary" style={{marginTop:12}} type="submit" disabled={busy||!valuationItemId}><ShieldCheck size={14}/> Save revaluation with audit history</button></form>
    <p className="small muted" style={{marginTop:10,marginBottom:0}}>Each approved change records the prior value, new value, reason, source reference and actor. Unreasoned direct valuation updates are rejected.</p>
   </section>}

   <section className="panel"><div className="section-head" style={{marginTop:0,alignItems:"flex-start"}}><div><div className="eyebrow"><History size={13}/> Audit trail</div><h2 style={{marginTop:8}}>Valuation history</h2><p className="small muted" style={{marginBottom:0}}>Events recorded since valuation history was enabled; values are not market-price quotes.</p></div><div className="action-row" style={{marginTop:0}}><button type="button" className="btn btn-secondary" onClick={()=>void load()} disabled={busy}><RefreshCw size={14}/> Refresh</button><button type="button" className="btn btn-primary" onClick={exportHistory} disabled={filteredHistory.length===0}><Download size={14}/> Export CSV</button></div></div>
    <div className="field" style={{maxWidth:460,marginBottom:14}}><label htmlFor="history-search">Search item, product, reference or reason</label><input id="history-search" value={historySearch} onChange={e=>setHistorySearch(e.target.value)} placeholder="Item code, HUID reference or reason"/></div>
    {filteredHistory.length===0?<p className="small muted">No valuation events matched the search. New stock receipts create initial entries; revaluation entries record approved changes.</p>:<div style={{overflowX:"auto"}}><table style={{width:"100%",borderCollapse:"collapse",minWidth:820}}><thead><tr>{["Date","Item","Event","Previous","New value","Change","Reason / reference"].map(h=><th key={h} style={{textAlign:"left",padding:9,borderBottom:"1px solid #e2e8e2",fontSize:12}}>{h}</th>)}</tr></thead><tbody>{filteredHistory.map(h=>{const item=itemMap.get(h.inventory_item_id);const product=productMap.get(h.product_id??item?.product_id??"");return <tr key={h.id}><td style={{padding:9,borderBottom:"1px solid #edf0ed",whiteSpace:"nowrap"}}>{new Date(h.created_at).toLocaleString("en-IN")}</td><td style={{padding:9,borderBottom:"1px solid #edf0ed"}}><strong>{item?.item_code??h.inventory_item_id.slice(0,8)}</strong><div className="small muted">{product?.name??"Product record unavailable"}</div></td><td style={{padding:9,borderBottom:"1px solid #edf0ed"}}>{h.event_type.replaceAll("_"," ")}</td><td style={{padding:9,borderBottom:"1px solid #edf0ed"}}>{h.previous_value==null?"—":money(h.previous_value)}</td><td style={{padding:9,borderBottom:"1px solid #edf0ed"}}>{money(h.new_value)}</td><td style={{padding:9,borderBottom:"1px solid #edf0ed",color:Number(h.delta_value)<0?"#9a3426":"inherit"}}>{Number(h.delta_value)>0?"+":""}{money(h.delta_value)}</td><td style={{padding:9,borderBottom:"1px solid #edf0ed"}}>{h.reason}{h.source_reference&&<div className="small muted">Ref: {h.source_reference}</div>}</td></tr>})}</tbody></table></div>}
    <p className="small muted" style={{marginTop:12}}>Showing at most 500 recent history events from the database query. Last refreshed: {lastRefreshed?.toLocaleString("en-IN",{timeZone:"Asia/Kolkata"})??"—"}.</p>
   </section>
   <div className="action-row" style={{marginTop:16}}><Link className="btn btn-secondary" href="/inventory">Current / sold gold</Link><Link className="btn btn-secondary" href="/purchasing">Purchasing</Link><Link className="btn btn-secondary" href="/stocktakes">Stock reconciliation</Link></div>
  </>}
 </div></main>;
}
