"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { ArrowLeft, Boxes, CircleAlert, CheckCircle2, PackageCheck, Plus, RefreshCw, ShoppingCart, Truck } from "lucide-react";
import { createClient } from "@/lib/supabase/client";

type Membership = { tenant_id: string; branch_id: string | null; role: string; tenants: { display_name: string; slug: string } | null };
type Branch = { id: string; branch_code: string; name: string };
type Supplier = { id: string; supplier_code: string; name: string; mobile: string | null; is_active: boolean };
type Product = { id: string; product_code: string; name: string; gross_weight_grams: number; net_metal_weight_grams: number; stone_weight_grams: number; purity_id: number | null; purchase_cost: number | null };
type PurchaseOrder = { id: string; tenant_id: string; branch_id: string; supplier_id: string; po_number: string; status: string; order_date: string; expected_delivery_date: string | null; subtotal: number; tax_amount: number; total_amount: number; supplier_invoice_number: string | null; notes: string | null };
type PurchaseLine = { id: string; purchase_order_id: string; line_number: number; product_id: string; product_code: string; description: string; ordered_quantity: number; received_quantity: number; gross_weight_grams: number; net_metal_weight_grams: number; stone_weight_grams: number; purity_id: number | null; unit_cost: number; tax_rate: number; line_subtotal: number; tax_amount: number; line_total: number };
type Receipt = { id: string; receipt_number: string; supplier_invoice_number: string | null; item_count: number; received_at: string; status: string };
const money = (v: number) => new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 2 }).format(Number(v) || 0);
const grams = (v: number) => Number(v || 0).toLocaleString("en-IN", { minimumFractionDigits: 3, maximumFractionDigits: 3 });
const today = () => new Date().toISOString().slice(0, 10);

export default function PurchasingPage() {
  const router = useRouter();
  const [memberships, setMemberships] = useState<Membership[]>([]);
  const [tenantId, setTenantId] = useState("");
  const [branches, setBranches] = useState<Branch[]>([]);
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [orders, setOrders] = useState<PurchaseOrder[]>([]);
  const [lines, setLines] = useState<PurchaseLine[]>([]);
  const [receipts, setReceipts] = useState<Receipt[]>([]);
  const [selectedOrderId, setSelectedOrderId] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [branchId, setBranchId] = useState("");
  const [supplierId, setSupplierId] = useState("");
  const [expectedDate, setExpectedDate] = useState("");
  const [orderNotes, setOrderNotes] = useState("");
  const [productId, setProductId] = useState("");
  const [quantity, setQuantity] = useState("1");
  const [unitCost, setUnitCost] = useState("0");
  const [taxRate, setTaxRate] = useState("0");
  const [receiveLineId, setReceiveLineId] = useState("");
  const [itemCode, setItemCode] = useState("");
  const [serialNumber, setSerialNumber] = useState("");
  const [barcode, setBarcode] = useState("");
  const [huid, setHuid] = useState("");
  const [gross, setGross] = useState("0");
  const [net, setNet] = useState("0");
  const [stone, setStone] = useState("0");
  const [receiptCost, setReceiptCost] = useState("0");
  const [supplierInvoice, setSupplierInvoice] = useState("");

  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const supabase = createClient();
        const { data: { user } } = await supabase.auth.getUser();
        if (!user) { router.replace("/login"); return; }
        const { data, error: queryError } = await supabase.from("tenant_memberships").select("tenant_id,branch_id,role,tenants(display_name,slug)").eq("user_id", user.id).eq("is_active", true);
        if (queryError) throw queryError;
        if (active) { const rows = (data ?? []) as unknown as Membership[]; setMemberships(rows); setTenantId(rows[0]?.tenant_id ?? ""); }
      } catch {
        if (active) setError("Could not load shop membership. Check the Supabase connection and migrations.");
      } finally { if (active) setLoading(false); }
    })();
    return () => { active = false; };
  }, [router]);

  const loadWorkspace = useCallback(async () => {
    if (!tenantId) { setBranches([]); setSuppliers([]); setProducts([]); setOrders([]); setLines([]); setReceipts([]); return; }
    const supabase = createClient();
    const [b, s, p, o] = await Promise.all([
      supabase.from("branches").select("id,branch_code,name").eq("tenant_id", tenantId).eq("is_active", true).order("name"),
      supabase.from("suppliers").select("id,supplier_code,name,mobile,is_active").eq("tenant_id", tenantId).eq("is_active", true).order("name").limit(500),
      supabase.from("products").select("id,product_code,name,gross_weight_grams,net_metal_weight_grams,stone_weight_grams,purity_id,purchase_cost").eq("tenant_id", tenantId).eq("is_active", true).order("name").limit(1000),
      supabase.from("purchase_orders").select("id,tenant_id,branch_id,supplier_id,po_number,status,order_date,expected_delivery_date,subtotal,tax_amount,total_amount,supplier_invoice_number,notes").eq("tenant_id", tenantId).order("order_date", { ascending: false }).limit(250)
    ]);
    if (b.error || s.error || p.error || o.error) { setError("Purchasing data could not be loaded. Verify your branch access and procurement migration."); return; }
    setBranches((b.data ?? []) as Branch[]); setSuppliers((s.data ?? []) as Supplier[]);
    setProducts((p.data ?? []) as Product[]); setOrders((o.data ?? []) as PurchaseOrder[]); setError("");
  }, [tenantId]);
  useEffect(() => { void loadWorkspace(); }, [loadWorkspace]);
  useEffect(() => {
    const m = memberships.find((x) => x.tenant_id === tenantId);
    setBranchId(m?.branch_id ?? "");
  }, [memberships, tenantId]);

  const selectedOrder = orders.find((x) => x.id === selectedOrderId) ?? null;
  const productMap = useMemo(() => new Map(products.map((x) => [x.id, x])), [products]);
  const selectedReceiveLine = lines.find((x) => x.id === receiveLineId && x.received_quantity < x.ordered_quantity) ?? null;
  const remainingLines = lines.filter((x) => x.received_quantity < x.ordered_quantity);
  const member = memberships.find((x) => x.tenant_id === tenantId);
  const canEdit = ["owner", "manager", "accountant", "inventory_manager"].includes(member?.role ?? "");
  const canReceive = ["owner", "manager", "inventory_manager"].includes(member?.role ?? "");

  async function openOrder(id: string) {
    setError(""); setNotice(""); setSelectedOrderId(id);
    const supabase = createClient();
    const [l, r] = await Promise.all([
      supabase.from("purchase_order_lines").select("id,purchase_order_id,line_number,product_id,product_code,description,ordered_quantity,received_quantity,gross_weight_grams,net_metal_weight_grams,stone_weight_grams,purity_id,unit_cost,tax_rate,line_subtotal,tax_amount,line_total").eq("tenant_id", tenantId).eq("purchase_order_id", id).order("line_number"),
      supabase.from("goods_receipts").select("id,receipt_number,supplier_invoice_number,item_count,received_at,status").eq("tenant_id", tenantId).eq("purchase_order_id", id).order("received_at", { ascending: false }).limit(100)
    ]);
    if (l.error || r.error) { setError("Could not load the purchase-order lines or receipt history."); return; }
    setLines((l.data ?? []) as PurchaseLine[]); setReceipts((r.data ?? []) as Receipt[]); setReceiveLineId("");
  }

  async function createOrder(e: FormEvent<HTMLFormElement>) {
    e.preventDefault(); setError(""); setNotice("");
    if (!tenantId || !branchId || !supplierId) { setError("Choose the shop, receiving branch and supplier."); return; }
    setBusy(true);
    try {
      const poNumber = "PO-" + today().replaceAll("-", "") + "-" + crypto.randomUUID().slice(0, 6).toUpperCase();
      const { data, error: e2 } = await createClient().from("purchase_orders").insert({
        tenant_id: tenantId, branch_id: branchId, supplier_id: supplierId, po_number: poNumber,
        status: "draft", order_date: today(), expected_delivery_date: expectedDate || null, notes: orderNotes.trim() || null
      }).select("id").single();
      if (e2 || !data) throw e2 ?? new Error("No purchase order ID");
      setOrderNotes(""); setExpectedDate(""); await loadWorkspace(); await openOrder(data.id);
      setNotice("Draft purchase order " + poNumber + " created. Add product lines and submit it before receiving stock.");
    } catch { setError("Could not create the order. Check that the branch and supplier belong to this shop and your role can manage purchasing."); }
    finally { setBusy(false); }
  }

  async function addLine(e: FormEvent<HTMLFormElement>) {
    e.preventDefault(); setError(""); setNotice("");
    if (!selectedOrder || selectedOrder.status !== "draft") { setError("Only draft purchase orders can be edited."); return; }
    const product = productMap.get(productId), qty = Number(quantity), cost = Number(unitCost), tax = Number(taxRate);
    if (!product || !Number.isInteger(qty) || qty < 1 || !Number.isFinite(cost) || cost < 0 || !Number.isFinite(tax) || tax < 0 || tax > 100) {
      setError("Choose a product and enter a whole-piece quantity, non-negative cost and tax between 0 and 100."); return;
    }
    setBusy(true);
    try {
      const { error: e2 } = await createClient().from("purchase_order_lines").insert({
        tenant_id: tenantId, purchase_order_id: selectedOrder.id, line_number: lines.length + 1,
        product_id: product.id, product_code: product.product_code, description: product.name, ordered_quantity: qty,
        received_quantity: 0, gross_weight_grams: Number(product.gross_weight_grams), net_metal_weight_grams: Number(product.net_metal_weight_grams),
        stone_weight_grams: Number(product.stone_weight_grams), purity_id: product.purity_id, unit_cost: cost, tax_rate: tax
      });
      if (e2) throw e2;
      setProductId(""); setQuantity("1"); setUnitCost("0"); setTaxRate("0");
      await openOrder(selectedOrder.id); setNotice("Line added. Stock changes only after an actual goods receipt.");
    } catch { setError("Line not saved. Ensure weights are valid and the order is still a draft."); }
    finally { setBusy(false); }
  }

  async function submitOrder() {
    if (!selectedOrder) return;
    setError(""); setNotice(""); setBusy(true);
    try {
      const { data, error: e2 } = await createClient().rpc("submit_purchase_order", { p_tenant_id: tenantId, p_order_id: selectedOrder.id });
      if (e2) throw e2;
      const total = Number((data as { total_amount?: number } | null)?.total_amount ?? selectedOrder.total_amount);
      await loadWorkspace(); await openOrder(selectedOrder.id);
      setNotice("Purchase order submitted. Recorded total: " + money(total) + ".");
    } catch { setError("Could not submit. Only authorised staff can submit a draft containing at least one valid line."); }
    finally { setBusy(false); }
  }

  useEffect(() => {
    if (!selectedReceiveLine) return;
    const p = productMap.get(selectedReceiveLine.product_id);
    setGross(String(Number(selectedReceiveLine.gross_weight_grams || p?.gross_weight_grams || 0)));
    setNet(String(Number(selectedReceiveLine.net_metal_weight_grams || p?.net_metal_weight_grams || 0)));
    setStone(String(Number(selectedReceiveLine.stone_weight_grams || p?.stone_weight_grams || 0)));
    setReceiptCost(String(Number(selectedReceiveLine.unit_cost || 0)));
    setItemCode(selectedReceiveLine.product_code + "-" + String(Date.now()).slice(-6));
    setBarcode(""); setHuid(""); setSerialNumber("");
  }, [receiveLineId, lines, productMap]);

  async function receiveItem(e: FormEvent<HTMLFormElement>) {
    e.preventDefault(); setError(""); setNotice("");
    if (!selectedOrder || !selectedReceiveLine) { setError("Choose an order line with outstanding pieces."); return; }
    const g = Number(gross), n = Number(net), s = Number(stone), cost = Number(receiptCost);
    if (!itemCode.trim() || !Number.isFinite(g) || g <= 0 || !Number.isFinite(n) || n < 0 || !Number.isFinite(s) || s < 0 || n + s > g + 0.001 || !Number.isFinite(cost) || cost < 0) {
      setError("Enter a unique item code, valid weights, and non-negative cost."); return;
    }
    setBusy(true);
    try {
      const { error: e2 } = await createClient().rpc("receive_purchase_order", {
        p_tenant_id: tenantId, p_order_id: selectedOrder.id, p_supplier_invoice_number: supplierInvoice.trim() || null,
        p_idempotency_key: "goods-receipt-" + crypto.randomUUID(),
        p_items: [{
          purchase_order_line_id: selectedReceiveLine.id, item_code: itemCode.trim(), serial_number: serialNumber.trim() || null,
          barcode: barcode.trim() || null, huid: huid.trim() || null, gross_weight_grams: g,
          net_metal_weight_grams: n, stone_weight_grams: s, purchase_cost: cost
        }]
      });
      if (e2) throw e2;
      await loadWorkspace(); await openOrder(selectedOrder.id);
      setNotice("Piece received: inventory, per-piece traceability, movement, receipt, ordered quantity and audit event were updated together.");
    } catch { setError("Receipt failed. Check unique item/barcode/HUID values, remaining ordered quantity, weights, role and order status. The transaction rolls back on validation errors."); }
    finally { setBusy(false); }
  }

  const selectedSupplierName = suppliers.find((x) => x.id === selectedOrder?.supplier_id)?.name ?? "Supplier";
  return <main><div className="page-wrap">
    <Link href="/dashboard" className="link-text small"><ArrowLeft size={13} style={{ display: "inline", verticalAlign: "middle" }} /> Back to workspace</Link>
    <div style={{ marginTop: 20, marginBottom: 24 }}><div className="eyebrow"><ShoppingCart size={14} /> Procurement & receiving</div><h1 style={{ marginTop: 12 }}>Purchasing</h1><p className="lead">Manage supplier orders, partial deliveries and individually tracked jewellery pieces. Submitting an order does not add stock; only a validated goods receipt changes inventory.</p></div>
    {error && <div role="alert" className="notice" style={{ marginBottom: 14 }}><CircleAlert size={16} /> {error}</div>}
    {notice && <div role="status" className="notice" style={{ marginBottom: 14, background: "#edf7ef", borderColor: "#cfe4d4", color: "#1f5c3e" }}><CheckCircle2 size={16} /> {notice}</div>}
    {loading ? <section className="panel">Loading purchasing workspace…</section> : memberships.length === 0 ? <section className="panel"><h2>No shop linked</h2><p className="muted">Set up a shop or ask its owner to invite you.</p><Link className="btn btn-primary" href="/onboarding">Set up your shop</Link></section> : <>
      {memberships.length > 1 && <div className="field" style={{ maxWidth: 460, marginBottom: 16 }}><label htmlFor="purchasing-shop">Shop</label><select id="purchasing-shop" value={tenantId} onChange={(e) => { setTenantId(e.target.value); setSelectedOrderId(""); setLines([]); setReceipts([]); }}><option value="">Select shop</option>{memberships.map((m) => <option key={m.tenant_id} value={m.tenant_id}>{m.tenants?.display_name ?? m.tenant_id}</option>)}</select></div>}
      <div className="calc-layout">
        <section className="panel"><div className="section-head" style={{ marginTop: 0 }}><div><div className="eyebrow">Supplier workflow</div><h2 style={{ marginTop: 8 }}>New purchase order</h2></div><Truck size={22} /></div>
          {!canEdit ? <div className="notice">Your role cannot create supplier orders.</div> : suppliers.length === 0 ? <div className="notice">Add and activate a supplier in the Suppliers area before creating a purchase order.</div> : <form onSubmit={createOrder}><div className="form-grid">
            <div className="field"><label htmlFor="po-branch">Receiving branch *</label><select id="po-branch" required value={branchId} onChange={(e) => setBranchId(e.target.value)}><option value="">Choose branch</option>{branches.map((b) => <option key={b.id} value={b.id}>{b.name} · {b.branch_code}</option>)}</select></div>
            <div className="field"><label htmlFor="po-supplier">Supplier *</label><select id="po-supplier" required value={supplierId} onChange={(e) => setSupplierId(e.target.value)}><option value="">Choose supplier</option>{suppliers.map((s) => <option key={s.id} value={s.id}>{s.name} · {s.supplier_code}</option>)}</select></div>
            <div className="field"><label htmlFor="po-expected">Expected delivery</label><input id="po-expected" type="date" min={today()} value={expectedDate} onChange={(e) => setExpectedDate(e.target.value)} /></div>
            <div className="field"><label htmlFor="po-notes">Order notes</label><input id="po-notes" value={orderNotes} onChange={(e) => setOrderNotes(e.target.value)} maxLength={500} placeholder="Design, purity, delivery notes" /></div>
          </div><button className="btn btn-primary" type="submit" disabled={busy || !tenantId || !branchId || !supplierId} style={{ marginTop: 16, width: "100%" }}><Plus size={15} /> Create draft order</button></form>}
          <div className="notice" style={{ marginTop: 16 }}><Boxes size={15} style={{ flexShrink: 0 }} /><span>Purchase orders and supplier data are shop-scoped by RLS. Inventory only changes on a validated receipt.</span></div>
        </section>
        <section className="panel"><div className="section-head" style={{ marginTop: 0 }}><div><div className="eyebrow">Order register</div><h2 style={{ marginTop: 8 }}>Recent purchase orders</h2></div><button type="button" className="btn btn-secondary" onClick={() => void loadWorkspace()}><RefreshCw size={14} /> Refresh</button></div>
          {orders.length === 0 ? <p className="small muted">No purchase orders recorded for this shop yet.</p> : <div style={{ display: "grid", gap: 9 }}>{orders.map((order) => <button key={order.id} type="button" className="list-card" onClick={() => void openOrder(order.id)} style={{ display: "flex", textAlign: "left", width: "100%", cursor: "pointer", background: selectedOrderId === order.id ? "#f1f6f1" : undefined, borderColor: selectedOrderId === order.id ? "#b7d4be" : undefined, color: "inherit" }}>
            <div style={{ minWidth: 0, flex: 1 }}><strong>{order.po_number}</strong><div className="small muted" style={{ marginTop: 4 }}>{suppliers.find((s) => s.id === order.supplier_id)?.name ?? "Supplier"} · {new Date(order.order_date).toLocaleDateString("en-IN")}</div><div className="small muted" style={{ marginTop: 4 }}>Expected: {order.expected_delivery_date ? new Date(order.expected_delivery_date + "T00:00:00").toLocaleDateString("en-IN") : "Not set"} · {money(Number(order.total_amount))}</div></div>
            <span className={"pill " + (order.status === "received" ? "pill-green" : order.status === "draft" ? "pill-demo" : "pill-blue")}>{order.status.replaceAll("_", " ")}</span></button>)}</div>}
        </section>
      </div>
      {selectedOrder && <section className="panel" style={{ marginTop: 18 }}>
        <div className="section-head" style={{ marginTop: 0, alignItems: "flex-start" }}><div><div className="eyebrow">Purchase order detail</div><h2 style={{ marginTop: 8 }}>{selectedOrder.po_number}</h2><p className="small muted" style={{ marginBottom: 0 }}>{selectedSupplierName} · Branch: {branches.find((b) => b.id === selectedOrder.branch_id)?.name ?? "Assigned branch"} · {new Date(selectedOrder.order_date).toLocaleDateString("en-IN")}</p></div><div style={{ textAlign: "right" }}><strong>{money(Number(selectedOrder.total_amount))}</strong><div className="small muted">Total incl. configured tax</div><span className="pill pill-demo" style={{ display: "inline-flex", marginTop: 7 }}>{selectedOrder.status.replaceAll("_", " ")}</span></div></div>
        {selectedOrder.notes && <p className="small muted">{selectedOrder.notes}</p>}
        {selectedOrder.status === "draft" && canEdit && <form onSubmit={addLine} style={{ marginBottom: 20 }}><h3>Add product line</h3><div className="form-grid">
          <div className="field"><label htmlFor="line-product">Catalogue product *</label><select id="line-product" required value={productId} onChange={(e) => { const id = e.target.value; setProductId(id); setUnitCost(String(Number(productMap.get(id)?.purchase_cost ?? 0))); }}><option value="">Choose product</option>{products.map((p) => <option key={p.id} value={p.id}>{p.product_code} · {p.name}</option>)}</select></div>
          <div className="field"><label htmlFor="line-quantity">Quantity (pieces) *</label><input id="line-quantity" type="number" min="1" step="1" required value={quantity} onChange={(e) => setQuantity(e.target.value)} /></div>
          <div className="field"><label htmlFor="line-cost">Unit purchase cost (₹) *</label><input id="line-cost" type="number" min="0" step="0.01" required value={unitCost} onChange={(e) => setUnitCost(e.target.value)} /></div>
          <div className="field"><label htmlFor="line-tax">Input tax rate (%)</label><input id="line-tax" type="number" min="0" max="100" step="0.001" value={taxRate} onChange={(e) => setTaxRate(e.target.value)} /></div>
        </div><button className="btn btn-secondary" type="submit" disabled={busy || !productId} style={{ marginTop: 12 }}><Plus size={14} /> Add line</button></form>}
        <div style={{ overflowX: "auto" }}><table style={{ width: "100%", borderCollapse: "collapse", minWidth: 650 }}><thead><tr>{["Product","Quantity","Weight (g)","Unit cost","Tax","Line total","Status"].map((h) => <th key={h} style={{ textAlign: "left", padding: 9, borderBottom: "1px solid #e2e8e2", fontSize: 12 }}>{h}</th>)}</tr></thead><tbody>
          {lines.map((line) => <tr key={line.id}><td style={{ padding: 9, borderBottom: "1px solid #edf0ed" }}><strong>{line.description}</strong><div className="small muted">{line.product_code}</div></td><td style={{ padding: 9, borderBottom: "1px solid #edf0ed" }}>{line.received_quantity} / {line.ordered_quantity}</td><td style={{ padding: 9, borderBottom: "1px solid #edf0ed" }}>{grams(Number(line.net_metal_weight_grams))} net + {grams(Number(line.stone_weight_grams))} stone</td><td style={{ padding: 9, borderBottom: "1px solid #edf0ed" }}>{money(Number(line.unit_cost))}</td><td style={{ padding: 9, borderBottom: "1px solid #edf0ed" }}>{Number(line.tax_rate)}%</td><td style={{ padding: 9, borderBottom: "1px solid #edf0ed" }}>{money(Number(line.line_total))}</td><td style={{ padding: 9, borderBottom: "1px solid #edf0ed" }}>{line.received_quantity >= line.ordered_quantity ? <span className="pill pill-green">Received</span> : <span className="pill pill-demo">Pending</span>}</td></tr>)}
          {lines.length === 0 && <tr><td colSpan={7} style={{ padding: 16 }} className="small muted">No product lines added yet.</td></tr>}
        </tbody></table></div>
        {selectedOrder.status === "draft" && canEdit && <div className="action-row" style={{ marginTop: 14 }}><button type="button" className="btn btn-primary" disabled={busy || lines.length === 0} onClick={() => void submitOrder()}><CheckCircle2 size={14} /> Submit order</button></div>}
        {["ordered", "partially_received"].includes(selectedOrder.status) && canReceive && <div style={{ borderTop: "1px solid #e7ece7", marginTop: 20, paddingTop: 18 }}><h3>Receive a physical jewellery piece</h3><p className="small muted">Each submission receives one individually tracked piece, so partial deliveries can be recorded accurately.</p>
          {remainingLines.length === 0 ? <div className="notice">All ordered pieces have been received.</div> : <form onSubmit={receiveItem}><div className="form-grid">
            <div className="field"><label htmlFor="receive-line">Outstanding order line *</label><select id="receive-line" required value={receiveLineId} onChange={(e) => setReceiveLineId(e.target.value)}><option value="">Choose outstanding item</option>{remainingLines.map((line) => <option key={line.id} value={line.id}>{line.product_code} · {line.description} ({line.received_quantity}/{line.ordered_quantity})</option>)}</select></div>
            <div className="field"><label htmlFor="receive-code">Unique stock item code *</label><input id="receive-code" required value={itemCode} onChange={(e) => setItemCode(e.target.value)} maxLength={120} /></div>
            <div className="field"><label htmlFor="receive-serial">Serial / tag number</label><input id="receive-serial" value={serialNumber} onChange={(e) => setSerialNumber(e.target.value)} maxLength={120} /></div>
            <div className="field"><label htmlFor="receive-barcode">Unique barcode / QR</label><input id="receive-barcode" value={barcode} onChange={(e) => setBarcode(e.target.value)} maxLength={120} /></div>
            <div className="field"><label htmlFor="receive-huid">HUID, when applicable</label><input id="receive-huid" value={huid} onChange={(e) => setHuid(e.target.value.toUpperCase())} maxLength={30} /></div>
            <div className="field"><label htmlFor="receive-gross">Gross weight (g) *</label><input id="receive-gross" required type="number" min="0.001" step="0.001" value={gross} onChange={(e) => setGross(e.target.value)} /></div>
            <div className="field"><label htmlFor="receive-net">Net metal weight (g) *</label><input id="receive-net" required type="number" min="0" step="0.001" value={net} onChange={(e) => setNet(e.target.value)} /></div>
            <div className="field"><label htmlFor="receive-stone">Stone weight (g) *</label><input id="receive-stone" required type="number" min="0" step="0.001" value={stone} onChange={(e) => setStone(e.target.value)} /></div>
            <div className="field"><label htmlFor="receive-cost">Actual purchase cost (₹) *</label><input id="receive-cost" required type="number" min="0" step="0.01" value={receiptCost} onChange={(e) => setReceiptCost(e.target.value)} /></div>
            <div className="field"><label htmlFor="receive-invoice">Supplier invoice reference</label><input id="receive-invoice" value={supplierInvoice} onChange={(e) => setSupplierInvoice(e.target.value)} maxLength={120} /></div>
          </div><div className="notice" style={{ marginTop: 12 }}><PackageCheck size={15} style={{ flexShrink: 0 }} /><span>Stone weight is separate from net metal weight. HUID is stored as entered by the shop; Gold does not claim official BIS verification.</span></div><button className="btn btn-primary" type="submit" disabled={busy || !receiveLineId} style={{ marginTop: 12 }}>{busy ? "Recording receipt…" : "Receive item & update stock"}</button></form>}
        </div>}
        <div style={{ marginTop: 22 }}><h3>Goods receipt history</h3>{receipts.length === 0 ? <p className="small muted">No stock receipts recorded yet.</p> : <div style={{ display: "grid", gap: 8, marginTop: 10 }}>{receipts.map((r) => <div className="list-card" key={r.id}><div><strong>{r.receipt_number}</strong><div className="small muted">{r.supplier_invoice_number ? "Supplier invoice: " + r.supplier_invoice_number + " · " : ""}{r.item_count} piece(s) · {new Date(r.received_at).toLocaleString("en-IN")}</div></div><span className="pill pill-green">{r.status}</span></div>)}</div>}</div>
      </section>}
      <div className="action-row" style={{ marginTop: 16 }}><Link className="btn btn-secondary" href="/inventory"><Boxes size={14} /> Open inventory</Link><Link className="btn btn-secondary" href="/settings"><Truck size={14} /> Shop settings</Link></div>
    </>}
  </div></main>;
}
