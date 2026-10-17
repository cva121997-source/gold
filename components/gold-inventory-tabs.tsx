"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Download, RefreshCw, Search, ShoppingBag, Coins, PackageCheck, Boxes } from "lucide-react";
import { createClient } from "@/lib/supabase/client";

export type GoldInventoryTab = "current" | "sold" | "operations";
type Metal = { id:number; code:string; name:string };
type Purity = { id:number; metal_id:number; code:string; label:string; fineness:number };
type Branch = { id:string; name:string; branch_code:string };
type Product = { id:string; tenant_id:string; product_code:string; name:string; metal_id:number|null; purity_id:number|null; gross_weight_grams:number; net_metal_weight_grams:number; stone_weight_grams:number; huid:string|null; barcode:string|null; };
type Item = { id:string; tenant_id:string; branch_id:string|null; product_id:string; item_code:string; status:string; current_valuation:number|null; created_at:string; barcode?:string|null; huid?:string|null; purity_id?:number|null; gross_weight_grams?:number|null; net_metal_weight_grams?:number|null; stone_weight_grams?:number|null };
type Invoice = { id:string; invoice_number:string; status:string; invoice_date:string; customer_id:string|null; branch_id:string|null; total_amount:number; amount_paid:number; customer_snapshot:Record<string,unknown> };
type InvoiceLine = { id:string; tenant_id:string; invoice_id:string; inventory_item_id:string|null; line_number:number; description:string; quantity:number; gross_weight_grams:number; net_metal_weight_grams:number; purity_label:string|null; rate_per_gram:number|null; line_total:number; tax_amount:number; item_snapshot:Record<string,unknown> };
type Customer = { id:string; full_name:string; customer_code:string; mobile_e164:string };
type CreditNote = { id:string; invoice_id:string };
type CreditLine = { invoice_line_id:string; quantity:number; gross_weight_grams:number; net_metal_weight_grams:number; line_total:number };
type SoldRow = {
  id:string; invoiceId:string; invoiceNumber:string; invoiceStatus:string; invoiceDate:string;
  customerName:string; customerCode:string; mobile:string; description:string; itemCode:string;
  huid:string; tracking:"Tracked stock item"|"Invoice line only"; purity:string;
  quantity:number; returnedQuantity:number; remainingQuantity:number;
  grossWeight:number; returnedGrossWeight:number; netWeight:number; returnedNetWeight:number;
  rate:number|null; originalAmount:number; creditedAmount:number; netAmount:number;
};

type Props = {
  tenantId:string;
  activeTab:GoldInventoryTab;
  onTabChange:(tab:GoldInventoryTab)=>void;
  products:Product[];
  items:Item[];
  branches:Branch[];
  metals:Metal[];
  purities:Purity[];
};

const money=(value:number)=>new Intl.NumberFormat("en-IN",{style:"currency",currency:"INR",maximumFractionDigits:2}).format(Number(value)||0);
const grams=(value:number)=>Number(value||0).toLocaleString("en-IN",{minimumFractionDigits:3,maximumFractionDigits:3});
const csvCell=(value:unknown)=>'"'+String(value??"").replaceAll('"','""')+'"';
function exportCsv(filename:string, rows:unknown[][]) {
  const csv=rows.map(row=>row.map(csvCell).join(",")).join("\r\n");
  const url=URL.createObjectURL(new Blob(["\ufeff"+csv],{type:"text/csv;charset=utf-8"}));
  const link=document.createElement("a");link.href=url;link.download=filename;link.click();URL.revokeObjectURL(url);
}
function recordName(value:unknown) { return typeof value==="string" ? value : ""; }

export default function GoldInventoryTabs({tenantId,activeTab,onTabChange,products,items,branches,metals,purities}:Props) {
  const [soldRows,setSoldRows]=useState<SoldRow[]>([]);
  const [soldLoading,setSoldLoading]=useState(false);
  const [soldError,setSoldError]=useState("");
  const [search,setSearch]=useState("");
  const [invoiceStatus,setInvoiceStatus]=useState("all");
  const [soldLoaded,setSoldLoaded]=useState(false);

  const productMap=useMemo(()=>new Map(products.map((p)=>[p.id,p])),[products]);
  const branchMap=useMemo(()=>new Map(branches.map((b)=>[b.id,b.name])),[branches]);
  const metalMap=useMemo(()=>new Map(metals.map((m)=>[m.id,m.name])),[metals]);
  const purityMap=useMemo(()=>new Map(purities.map((p)=>[p.id,p.label])),[purities]);

  const goldMetalIds=useMemo(()=>new Set(metals.filter((metal)=>metal.code.trim().toLowerCase()==="gold"||metal.code.trim().toLowerCase()==="au"||metal.name.toLowerCase().includes("gold")).map((metal)=>metal.id)),[metals]);
  const currentItems=useMemo(()=>items.filter((item)=>["in_stock","reserved","repair"].includes(item.status))
    .filter((item)=>{const product=productMap.get(item.product_id);return Boolean(product&&product.metal_id!==null&&goldMetalIds.has(product.metal_id));}),[items,productMap,goldMetalIds]);
  const currentWeight=currentItems.reduce((sum,item)=>sum+Number(item.net_metal_weight_grams??productMap.get(item.product_id)?.net_metal_weight_grams??0),0);
  const currentValue=currentItems.reduce((sum,item)=>sum+Number(item.current_valuation??0),0);
  const currentCountByStatus={in_stock:currentItems.filter(x=>x.status==="in_stock").length,reserved:currentItems.filter(x=>x.status==="reserved").length,repair:currentItems.filter(x=>x.status==="repair").length};

  const loadSold = useCallback(async () => {
    if(!tenantId){setSoldRows([]);setSoldLoaded(true);return;}
    setSoldLoading(true);setSoldError("");
    try {
      const supabase=createClient();
      const {data:invoiceData,error:invoiceError}=await supabase.from("invoices")
        .select("id,invoice_number,status,invoice_date,customer_id,branch_id,total_amount,amount_paid,customer_snapshot")
        .eq("tenant_id",tenantId).in("status",["issued","partially_paid","paid","credited"])
        .order("invoice_date",{ascending:false}).limit(2000);
      if(invoiceError)throw new Error("Could not read issued invoices. Check membership/branch access.");
      const invoices=(invoiceData??[]) as Invoice[];
      if(!invoices.length){setSoldRows([]);setSoldLoaded(true);return;}
      const invoiceIds=invoices.map((invoice)=>invoice.id);
      const {data:lineData,error:lineError}=await supabase.from("invoice_lines")
        .select("id,tenant_id,invoice_id,inventory_item_id,line_number,description,quantity,gross_weight_grams,net_metal_weight_grams,purity_label,rate_per_gram,line_total,tax_amount,item_snapshot")
        .eq("tenant_id",tenantId).in("invoice_id",invoiceIds).order("line_number",{ascending:true}).limit(10000);
      if(lineError)throw new Error("Could not read sold invoice lines. Refresh the schema or check staff permissions.");
      const lines=(lineData??[]) as InvoiceLine[];
      if(!lines.length){setSoldRows([]);setSoldLoaded(true);return;}

      const customerIds=[...new Set(invoices.map(i=>i.customer_id).filter((id):id is string=>Boolean(id)))];
      const customerPromise=customerIds.length
        ? supabase.from("tenant_customers").select("id,full_name,customer_code,mobile_e164").eq("tenant_id",tenantId).in("id",customerIds)
        : Promise.resolve({data:[],error:null});
      const {data:noteData,error:noteError}=await supabase.from("credit_notes")
        .select("id,invoice_id").eq("tenant_id",tenantId).eq("status","issued").in("invoice_id",invoiceIds).limit(5000);
      if(noteError)throw new Error("Could not load issued returns. Sold-gold totals cannot be safely adjusted without credit-note history.");
      const notes=(noteData??[]) as CreditNote[];
      const noteIds=notes.map(note=>note.id);
      const [customerResult,creditResult]=await Promise.all([
        customerPromise,
        noteIds.length
          ? supabase.from("credit_note_lines").select("invoice_line_id,quantity,gross_weight_grams,net_metal_weight_grams,line_total")
              .eq("tenant_id",tenantId).in("credit_note_id",noteIds).limit(10000)
          : Promise.resolve({data:[],error:null})
      ]);
      if(customerResult.error)throw new Error("Could not resolve customer names for the sold register.");
      if(creditResult.error)throw new Error("Could not load credit-note line history.");
      const customers=(customerResult.data??[]) as Customer[];
      const customerMap=new Map(customers.map(customer=>[customer.id,customer]));
      const invoiceMap=new Map(invoices.map(invoice=>[invoice.id,invoice]));
      const creditedMap=new Map<string,{quantity:number;gross:number;net:number;amount:number}>();
      for(const credit of (creditResult.data??[]) as CreditLine[]){
        const acc=creditedMap.get(credit.invoice_line_id)??{quantity:0,gross:0,net:0,amount:0};
        acc.quantity+=Number(credit.quantity);
        acc.gross+=Number(credit.gross_weight_grams);
        acc.net+=Number(credit.net_metal_weight_grams);
        acc.amount+=Number(credit.line_total);
        creditedMap.set(credit.invoice_line_id,acc);
      }
      const result:SoldRow[]=lines.map((line)=>{
        const invoice=invoiceMap.get(line.invoice_id);
        const customer=invoice?.customer_id?customerMap.get(invoice.customer_id):undefined;
        const snapshot=invoice?.customer_snapshot??{};
        const credit=creditedMap.get(line.id)??{quantity:0,gross:0,net:0,amount:0};
        const originalQty=Number(line.quantity);
        const remainingQuantity=Math.max(0,originalQty-credit.quantity);
        const description=recordName(line.item_snapshot?.product_name)||line.description;
        return {
          id:line.id,invoiceId:line.invoice_id,invoiceNumber:invoice?.invoice_number??line.invoice_id.slice(0,8),
          invoiceStatus:invoice?.status??"issued",invoiceDate:invoice?.invoice_date??"",
          customerName:customer?.full_name||recordName(snapshot.name)||"Walk-in customer",
          customerCode:customer?.customer_code||recordName(snapshot.customer_code),
          mobile:customer?.mobile_e164||recordName(snapshot.mobile),
          description,itemCode:recordName(line.item_snapshot?.item_code)||"",
          huid:recordName(line.item_snapshot?.huid)||"",
          tracking:line.inventory_item_id?"Tracked stock item":"Invoice line only",
          purity:line.purity_label||recordName(line.item_snapshot?.purity_label)||"—",
          quantity:originalQty,returnedQuantity:credit.quantity,remainingQuantity,
          grossWeight:Number(line.gross_weight_grams),returnedGrossWeight:credit.gross,
          netWeight:Number(line.net_metal_weight_grams),returnedNetWeight:credit.net,
          rate:line.rate_per_gram===null?null:Number(line.rate_per_gram),
          originalAmount:Number(line.line_total),creditedAmount:credit.amount,
          netAmount:Math.max(0,Number(line.line_total)-credit.amount)
        };
      });
      setSoldRows(result);setSoldLoaded(true);
    } catch(error) {
      setSoldError(error instanceof Error?error.message:"Sold-gold history could not be loaded.");
      setSoldRows([]);setSoldLoaded(true);
    } finally {setSoldLoading(false);}
  },[tenantId]);

  useEffect(()=>{
    if(activeTab==="sold"&&!soldLoaded)void loadSold();
  },[activeTab,soldLoaded,loadSold]);
  useEffect(()=>{
    setSoldLoaded(false);setSoldRows([]);setSearch("");setInvoiceStatus("all");
  },[tenantId]);

  const filteredCurrent=useMemo(()=>{
    const term=search.trim().toLowerCase();
    return currentItems.filter(item=>{
      const product=productMap.get(item.product_id);
      if(invoiceStatus!=="all"&&item.status!==invoiceStatus)return false;
      return !term||[product?.name,product?.product_code,item.item_code,item.huid,product?.huid,item.barcode,product?.barcode,branchMap.get(item.branch_id??"")].some(v=>String(v??"").toLowerCase().includes(term));
    });
  },[currentItems,productMap,search,invoiceStatus,branchMap]);
  const filteredSold=useMemo(()=>{
    const term=search.trim().toLowerCase();
    return soldRows.filter(row=>(invoiceStatus==="all"||row.invoiceStatus===invoiceStatus)&&
      (!term||[row.invoiceNumber,row.customerName,row.customerCode,row.mobile,row.description,row.itemCode,row.huid,row.purity].some(v=>String(v??"").toLowerCase().includes(term))));
  },[soldRows,search,invoiceStatus]);

  function exportCurrent(){
    exportCsv("gold-current-stock-"+new Date().toISOString().slice(0,10)+".csv",[
      ["Item code","Product","Status","Branch","Purity","HUID","Gross grams","Net metal grams","Valuation INR","Acquired"],
      ...filteredCurrent.map(item=>{const product=productMap.get(item.product_id);return [
        item.item_code,product?.name,item.status,branchMap.get(item.branch_id??"")??"Unassigned",
        item.purity_id?purityMap.get(item.purity_id):product?.purity_id?purityMap.get(product.purity_id):"",item.huid??product?.huid,
        item.gross_weight_grams??product?.gross_weight_grams,item.net_metal_weight_grams??product?.net_metal_weight_grams,item.current_valuation,item.created_at
      ];})
    ]);
  }
  function exportSold(){
    exportCsv("gold-sold-register-"+new Date().toISOString().slice(0,10)+".csv",[
      ["Invoice","Date","Customer","Customer code","Mobile","Description","Item code","HUID","Tracking","Purity","Sold quantity","Returned quantity","Gross grams","Net grams","Rate per gram","Original amount INR","Credit notes INR","Net sold amount INR","Invoice status"],
      ...filteredSold.map(row=>[row.invoiceNumber,row.invoiceDate,row.customerName,row.customerCode,row.mobile,row.description,row.itemCode,row.huid,row.tracking,row.purity,row.quantity,row.returnedQuantity,row.grossWeight,row.netWeight,row.rate,row.originalAmount,row.creditedAmount,row.netAmount,row.invoiceStatus])
    ]);
  }

  const tabs:[GoldInventoryTab,string,string][]=[
    ["current","Current Gold","Stock physically in the shop"],
    ["sold","Sold Gold","Customer and invoice register"],
    ["operations","Stock Operations","Receive and move items"]
  ];

  return <>
    <div role="tablist" aria-label="Gold inventory views" style={{display:"flex",gap:8,flexWrap:"wrap",marginBottom:18}}>
      {tabs.map(([id,label,description])=><button key={id} role="tab" aria-selected={activeTab===id} type="button" className={activeTab===id?"btn btn-primary":"btn btn-secondary"}
        onClick={()=>onTabChange(id)} style={{justifyContent:"flex-start",minWidth:150,flex:"1 1 170px"}}>
        {id==="current"?<Coins size={16}/>:id==="sold"?<ShoppingBag size={16}/>:<Boxes size={16}/>}
        <span style={{display:"grid",textAlign:"left",gap:2}}><strong>{label}</strong><small style={{fontSize:10,fontWeight:500,opacity:.85}}>{description}</small></span>
      </button>)}
    </div>

    {activeTab==="current"&&<section className="panel" role="tabpanel" aria-label="Current Gold">
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",gap:12,flexWrap:"wrap"}}>
        <div><div className="eyebrow"><PackageCheck size={14}/> Live stock register</div><h2 style={{marginTop:8}}>Current Gold</h2>
          <p className="small muted">Only catalogue-linked inventory records with an in-stock, reserved or repair status are counted. Valuation is the saved stock valuation; no live rate is fabricated.</p></div>
        <button className="btn btn-secondary" type="button" onClick={exportCurrent} disabled={filteredCurrent.length===0}><Download size={15}/> Export CSV</button>
      </div>
      <div className="dashboard-grid">
        <div className="metric-card"><span className="small muted">Gold items on hand</span><div className="metric-value">{currentItems.length.toLocaleString("en-IN")}</div><div className="small muted">{currentCountByStatus.in_stock} available · {currentCountByStatus.reserved} reserved · {currentCountByStatus.repair} in repair</div></div>
        <div className="metric-card"><span className="small muted">Net metal weight</span><div className="metric-value">{grams(currentWeight)} g</div><div className="small muted">Sum of recorded product net weights</div></div>
        <div className="metric-card"><span className="small muted">Recorded valuation</span><div className="metric-value">{money(currentValue)}</div><div className="small muted">Items without valuation contribute ₹0</div></div>
      </div>
      <div style={{display:"flex",gap:10,flexWrap:"wrap",marginBottom:14}}>
        <div className="field" style={{flex:"1 1 240px"}}><label htmlFor="current-search"><Search size={13} style={{display:"inline",verticalAlign:"middle"}}/> Search current gold</label><input id="current-search" value={search} onChange={e=>setSearch(e.target.value)} placeholder="Name, item code, barcode, HUID, branch"/></div>
        <div className="field" style={{width:"min(100%,220px)"}}><label htmlFor="current-status">Stock status</label><select id="current-status" value={invoiceStatus} onChange={e=>setInvoiceStatus(e.target.value)}><option value="all">All on-hand items</option><option value="in_stock">Available</option><option value="reserved">Reserved</option><option value="repair">In repair</option></select></div>
      </div>
      {filteredCurrent.length===0?<p className="small muted">No current gold items match this filter.</p>:<div style={{display:"grid",gap:10}}>
        {filteredCurrent.map(item=>{const product=productMap.get(item.product_id);return <article key={item.id} className="list-card" style={{alignItems:"flex-start",flexWrap:"wrap",minWidth:0}}>
          <div style={{minWidth:0,flex:"1 1 250px"}}><strong>{product?.name??"Product"}</strong><div className="small muted" style={{marginTop:4}}>Item {item.item_code} · Product {product?.product_code??"—"}</div>
            <div className="small muted" style={{marginTop:4}}>{item.purity_id?purityMap.get(item.purity_id):product?.purity_id?purityMap.get(product.purity_id):"Purity not set"} · {product?.metal_id?metalMap.get(product.metal_id):"Metal not set"} · HUID {item.huid||product?.huid||"—"} · Barcode {item.barcode||product?.barcode||"—"}</div>
            <div className="small muted" style={{marginTop:4}}>Branch: {branchMap.get(item.branch_id??"")??"Unassigned"} · Added {new Date(item.created_at).toLocaleDateString("en-IN")}</div>
          </div>
          <div style={{textAlign:"right"}}><strong>{grams(Number(item.net_metal_weight_grams??product?.net_metal_weight_grams??0))} g</strong><div className="small muted">net metal · gross {grams(Number(item.gross_weight_grams??product?.gross_weight_grams??0))} g</div><div style={{marginTop:8,fontWeight:750}}>{money(Number(item.current_valuation??0))}</div><span className={"pill "+(item.status==="in_stock"?"pill-green":"pill-demo")}>{item.status.replaceAll("_"," ")}</span></div>
        </article>;})}
      </div>}
    </section>}

    {activeTab==="sold"&&<section className="panel" role="tabpanel" aria-label="Sold Gold">
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",gap:12,flexWrap:"wrap"}}>
        <div><div className="eyebrow"><ShoppingBag size={14}/> Sales and customer history</div><h2 style={{marginTop:8}}>Sold Gold</h2>
          <p className="small muted">Based on issued invoices. Tracked catalogue items include stock codes/HUID and update stock automatically when the invoice is issued; older/free-text invoice lines remain visible but are not linked to an individual stock serial.</p></div>
        <button className="btn btn-secondary" type="button" onClick={()=>{setSoldLoaded(false);void loadSold();}} disabled={soldLoading}><RefreshCw size={15}/> Refresh</button>
      </div>
      {soldError&&<div role="alert" className="notice" style={{marginTop:12,marginBottom:12}}>{soldError}</div>}
      <div className="dashboard-grid">
        <div className="metric-card"><span className="small muted">Invoice lines</span><div className="metric-value">{soldRows.length.toLocaleString("en-IN")}</div><div className="small muted">Issued / paid invoices</div></div>
        <div className="metric-card"><span className="small muted">Net sold metal</span><div className="metric-value">{grams(soldRows.reduce((sum,row)=>sum+Math.max(0,row.netWeight-row.returnedNetWeight),0))} g</div><div className="small muted">Less quantities in issued credit notes</div></div>
        <div className="metric-card"><span className="small muted">Net sold amount</span><div className="metric-value">{money(soldRows.reduce((sum,row)=>sum+row.netAmount,0))}</div><div className="small muted">Original invoice line value minus issued credit notes</div></div>
      </div>
      <div style={{display:"flex",gap:10,flexWrap:"wrap",marginBottom:14}}>
        <div className="field" style={{flex:"1 1 240px"}}><label htmlFor="sold-search"><Search size={13} style={{display:"inline",verticalAlign:"middle"}}/> Search sold gold</label><input id="sold-search" value={search} onChange={e=>setSearch(e.target.value)} placeholder="Customer name, mobile, invoice, item or HUID"/></div>
        <div className="field" style={{width:"min(100%,230px)"}}><label htmlFor="sold-status">Invoice status</label><select id="sold-status" value={invoiceStatus} onChange={e=>setInvoiceStatus(e.target.value)}><option value="all">All issued invoices</option><option value="issued">Issued</option><option value="partially_paid">Partially paid</option><option value="paid">Paid</option><option value="credited">Credited</option></select></div>
        <div style={{alignSelf:"end"}}><button className="btn btn-primary" type="button" onClick={exportSold} disabled={filteredSold.length===0}><Download size={15}/> Export CSV</button></div>
      </div>
      {soldLoading?<div className="small muted">Loading sales and customer history…</div>:!soldRows.length?<div className="notice">No sold-gold invoice lines found for this shop yet. Issue a POS invoice to start the register.</div>:!filteredSold.length?<p className="small muted">No sales match the current search/status filter.</p>:<div style={{display:"grid",gap:12}}>
        {filteredSold.map(row=><article key={row.id} style={{border:"1px solid var(--line)",borderRadius:14,padding:14,minWidth:0}}>
          <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",gap:12,flexWrap:"wrap"}}>
            <div style={{minWidth:0}}><strong>{row.customerName}</strong><div className="small muted">{row.customerCode?row.customerCode+" · ":""}{row.mobile||"No mobile on invoice"}</div><div style={{marginTop:7}}>{row.description}</div><div className="small muted" style={{marginTop:4}}>Invoice {row.invoiceNumber} · {row.invoiceDate?new Date(row.invoiceDate+"T00:00:00").toLocaleDateString("en-IN"):"—"}</div></div>
            <div style={{textAlign:"right"}}><span className={"pill "+(row.remainingQuantity<=0?"pill-demo":"pill-green")}>{row.remainingQuantity<=0?"Returned":row.returnedQuantity>0?"Partially returned":row.invoiceStatus.replaceAll("_"," ")}</span><div style={{fontSize:21,fontWeight:800,marginTop:8}}>{money(row.netAmount)}</div><div className="small muted">net after issued credits</div></div>
          </div>
          <div className="form-grid" style={{marginTop:13}}>
            <div><span className="small muted">Purity / rate</span><div><strong>{row.purity}</strong> · {row.rate===null?"Rate not recorded":money(row.rate)+"/g"}</div></div>
            <div><span className="small muted">Stock tracking</span><div><strong>{row.tracking}</strong>{row.itemCode?" · "+row.itemCode:""}</div><div className="small muted">HUID: {row.huid||"—"}</div></div>
            <div><span className="small muted">Net metal</span><div><strong>{grams(Math.max(0,row.netWeight-row.returnedNetWeight))} g</strong><div className="small muted">Sold {grams(row.netWeight)} g · returned {grams(row.returnedNetWeight)} g</div></div></div>
            <div><span className="small muted">Invoice amount</span><div><strong>{money(row.originalAmount)}</strong><div className="small muted">Credit notes: {money(row.creditedAmount)}</div></div></div>
          </div>
        </article>)}
      </div>}
    </section>}
  </>;
}
