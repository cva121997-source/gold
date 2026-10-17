"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { ArrowLeft, ArrowDownLeft, ArrowRightLeft, CheckCircle2, CircleAlert, PackageCheck, Plus, RefreshCw, Send, ShieldCheck, Truck } from "lucide-react";
import { createClient } from "@/lib/supabase/client";

type Membership={tenant_id:string;branch_id:string|null;role:string;tenants:{display_name:string;slug:string}|null};
type Branch={id:string;name:string;branch_code:string};
type Product={id:string;product_code:string;name:string};
type Item={id:string;tenant_id:string;branch_id:string|null;product_id:string;item_code:string;status:string;barcode:string|null;huid:string|null;gross_weight_grams:number|null;net_metal_weight_grams:number|null;stone_weight_grams:number|null};
type Transfer={id:string;tenant_id:string;transfer_code:string;from_branch_id:string;to_branch_id:string;status:string;notes:string|null;created_by:string|null;requested_at:string|null;approved_by:string|null;approved_at:string|null;rejected_by:string|null;rejected_at:string|null;rejection_reason:string|null;dispatched_by:string|null;dispatched_at:string|null;received_by:string|null;received_at:string|null;expected_arrival_date:string|null;received_notes:string|null;created_at:string};
type TransferItem={id:string;transfer_id:string;inventory_item_id:string;notes:string|null;item_code_snapshot:string|null;product_code_snapshot:string|null;description_snapshot:string|null;huid_snapshot:string|null;barcode_snapshot:string|null;gross_weight_grams_snapshot:number|null;net_metal_weight_grams_snapshot:number|null};

const labelStatus=(s:string)=>s.replaceAll("_"," ");
export default function TransfersPage(){
 const router=useRouter();
 const [userId,setUserId]=useState("");
 const [memberships,setMemberships]=useState<Membership[]>([]);
 const [tenantId,setTenantId]=useState("");
 const [branches,setBranches]=useState<Branch[]>([]);
 const [branchFrom,setBranchFrom]=useState("");
 const [branchTo,setBranchTo]=useState("");
 const [products,setProducts]=useState<Product[]>([]);
 const [items,setItems]=useState<Item[]>([]);
 const [transfers,setTransfers]=useState<Transfer[]>([]);
 const [selectedId,setSelectedId]=useState("");
 const [transferItems,setTransferItems]=useState<TransferItem[]>([]);
 const [itemSearch,setItemSearch]=useState("");
 const [notes,setNotes]=useState("");
 const [arrivalDate,setArrivalDate]=useState("");
 const [reviewReason,setReviewReason]=useState("");
 const [receivedNotes,setReceivedNotes]=useState("");
 const [cancelReason,setCancelReason]=useState("");
 const [loading,setLoading]=useState(true);
 const [busy,setBusy]=useState(false);
 const [error,setError]=useState("");
 const [notice,setNotice]=useState("");
 const [lastResult,setLastResult]=useState<Record<string,unknown>|null>(null);

 const member=memberships.find(x=>x.tenant_id===tenantId);
 const canManage=["owner","manager","inventory_manager"].includes(member?.role??"");
 const canReview=["owner","manager"].includes(member?.role??"");
 const selected=transfers.find(x=>x.id===selectedId)??null;
 const branchMap=useMemo(()=>new Map(branches.map(x=>[x.id,x])),[branches]);
 const productMap=useMemo(()=>new Map(products.map(x=>[x.id,x])),[products]);
 const selectedItemIds=useMemo(()=>new Set(transferItems.map(x=>x.inventory_item_id)),[transferItems]);
 const sourceItems=items.filter(i=>i.branch_id===selected?.from_branch_id&&i.status==="in_stock"&&!selectedItemIds.has(i.id));
 const term=itemSearch.trim().toLowerCase();
 const matchingItems=sourceItems.filter(i=>!term||[i.item_code,i.barcode,i.huid,productMap.get(i.product_id)?.product_code,productMap.get(i.product_id)?.name].some(v=>String(v??"").toLowerCase().includes(term))).slice(0,50);
 const money=(v:number|null|undefined)=>new Intl.NumberFormat("en-IN",{style:"currency",currency:"INR",maximumFractionDigits:2}).format(Number(v??0));

 useEffect(()=>{let active=true;void(async()=>{try{
  const supabase=createClient();const {data:{user}}=await supabase.auth.getUser();if(!user){router.replace("/login");return;}if(active)setUserId(user.id);
  const {data,error:queryError}=await supabase.from("tenant_memberships").select("tenant_id,branch_id,role,tenants(display_name,slug)").eq("user_id",user.id).eq("is_active",true);
  if(queryError)throw queryError;if(!active)return;const rows=(data??[]) as unknown as Membership[];setMemberships(rows);setTenantId(rows[0]?.tenant_id??"");if(rows[0]?.branch_id)setBranchFrom(rows[0].branch_id);
 }catch{if(active)setError("Could not load shop access. Check authentication and Supabase setup.");}finally{if(active)setLoading(false)}})();return()=>{active=false}},[router]);

 const load=useCallback(async()=>{
  if(!tenantId){setBranches([]);setProducts([]);setItems([]);setTransfers([]);return;}
  const supabase=createClient();
  const [b,p,t]=await Promise.all([
   supabase.from("branches").select("id,name,branch_code").eq("tenant_id",tenantId).eq("is_active",true).order("name"),
   supabase.from("products").select("id,product_code,name").eq("tenant_id",tenantId).order("name").limit(3000),
   supabase.from("stock_transfers").select("id,tenant_id,transfer_code,from_branch_id,to_branch_id,status,notes,created_by,requested_at,approved_by,approved_at,rejected_by,rejected_at,rejection_reason,dispatched_by,dispatched_at,received_by,received_at,expected_arrival_date,received_notes,created_at").eq("tenant_id",tenantId).order("created_at",{ascending:false}).limit(300)
  ]);
  if(b.error||p.error||t.error){setError("Could not load branches or transfer register. Verify transfer migration and branch access.");return;}
  setBranches((b.data??[]) as Branch[]);setProducts((p.data??[]) as Product[]);setTransfers((t.data??[]) as Transfer[]);
  const current=memberships.find(m=>m.tenant_id===tenantId);
  const branchList=(b.data??[]) as Branch[];
  if(!branchFrom){const initial=current?.branch_id??branchList[0]?.id??"";if(initial)setBranchFrom(initial);}
  if(!branchTo){const other=branchList.find(x=>x.id!==branchFrom);if(other)setBranchTo(other.id);}
  setError("");
 },[tenantId,memberships,branchFrom,branchTo]);
 useEffect(()=>{void load()},[load]);

 const loadItems=useCallback(async()=>{
  if(!tenantId){setItems([]);return;}
  const {data,error:queryError}=await createClient().from("inventory_items").select("id,tenant_id,branch_id,product_id,item_code,status,barcode,huid,gross_weight_grams,net_metal_weight_grams,stone_weight_grams").eq("tenant_id",tenantId).in("status",["in_stock","transfer_pending","in_transit"]).order("item_code").limit(5000);
  if(queryError){setError("Could not load transferable inventory for accessible branches.");return;}setItems((data??[]) as Item[]);
 },[tenantId]);
 useEffect(()=>{void loadItems()},[loadItems]);

 async function openTransfer(id:string){
  setSelectedId(id);setError("");setNotice("");setLastResult(null);setItemSearch("");setReviewReason("");setCancelReason("");
  const {data,error:queryError}=await createClient().from("stock_transfer_items")
   .select("id,transfer_id,inventory_item_id,notes,item_code_snapshot,product_code_snapshot,description_snapshot,huid_snapshot,barcode_snapshot,gross_weight_grams_snapshot,net_metal_weight_grams_snapshot")
   .eq("tenant_id",tenantId).eq("transfer_id",id).order("id").limit(2000);
  if(queryError){setError("Could not load the transfer’s item list.");return;}setTransferItems((data??[]) as TransferItem[]);
 }
 async function refresh(){await load();await loadItems();if(selectedId)await openTransfer(selectedId);}

 async function createTransfer(e:FormEvent<HTMLFormElement>){
  e.preventDefault();setError("");setNotice("");setLastResult(null);
  if(!branchFrom||!branchTo||branchFrom===branchTo){setError("Choose two different branches within the same shop.");return;}
  setBusy(true);
  try{
   const {data,error:rpcError}=await createClient().rpc("create_stock_transfer",{p_tenant_id:tenantId,p_from_branch_id:branchFrom,p_to_branch_id:branchTo,p_notes:notes.trim()||null,p_expected_arrival_date:arrivalDate||null});
   if(rpcError||!data)throw rpcError??new Error("Transfer not created");
   const id=String(data);setNotes("");setArrivalDate("");await load();await openTransfer(id);
   setNotice("Draft transfer created. Add stock items and submit for independent manager approval.");
  }catch{setError("Could not create transfer. Ensure your role has access to both active branches.");}
  finally{setBusy(false);}
 }

 async function addItem(item:Item){
  if(!selected||selected.status!=="draft")return;setError("");setNotice("");setBusy(true);
  try{
   const {error:rpcError}=await createClient().rpc("add_stock_transfer_item",{p_tenant_id:tenantId,p_transfer_id:selected.id,p_inventory_item_id:item.id,p_notes:null});
   if(rpcError)throw rpcError;await openTransfer(selected.id);await loadItems();setNotice(item.item_code+" added to draft transfer.");
  }catch{setError("Item not added. It must be available in the source branch and not reserved or already in another active transfer.");}
  finally{setBusy(false);}
 }

 async function runAction(action:"submit"|"approve"|"reject"|"dispatch"|"receive"|"cancel"){
  if(!selected)return;setError("");setNotice("");setLastResult(null);
  if(action==="reject"&&reviewReason.trim().length<5){setError("A rejection reason of at least 5 characters is required.");return;}
  if(action==="cancel"&&cancelReason.trim().length<5){setError("A cancellation reason of at least 5 characters is required.");return;}
  setBusy(true);
  try{
   const supabase=createClient();let result:{data:unknown;error:{message?:string}|null};
   if(action==="submit")result=await supabase.rpc("submit_stock_transfer",{p_tenant_id:tenantId,p_transfer_id:selected.id});
   else if(action==="approve"||action==="reject")result=await supabase.rpc("review_stock_transfer",{p_tenant_id:tenantId,p_transfer_id:selected.id,p_decision:action,p_reason:action==="reject"?reviewReason.trim():null});
   else if(action==="dispatch")result=await supabase.rpc("dispatch_stock_transfer",{p_tenant_id:tenantId,p_transfer_id:selected.id});
   else if(action==="receive")result=await supabase.rpc("receive_stock_transfer",{p_tenant_id:tenantId,p_transfer_id:selected.id,p_receive_notes:receivedNotes.trim()||null});
   else result=await supabase.rpc("cancel_stock_transfer",{p_tenant_id:tenantId,p_transfer_id:selected.id,p_reason:cancelReason.trim()});
   if(result.error)throw result.error;
   if(result.data&&typeof result.data==="object")setLastResult(result.data as Record<string,unknown>);
   setReviewReason("");setCancelReason("");setReceivedNotes("");await load();await openTransfer(selected.id);await loadItems();
   setNotice(action==="submit"?"Transfer submitted and included items have been reserved from sale.":action==="approve"?"Transfer approved by a separate manager.":action==="reject"?"Transfer rejected and pending items returned to available stock.":action==="dispatch"?"Items dispatched. They remain unavailable and are assigned to the destination only after receipt.":action==="receive"?"Destination branch confirmed receipt and ownership of stock is now updated.":"Transfer cancelled under the authorised workflow.");
  }catch(e){const message=e&&typeof e==="object"&&"message" in e?String((e as {message?:unknown}).message??""): "";setError(message&&message.length<240?message:"Action failed. Verify current transfer status, branch permissions and whether a second manager is required.");}
  finally{setBusy(false);}
 }

 const allowedApprove=selected?.status==="pending_approval"&&canReview&&selected.created_by!==userId;
 const fromName=selected?branchMap.get(selected.from_branch_id)?.name??"Source branch":"Source branch";
 const toName=selected?branchMap.get(selected.to_branch_id)?.name??"Destination branch":"Destination branch";
 const transferInCurrentBranch=!!selected&&(member?.branch_id==null||member.branch_id===selected.from_branch_id||member.branch_id===selected.to_branch_id);
 return <main><div className="page-wrap">
  <Link href="/dashboard" className="link-text small"><ArrowLeft size={13} style={{display:"inline",verticalAlign:"middle"}}/> Back to workspace</Link>
  <div style={{marginTop:20,marginBottom:24}}><div className="eyebrow"><ArrowRightLeft size={14}/> Inventory governance</div><h1 style={{marginTop:12}}>Branch transfers</h1><p className="lead">Request transfers, collect independent approval, dispatch tracked pieces and confirm receiving separately. An item stays out of saleable stock until the destination branch acknowledges it.</p></div>
  {error&&<div role="alert" className="notice" style={{marginBottom:14}}><CircleAlert size={16}/>{error}</div>}
  {notice&&<div role="status" className="notice" style={{marginBottom:14,background:"#edf7ef",borderColor:"#cfe4d4",color:"#1f5c3e"}}><CheckCircle2 size={16}/>{notice}</div>}
  {loading?<section className="panel">Loading branch access…</section>:memberships.length===0?<section className="panel"><h2>No shop linked</h2><Link className="btn btn-primary" href="/onboarding">Set up your shop</Link></section>:<>
   {memberships.length>1&&<div className="field" style={{maxWidth:460,marginBottom:16}}><label htmlFor="transfer-shop">Shop</label><select id="transfer-shop" value={tenantId} onChange={e=>{setTenantId(e.target.value);setSelectedId("");setTransferItems([]);setBranchFrom("");setBranchTo("");}}>{memberships.map(m=><option key={m.tenant_id} value={m.tenant_id}>{m.tenants?.display_name??m.tenant_id}</option>)}</select></div>}
   <div className="calc-layout">
    <section className="panel"><div className="section-head" style={{marginTop:0}}><div><div className="eyebrow">New transfer request</div><h2 style={{marginTop:8}}>Move jewellery between branches</h2></div><Truck size={22}/></div>
     {canManage? <form onSubmit={createTransfer}><div className="form-grid">
      <div className="field"><label htmlFor="transfer-from">From branch *</label><select id="transfer-from" required value={branchFrom} onChange={e=>{setBranchFrom(e.target.value);setItemSearch("");}}><option value="">Choose source</option>{branches.map(b=><option key={b.id} value={b.id}>{b.name} · {b.branch_code}</option>)}</select></div>
      <div className="field"><label htmlFor="transfer-to">To branch *</label><select id="transfer-to" required value={branchTo} onChange={e=>setBranchTo(e.target.value)}><option value="">Choose destination</option>{branches.filter(b=>b.id!==branchFrom).map(b=><option key={b.id} value={b.id}>{b.name} · {b.branch_code}</option>)}</select></div>
      <div className="field"><label htmlFor="transfer-arrival">Expected arrival</label><input id="transfer-arrival" type="date" value={arrivalDate} onChange={e=>setArrivalDate(e.target.value)}/></div>
      <div className="field"><label htmlFor="transfer-notes">Reason / instructions</label><input id="transfer-notes" maxLength={500} value={notes} onChange={e=>setNotes(e.target.value)} placeholder="Branch replenishment, customer request…"/></div>
     </div><button className="btn btn-primary" style={{marginTop:14}} type="submit" disabled={busy||!branchFrom||!branchTo||branchFrom===branchTo}>Create draft transfer</button></form>:<div className="notice">Your role cannot create stock transfers.</div>}
     <div className="notice" style={{marginTop:15}}><ShieldCheck size={15}/><span>Only a different owner/manager can approve the requester’s submission. Direct database writes are disabled; steps are audited.</span></div>
    </section>
    <section className="panel"><div className="section-head" style={{marginTop:0}}><div><div className="eyebrow">Transfer register</div><h2 style={{marginTop:8}}>Recent requests</h2></div><button type="button" className="btn btn-secondary" onClick={()=>void refresh()} disabled={busy}><RefreshCw size={14}/> Refresh</button></div>
     {transfers.length===0?<p className="small muted">No transfer requests yet.</p>:<div style={{display:"grid",gap:9}}>{transfers.map(t=><button key={t.id} type="button" className="list-card" onClick={()=>void openTransfer(t.id)} style={{display:"flex",width:"100%",textAlign:"left",alignItems:"flex-start",gap:10,cursor:"pointer",color:"inherit",background:selectedId===t.id?"#f1f6f1":undefined,borderColor:selectedId===t.id?"#b7d4be":undefined}}><div style={{flex:1,minWidth:0}}><strong>{t.transfer_code}</strong><div className="small muted" style={{marginTop:4}}>{branchMap.get(t.from_branch_id)?.name??"Source"} → {branchMap.get(t.to_branch_id)?.name??"Destination"}</div><div className="small muted" style={{marginTop:4}}>{new Date(t.created_at).toLocaleString("en-IN")}</div></div><span className={"pill "+(t.status==="received"?"pill-green":t.status==="rejected"||t.status==="cancelled"?"pill-demo":"pill-blue")}>{labelStatus(t.status)}</span></button>)}</div>}
    </section>
   </div>
   {selected&&<section className="panel" style={{marginTop:18}}>
    <div className="section-head" style={{marginTop:0,alignItems:"flex-start"}}><div><div className="eyebrow">Workflow detail</div><h2 style={{marginTop:8}}>{selected.transfer_code}</h2><p className="small muted" style={{marginBottom:0}}>{fromName} → {toName}</p><p className="small muted" style={{marginTop:4,marginBottom:0}}>Expected arrival: {selected.expected_arrival_date??"Not set"} · Status: {labelStatus(selected.status)}</p></div><span className={"pill "+(selected.status==="received"?"pill-green":"pill-blue")}>{labelStatus(selected.status)}</span></div>
    {selected.notes&&<p className="small muted">{selected.notes}</p>}
    {selected.rejection_reason&&<div className="notice" style={{marginBottom:14}}>Reason recorded: {selected.rejection_reason}</div>}
    {selected.status==="draft"&&transferInCurrentBranch&&canManage&&<div style={{marginTop:16,marginBottom:16}}><h3>Add available stock</h3><div className="field"><label htmlFor="transfer-item-search">Search source item by item code, barcode, HUID or product</label><input id="transfer-item-search" value={itemSearch} onChange={e=>setItemSearch(e.target.value)} placeholder="Scan / enter stock identifier"/></div>
     <div style={{display:"grid",gap:8,marginTop:10}}>{matchingItems.length===0?<p className="small muted">{sourceItems.length===0?"No available stock items are visible for this source branch.":"No unselected source item matches your search."}</p>:matchingItems.map(item=><div key={item.id} className="list-card" style={{display:"flex",gap:12,alignItems:"center"}}><div style={{flex:1,minWidth:0}}><strong>{productMap.get(item.product_id)?.name??"Jewellery piece"} · {item.item_code}</strong><div className="small muted">{productMap.get(item.product_id)?.product_code??""} · Barcode {item.barcode??"—"} · HUID {item.huid??"—"}</div></div><button className="btn btn-secondary" type="button" disabled={busy} onClick={()=>void addItem(item)}><Plus size={14}/> Add piece</button></div>)}</div>
     <div className="small muted" style={{marginTop:8}}>Showing up to 50 search results. Items are revalidated by the database when added and again at submission.</div>
    </div>}
    <h3>Transfer item manifest</h3>
    {transferItems.length===0?<p className="small muted">No pieces added yet.</p>:<div style={{display:"grid",gap:8}}>{transferItems.map(item=><div key={item.id} className="list-card"><div><strong>{item.item_code_snapshot??item.inventory_item_id.slice(0,8)} · {item.description_snapshot??"Stock item"}</strong><div className="small muted">{item.product_code_snapshot??""} · HUID {item.huid_snapshot??"—"} · Barcode {item.barcode_snapshot??"—"}</div><div className="small muted">Gross {item.gross_weight_grams_snapshot==null?"—":Number(item.gross_weight_grams_snapshot).toFixed(3)} g · Net {item.net_metal_weight_grams_snapshot==null?"—":Number(item.net_metal_weight_grams_snapshot).toFixed(3)} g {item.notes?"· "+item.notes:""}</div></div><PackageCheck size={18}/></div>)}</div>}
    <div className="action-row" style={{marginTop:16,flexWrap:"wrap"}}>
     {selected.status==="draft"&&canManage&&<button className="btn btn-primary" type="button" disabled={busy||transferItems.length===0} onClick={()=>void runAction("submit")}><Send size={14}/> Submit for approval</button>}
     {allowedApprove&&<button className="btn btn-primary" type="button" disabled={busy} onClick={()=>void runAction("approve")}><ShieldCheck size={14}/> Approve (second person)</button>}
     {selected.status==="approved"&&canManage&&<button className="btn btn-primary" type="button" disabled={busy} onClick={()=>void runAction("dispatch")}><Truck size={14}/> Mark dispatched</button>}
     {selected.status==="in_transit"&&canManage&&<button className="btn btn-primary" type="button" disabled={busy} onClick={()=>void runAction("receive")}><ArrowDownLeft size={14}/> Confirm received at destination</button>}
    </div>
    {selected.status==="pending_approval"&&canReview&&selected.created_by!==userId&&<div className="form-grid" style={{marginTop:12}}><div className="field"><label htmlFor="transfer-reject-reason">Reject reason (required to reject)</label><input id="transfer-reject-reason" value={reviewReason} onChange={e=>setReviewReason(e.target.value)} minLength={5} maxLength={500} placeholder="Reason for rejection"/></div><div className="field" style={{alignSelf:"end"}}><button className="btn btn-secondary" type="button" disabled={busy||reviewReason.trim().length<5} onClick={()=>void runAction("reject")}>Reject request</button></div></div>}
    {selected.status==="in_transit"&&canManage&&<div className="field" style={{maxWidth:600,marginTop:12}}><label htmlFor="transfer-receive-notes">Receiving note (optional)</label><input id="transfer-receive-notes" maxLength={500} value={receivedNotes} onChange={e=>setReceivedNotes(e.target.value)} placeholder="Seal checked, all pieces verified…"/></div>}
    {["draft","pending_approval","approved"].includes(selected.status)&&canManage&&<div className="form-grid" style={{marginTop:12}}><div className="field"><label htmlFor="transfer-cancel-reason">Cancellation reason (required to cancel)</label><input id="transfer-cancel-reason" value={cancelReason} onChange={e=>setCancelReason(e.target.value)} minLength={5} maxLength={500} placeholder="Explain why this transfer is cancelled"/></div><div className="field" style={{alignSelf:"end"}}><button className="btn btn-secondary" type="button" disabled={busy||cancelReason.trim().length<5} onClick={()=>void runAction("cancel")}>Cancel transfer</button></div></div>}
    {selected.status==="pending_approval"&&selected.created_by===userId&&<div className="notice" style={{marginTop:12}}>You requested this transfer and cannot approve it yourself. Ask another owner or manager with access to either branch.</div>}
    {selected.status==="received"&&<div className="notice" style={{marginTop:12}}><CheckCircle2 size={15}/><span>Received {selected.received_at?new Date(selected.received_at).toLocaleString("en-IN"):""} · receiver recorded: {selected.received_by?"Yes":"No"} {selected.received_notes?"· "+selected.received_notes:""}</span></div>}
    {lastResult&&<p className="small muted" style={{marginTop:12}}>Latest workflow result: {JSON.stringify(lastResult)}</p>}
   </section>}
   <div className="action-row" style={{marginTop:16}}><Link className="btn btn-secondary" href="/inventory">Current / sold gold</Link><Link className="btn btn-secondary" href="/inventory-controls">Stock alerts & valuation</Link><Link className="btn btn-secondary" href="/stocktakes">Stock reconciliation</Link></div>
  </>}
 </div></main>;
}
