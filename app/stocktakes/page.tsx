"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { ArrowLeft, Barcode, CheckCircle2, CircleAlert, ClipboardCheck, ClipboardList, PackageSearch, RefreshCw, ScanLine } from "lucide-react";
import { createClient } from "@/lib/supabase/client";

type Membership={tenant_id:string;branch_id:string|null;role:string;tenants:{display_name:string;slug:string}|null};
type Branch={id:string;name:string;branch_code:string};
type Stocktake={id:string;tenant_id:string;branch_id:string;count_number:string;count_name:string;status:string;started_at:string;completed_at:string|null;snapshot_count:number;found_count:number;missing_count:number;extra_count:number;changed_during_count:number;notes:string|null};
type StocktakeLine={id:string;stocktake_id:string;inventory_item_id:string;line_type:string;expected_status:string;is_counted:boolean;counted_at:string|null;notes:string|null};
type Item={id:string;item_code:string;serial_number:string|null;barcode:string|null;huid:string|null;status:string;branch_id:string;product_id:string;gross_weight_grams:number|null;net_metal_weight_grams:number|null;stone_weight_grams:number|null};
type Product={id:string;product_code:string;name:string};
type Resolution={id:string;stocktake_id:string;stocktake_line_id:string;inventory_item_id:string;resolution_type:string;reason:string;created_by:string;created_at:string};

export default function StocktakesPage(){
 const router=useRouter();
 const [memberships,setMemberships]=useState<Membership[]>([]);
 const [tenantId,setTenantId]=useState("");
 const [branches,setBranches]=useState<Branch[]>([]);
 const [branchId,setBranchId]=useState("");
 const [stocktakes,setStocktakes]=useState<Stocktake[]>([]);
 const [selectedId,setSelectedId]=useState("");
 const [lines,setLines]=useState<StocktakeLine[]>([]);
 const [resolutions,setResolutions]=useState<Resolution[]>([]);
 const [resolutionReason,setResolutionReason]=useState("");
 const [items,setItems]=useState<Item[]>([]);
 const [products,setProducts]=useState<Product[]>([]);
 const [countName,setCountName]=useState("Monthly physical stock count");
 const [scanValue,setScanValue]=useState("");
 const [notes,setNotes]=useState("");
 const [loading,setLoading]=useState(true);
 const [busy,setBusy]=useState(false);
 const [error,setError]=useState("");
 const [notice,setNotice]=useState("");
 const [lastResult,setLastResult]=useState<Record<string,number|string>|null>(null);

 const member=memberships.find(m=>m.tenant_id===tenantId);
 const canCount=["owner","manager","inventory_manager"].includes(member?.role??"");
 const canFinalize=["owner","manager"].includes(member?.role??"");
 const selected=stocktakes.find(s=>s.id===selectedId)??null;
 const itemMap=useMemo(()=>new Map(items.map(x=>[x.id,x])),[items]);
 const productMap=useMemo(()=>new Map(products.map(x=>[x.id,x])),[products]);
 const lineItemIds=useMemo(()=>new Set(lines.map(x=>x.inventory_item_id)),[lines]);
 const term=scanValue.trim().toLowerCase();
 const matchingItems=useMemo(()=>term?items.filter(item=>!lineItemIds.has(item.id)&&[item.item_code,item.serial_number,item.barcode,item.huid,productMap.get(item.product_id)?.name,productMap.get(item.product_id)?.product_code].some(v=>String(v??"").toLowerCase().includes(term))).slice(0,20):[],[items,lineItemIds,term,productMap]);
 const expectedLines=lines.filter(x=>x.line_type==="expected");
 const foundLines=expectedLines.filter(x=>x.is_counted);
 const uncountedExpected=expectedLines.filter(x=>!x.is_counted);
 const extraLines=lines.filter(x=>x.line_type==="extra");
 const resolutionMap=useMemo(()=>new Map(resolutions.map(x=>[x.stocktake_line_id,x])),[resolutions]);

 useEffect(()=>{let active=true;void(async()=>{try{
  const supabase=createClient();const {data:{user}}=await supabase.auth.getUser();if(!user){router.replace("/login");return;}
  const {data,error:queryError}=await supabase.from("tenant_memberships").select("tenant_id,branch_id,role,tenants(display_name,slug)").eq("user_id",user.id).eq("is_active",true);
  if(queryError)throw queryError;if(!active)return;const rows=(data??[]) as unknown as Membership[];setMemberships(rows);setTenantId(rows[0]?.tenant_id??"");
 }catch{if(active)setError("Could not load shop access. Check authentication and migrations.");}finally{if(active)setLoading(false)}})();return()=>{active=false}},[router]);

 const loadWorkspace=useCallback(async()=>{
  if(!tenantId){setBranches([]);setStocktakes([]);setItems([]);setProducts([]);return;}
  const supabase=createClient();
  const [b,s,p]=await Promise.all([
   supabase.from("branches").select("id,name,branch_code").eq("tenant_id",tenantId).eq("is_active",true).order("name"),
   supabase.from("inventory_stocktakes").select("id,tenant_id,branch_id,count_number,count_name,status,started_at,completed_at,snapshot_count,found_count,missing_count,extra_count,changed_during_count,notes").eq("tenant_id",tenantId).order("started_at",{ascending:false}).limit(200),
   supabase.from("products").select("id,product_code,name").eq("tenant_id",tenantId).limit(2000)
  ]);
  if(b.error||s.error||p.error){setError("Could not load branches, stocktakes or catalogue records. Apply the stocktake migration and verify RLS access.");return;}
  setBranches((b.data??[]) as Branch[]);setStocktakes((s.data??[]) as Stocktake[]);setProducts((p.data??[]) as Product[]);
  if(!branchId){const membership=memberships.find(m=>m.tenant_id===tenantId);const initial=membership?.branch_id??(b.data??[])[0]?.id??"";if(initial)setBranchId(initial);}
  setError("");
 },[tenantId,branchId,memberships]);
 useEffect(()=>{void loadWorkspace()},[loadWorkspace]);

 const loadItems=useCallback(async()=>{
  if(!tenantId||!branchId){setItems([]);return;}
  const {data,error:queryError}=await createClient().from("inventory_items")
   .select("id,item_code,serial_number,barcode,huid,status,branch_id,product_id,gross_weight_grams,net_metal_weight_grams,stone_weight_grams")
   .eq("tenant_id",tenantId).eq("branch_id",branchId).in("status",["in_stock","reserved","repair"]).order("item_code").limit(5000);
  if(queryError){setError("Could not load current branch items for scan lookup.");return;}
  setItems((data??[]) as Item[]);
 },[tenantId,branchId]);
 useEffect(()=>{void loadItems()},[loadItems]);

 async function openStocktake(id:string){
  setError("");setNotice("");setLastResult(null);setSelectedId(id);
  const supabase=createClient();
  const [lineResult,resolutionResult]=await Promise.all([
   supabase.from("inventory_stocktake_lines").select("id,stocktake_id,inventory_item_id,line_type,expected_status,is_counted,counted_at,notes").eq("tenant_id",tenantId).eq("stocktake_id",id).order("line_type").limit(10000),
   supabase.from("inventory_stocktake_resolutions").select("id,stocktake_id,stocktake_line_id,inventory_item_id,resolution_type,reason,created_by,created_at").eq("tenant_id",tenantId).eq("stocktake_id",id).order("created_at",{ascending:false}).limit(10000)
  ]);
  if(lineResult.error||resolutionResult.error){setError("Could not load the stocktake snapshot or resolution history. Verify the discrepancy-resolution migration and branch access.");return;}
  setLines((lineResult.data??[]) as StocktakeLine[]);setResolutions((resolutionResult.data??[]) as Resolution[]);setScanValue("");setNotes("");setResolutionReason("");
 }

 async function refresh(){await loadWorkspace();await loadItems();if(selectedId)await openStocktake(selectedId);}

 async function createStocktake(e:FormEvent<HTMLFormElement>){
  e.preventDefault();setError("");setNotice("");setLastResult(null);
  if(!branchId||!countName.trim()){setError("Choose a branch and enter a count name.");return;}
  setBusy(true);
  try{
   const {data,error:rpcError}=await createClient().rpc("create_inventory_stocktake",{p_tenant_id:tenantId,p_branch_id:branchId,p_count_name:countName.trim()});
   if(rpcError||!data)throw rpcError??new Error("Stocktake not created");
   const id=String(data);await loadWorkspace();await openStocktake(id);
   setNotice("Stocktake snapshot created. Items on hand at the selected branch are frozen into a count checklist; subsequent movements are reported separately.");
  }catch{setError("Stocktake could not be created. Only authorised staff can start a count for an active branch.");}
  finally{setBusy(false);}
 }

 async function markItem(item:Item,isCounted:boolean){
  if(!selected||selected.status!=="open")return;
  setError("");setNotice("");setBusy(true);
  try{
   const {error:rpcError}=await createClient().rpc("mark_inventory_stocktake_item",{
    p_tenant_id:tenantId,p_stocktake_id:selected.id,p_inventory_item_id:item.id,p_is_counted:isCounted,p_notes:notes.trim()||null
   });
   if(rpcError)throw rpcError;
   await openStocktake(selected.id);setScanValue("");setNotes("");
   setNotice(isCounted?"Item marked as physically found.":"Count mark removed. The piece will be shown as unconfirmed until reconciled.");
  }catch{setError("Could not record this count. Confirm that the piece is in the selected branch and still has an on-hand status.");}
  finally{setBusy(false);}
 }

 async function markExistingLine(line:StocktakeLine,isCounted:boolean){
  const item=itemMap.get(line.inventory_item_id);if(!item){setError("This item is not in the current on-hand inventory list. It may have moved or been sold during the count.");return;}
  await markItem(item,isCounted);
 }

 async function finalize(){
  if(!selected)return;setError("");setNotice("");setLastResult(null);setBusy(true);
  try{
   const {data,error:rpcError}=await createClient().rpc("finalize_inventory_stocktake",{p_tenant_id:tenantId,p_stocktake_id:selected.id});
   if(rpcError)throw rpcError;
   const result=(data??{}) as Record<string,number|string>;setLastResult(result);
   await loadWorkspace();await openStocktake(selected.id);
   setNotice("Count finalised. The discrepancy summary is saved; missing items were not automatically written off.");
  }catch{setError("Only an authorised shop owner or manager can finalise an open stocktake. Refresh and check branch access.");}
  finally{setBusy(false);}
 }

 async function resolveDiscrepancy(line:StocktakeLine,resolution:"write_off"|"found_after_count"){
  if(!selected||selected.status!=="completed"||!canFinalize)return;
  const reason=resolutionReason.trim();
  if(reason.length<5||reason.length>500){setError("Enter a resolution reason between 5 and 500 characters.");return;}
  const stocktakeId=selected.id;
  setBusy(true);setError("");setNotice("");
  try{
   const {error:rpcError}=await createClient().rpc("resolve_inventory_stocktake_discrepancy",{
    p_tenant_id:tenantId,p_stocktake_id:stocktakeId,p_stocktake_line_id:line.id,p_resolution:resolution,p_reason:reason
   });
   if(rpcError)throw rpcError;
   setResolutionReason("");await loadWorkspace();await openStocktake(stocktakeId);
   setNotice(resolution==="write_off"?"Missing piece written off through the audited inventory workflow.":"Piece marked found after the stocktake, with reason and audit history.");
  }catch(e){const m=e&&typeof e==="object"&&"message" in e?String((e as {message?:unknown}).message??""):"";setError(m&&m.length<240?m:"Discrepancy could not be resolved. Confirm that the item remains at this branch and still has the expected on-hand status.");}
  finally{setBusy(false);}
 }

 const grams=(v:number|null|undefined)=>Number(v??0).toLocaleString("en-IN",{minimumFractionDigits:3,maximumFractionDigits:3});
 const itemLabel=(item:Item)=>{const product=productMap.get(item.product_id);return (product?.name??"Product")+" · "+item.item_code;};

 return <main><div className="page-wrap">
  <Link href="/dashboard" className="link-text small"><ArrowLeft size={13} style={{display:"inline",verticalAlign:"middle"}}/> Back to workspace</Link>
  <div style={{marginTop:20,marginBottom:24}}><div className="eyebrow"><ClipboardCheck size={14}/> Inventory control</div><h1 style={{marginTop:12}}>Stock reconciliation</h1><p className="lead">Snapshot a branch’s stock, scan pieces by item code/barcode/HUID, review missing or unexpected items, and finalise the count with a manager’s audit entry.</p></div>
  {error&&<div role="alert" className="notice" style={{marginBottom:14}}><CircleAlert size={16}/>{error}</div>}
  {notice&&<div role="status" className="notice" style={{marginBottom:14,background:"#edf7ef",borderColor:"#cfe4d4",color:"#1f5c3e"}}><CheckCircle2 size={16}/>{notice}</div>}
  {loading?<section className="panel">Loading shop access…</section>:memberships.length===0?<section className="panel"><h2>No shop linked</h2><Link className="btn btn-primary" href="/onboarding">Set up your shop</Link></section>:<>
   <div className="form-grid" style={{marginBottom:18}}>
    {memberships.length>1&&<div className="field"><label htmlFor="stocktake-shop">Shop</label><select id="stocktake-shop" value={tenantId} onChange={e=>{setTenantId(e.target.value);setBranchId("");setSelectedId("");setLines([]);}}>{memberships.map(m=><option key={m.tenant_id} value={m.tenant_id}>{m.tenants?.display_name??m.tenant_id}</option>)}</select></div>}
    <div className="field"><label htmlFor="stocktake-branch">Branch *</label><select id="stocktake-branch" value={branchId} onChange={e=>{setBranchId(e.target.value);setSelectedId("");setLines([]);}}><option value="">Choose branch</option>{branches.map(b=><option key={b.id} value={b.id}>{b.name} · {b.branch_code}</option>)}</select></div>
   </div>
   {canCount&&<section className="panel" style={{marginBottom:18}}><div className="section-head" style={{marginTop:0}}><div><div className="eyebrow">Start a count</div><h2 style={{marginTop:8}}>Create stocktake snapshot</h2></div><ClipboardList size={22}/></div><form onSubmit={createStocktake}><div className="form-grid"><div className="field"><label htmlFor="count-name">Count name *</label><input id="count-name" value={countName} onChange={e=>setCountName(e.target.value)} maxLength={160} minLength={3} required placeholder="Monthly physical stock count"/></div></div><button className="btn btn-primary" style={{marginTop:14}} type="submit" disabled={busy||!branchId}>{busy?"Creating snapshot…":"Start count & snapshot stock"}</button></form><p className="small muted" style={{marginTop:12,marginBottom:0}}>Starting a count does not freeze normal sales. Any item whose status changes during counting will be surfaced for review when you finalise.</p></section>}
   <div className="calc-layout">
    <section className="panel"><div className="section-head" style={{marginTop:0}}><div><div className="eyebrow">Count register</div><h2 style={{marginTop:8}}>Recent stocktakes</h2></div><button className="btn btn-secondary" type="button" onClick={()=>void refresh()} disabled={busy}><RefreshCw size={14}/> Refresh</button></div>
     {stocktakes.filter(s=>!branchId||s.branch_id===branchId).length===0?<p className="small muted">No stocktakes for this branch yet.</p>:<div style={{display:"grid",gap:9}}>{stocktakes.filter(s=>!branchId||s.branch_id===branchId).map(s=><button key={s.id} type="button" className="list-card" onClick={()=>void openStocktake(s.id)} style={{display:"flex",textAlign:"left",alignItems:"flex-start",width:"100%",cursor:"pointer",color:"inherit",background:selectedId===s.id?"#f1f6f1":undefined,borderColor:selectedId===s.id?"#b7d4be":undefined}}><div style={{minWidth:0,flex:1}}><strong>{s.count_number}</strong><div className="small muted" style={{marginTop:4}}>{s.count_name}</div><div className="small muted" style={{marginTop:4}}>{new Date(s.started_at).toLocaleString("en-IN")} · Snapshot {s.snapshot_count} piece(s)</div>{s.status==="completed"&&<div className="small muted" style={{marginTop:4}}>Found {s.found_count} · Missing {s.missing_count} · Extra {s.extra_count} · Changed {s.changed_during_count}</div>}</div><span className={"pill "+(s.status==="completed"?"pill-green":"pill-demo")}>{s.status}</span></button>)}</div>}
    </section>
    <section className="panel"><div className="section-head" style={{marginTop:0}}><div><div className="eyebrow">Scan and reconcile</div><h2 style={{marginTop:8}}>{selected?.count_number??"Select an open stocktake"}</h2></div><ScanLine size={22}/></div>
     {!selected?<p className="small muted">Choose a stocktake from the register to review its piece-by-piece checklist.</p>:<>
      <div className="dashboard-grid"><div className="metric-card"><span className="small muted">Snapshot pieces</span><div className="metric-value">{selected.snapshot_count}</div></div><div className="metric-card"><span className="small muted">Found on count</span><div className="metric-value">{foundLines.length}</div><div className="small muted">{uncountedExpected.length} expected pieces not yet marked</div></div><div className="metric-card"><span className="small muted">Unexpected pieces</span><div className="metric-value">{extraLines.length}</div></div></div>
      {selected.status==="open"&&canCount&&<div style={{marginTop:16,marginBottom:18}}><div className="field"><label htmlFor="scan-stock"><Barcode size={13} style={{display:"inline",verticalAlign:"middle"}}/> Search or scan item code, barcode, serial or HUID</label><input id="scan-stock" autoComplete="off" value={scanValue} onChange={e=>setScanValue(e.target.value)} placeholder="Scan barcode or type a stock identifier"/></div><div className="field" style={{marginTop:10}}><label htmlFor="count-notes">Count note (optional)</label><input id="count-notes" value={notes} onChange={e=>setNotes(e.target.value)} maxLength={300} placeholder="Shelf / discrepancy detail"/></div>
       {term&&<div style={{display:"grid",gap:8,marginTop:10}}>{matchingItems.length===0?<p className="small muted">No unlisted item in this branch matches. If you scanned an expected item, find it in the snapshot below.</p>:matchingItems.map(item=><div className="list-card" key={item.id}><div style={{minWidth:0}}><strong>{itemLabel(item)}</strong><div className="small muted">{item.barcode?"Barcode "+item.barcode+" · ":""}{item.huid?"HUID "+item.huid+" · ":""}Net {grams(item.net_metal_weight_grams)} g · {item.status.replaceAll("_"," ")}</div></div><button type="button" className="btn btn-secondary" disabled={busy} onClick={()=>void markItem(item,true)}>Add as extra & mark found</button></div>)}</div>}
      </div>}
      <div style={{display:"grid",gap:8}}>
       {lines.filter(line=>{const item=itemMap.get(line.inventory_item_id);return !term||[item?.item_code,item?.barcode,item?.huid,item?.serial_number,productMap.get(item?.product_id??"")?.name].some(v=>String(v??"").toLowerCase().includes(term));}).slice(0,500).map(line=>{const item=itemMap.get(line.inventory_item_id);return <article key={line.id} className="list-card" style={{alignItems:"flex-start",gap:12,flexWrap:"wrap"}}><div style={{flex:1,minWidth:0}}><strong>{item?itemLabel(item):"Stock item no longer in current inventory"}</strong><div className="small muted" style={{marginTop:4}}>{line.line_type==="extra"?"Unexpected item (not in the start snapshot)":"Expected status: "+line.expected_status.replaceAll("_"," ")} · {item?.barcode?"Barcode "+item.barcode+" · ":""}{item?.huid?"HUID "+item.huid:""}</div>{line.notes&&<div className="small muted" style={{marginTop:4}}>Note: {line.notes}</div>}{line.counted_at&&<div className="small muted" style={{marginTop:4}}>Counted {new Date(line.counted_at).toLocaleString("en-IN")}</div>}{resolutionMap.get(line.id)&&<div className="small muted" style={{marginTop:4}}>Resolution: {resolutionMap.get(line.id)?.resolution_type.replaceAll("_"," ")} · {resolutionMap.get(line.id)?.reason} · {resolutionMap.get(line.id)?.created_at?new Date(resolutionMap.get(line.id)!.created_at).toLocaleString("en-IN"):""}</div>}</div><div style={{display:"flex",gap:8,alignItems:"center",flexWrap:"wrap"}}>{line.is_counted?<span className="pill pill-green">Found</span>:<span className="pill pill-demo">Not found yet</span>}{selected.status==="open"&&canCount&&item&&<button className="btn btn-secondary" type="button" disabled={busy} onClick={()=>void markExistingLine(line,!line.is_counted)}>{line.is_counted?"Unmark":"Mark found"}</button>}</div></article>})}
       {lines.length===0&&<p className="small muted">The snapshot contains no individually tracked on-hand pieces. New pieces can still be added to the count as extras.</p>}
       {lines.length>500&&<p className="small muted">Showing the first 500 pieces. Use the search box to narrow down the register.</p>}
      </div>
      {selected.status==="open"&&canFinalize&&<div className="action-row" style={{marginTop:16}}><button type="button" className="btn btn-primary" disabled={busy} onClick={()=>void finalize()}>{busy?"Finalising…":"Finalise & record discrepancies"}</button></div>}
      {selected.status==="completed"&&<div className="notice" style={{marginTop:16}}><CheckCircle2 size={16}/><span>Final result: {selected.found_count} found, {selected.missing_count} missing, {selected.extra_count} extra, {selected.changed_during_count} changed during counting. No automatic write-off was made.</span></div>}
      {selected.status==="completed"&&canFinalize&&uncountedExpected.some(line=>!resolutionMap.has(line.id))&&<section className="panel" style={{marginTop:16,borderColor:"#e5d9bb"}}>
       <h3>Resolve missing pieces</h3><p className="small muted">Owner/manager review is required. Each action records a reason and audit entry. A piece that was sold, transferred, or changed status during counting must be reconciled against its movement history instead of written off here.</p>
       <div className="field" style={{marginBottom:12}}><label htmlFor="stocktake-resolution-reason">Resolution reason *</label><input id="stocktake-resolution-reason" value={resolutionReason} onChange={e=>setResolutionReason(e.target.value)} minLength={5} maxLength={500} placeholder="Physical search completed, item located, or authorised write-off basis"/></div>
       <div style={{display:"grid",gap:8}}>{uncountedExpected.filter(line=>!resolutionMap.has(line.id)).map(line=>{const item=itemMap.get(line.inventory_item_id);return <article className="list-card" key={line.id} style={{display:"flex",alignItems:"center",gap:12,flexWrap:"wrap"}}><div style={{flex:1,minWidth:0}}><strong>{item?itemLabel(item):"Stock item no longer in current inventory"}</strong><div className="small muted">Expected status: {line.expected_status.replaceAll("_"," ")}</div>{!item&&<div className="small muted">This item is no longer in the current on-hand list; review sales and transfer history before resolving it.</div>}</div>{item&&<div className="action-row" style={{marginTop:0}}><button className="btn btn-secondary" type="button" disabled={busy||resolutionReason.trim().length<5} onClick={()=>void resolveDiscrepancy(line,"write_off")}>Approve write-off</button><button className="btn btn-secondary" type="button" disabled={busy||resolutionReason.trim().length<5} onClick={()=>void resolveDiscrepancy(line,"found_after_count")}>Found after count</button></div>}</article>})}</div>
      </section>}
      {lastResult&&<div className="notice" style={{marginTop:10}}><ClipboardCheck size={16}/><span>Finalised: {String(lastResult.found_count??0)} found · {String(lastResult.missing_count??0)} missing · {String(lastResult.extra_count??0)} extra · {String(lastResult.changed_during_count??0)} changed during count</span></div>}
     </>}
    </section>
   </div>
   <div className="action-row" style={{marginTop:16}}><Link className="btn btn-secondary" href="/inventory">Open inventory</Link><Link className="btn btn-secondary" href="/purchasing">Purchasing & receipts</Link></div>
  </>}
 </div></main>;
}
