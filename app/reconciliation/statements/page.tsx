"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";

type Membership = { tenant_id: string; role: string; is_active: boolean; tenants?: { display_name?: string; slug?: string } | null };
type Reconciliation = {
  id: string; provider: string; period_start: string; period_end: string; branch_id: string | null;
  expected_amount: number; actual_amount: number | null; difference_amount: number | null; status: string;
};
type StatementLine = {
  id: string; transaction_date: string; provider_reference: string; description: string | null;
  statement_amount: number; currency: string; line_status: string; matched_ledger_amount: number | null;
  difference_amount: number | null; created_at: string;
};
type CsvLine = { transaction_date: string; provider_reference: string; amount: number; currency: string; description: string };
type RpcResult = { inserted?: number; duplicateLinesSkipped?: number; statementTotal?: number; difference?: number };

function csvGrid(input: string): string[][] {
  const rows: string[][] = [[]];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < input.length; i++) {
    const char = input[i];
    if (quoted) {
      if (char === '"' && input[i + 1] === '"') { cell += '"'; i++; }
      else if (char === '"') quoted = false;
      else cell += char;
    } else if (char === '"' && cell.length === 0) quoted = true;
    else if (char === ",") { rows[rows.length - 1].push(cell); cell = ""; }
    else if (char === "\n") { rows[rows.length - 1].push(cell.replace(/\r$/, "")); cell = ""; rows.push([]); }
    else cell += char;
  }
  rows[rows.length - 1].push(cell.replace(/\r$/, ""));
  return rows.filter((row, i) => !(i === rows.length - 1 && row.length === 1 && row[0].trim() === ""));
}

function parseStatementCsv(input: string): CsvLine[] {
  const rows = csvGrid(input);
  if (rows.length < 2) throw new Error("CSV must contain a header and at least one statement row.");
  const headers = rows[0].map(value => value.replace(/^\uFEFF/, "").trim().toLowerCase().replace(/[\s-]+/g, "_"));
  const column = (...names: string[]) => headers.findIndex(x => names.includes(x));
  const dateIndex = column("transaction_date", "date", "value_date");
  const referenceIndex = column("provider_reference", "payment_id", "reference", "transaction_id", "utr");
  const amountIndex = column("amount", "statement_amount", "transaction_amount");
  const currencyIndex = column("currency");
  const descriptionIndex = column("description", "remarks", "narration");
  if (dateIndex < 0 || referenceIndex < 0 || amountIndex < 0) {
    throw new Error("CSV needs transaction_date, provider_reference and amount columns. currency and description are optional.");
  }
  if (rows.length - 1 > 1000) throw new Error("Import no more than 1,000 rows in a single batch.");
  return rows.slice(1).map((row, index) => {
    const at = index + 2;
    const transactionDate = (row[dateIndex] ?? "").trim();
    const reference = (row[referenceIndex] ?? "").trim();
    const amountText = (row[amountIndex] ?? "").replace(/[₹,\s]/g, "");
    const amount = Number(amountText);
    const currency = currencyIndex < 0 ? "INR" : ((row[currencyIndex] ?? "INR").trim().toUpperCase() || "INR");
    const description = descriptionIndex < 0 ? "" : (row[descriptionIndex] ?? "").trim().slice(0, 500);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(transactionDate) || Number.isNaN(Date.parse(transactionDate))) {
      throw new Error("Row " + at + ": transaction_date must use YYYY-MM-DD format.");
    }
    if (!reference || reference.length > 200) throw new Error("Row " + at + ": provider_reference is required and must be at most 200 characters.");
    if (!amountText || !Number.isFinite(amount) || Math.abs(amount) > 999999999999.99) throw new Error("Row " + at + ": amount must be a valid numeric value.");
    if (!/^[A-Z]{3}$/.test(currency)) throw new Error("Row " + at + ": currency must be a three-letter code.");
    return { transaction_date: transactionDate, provider_reference: reference, amount: Math.round((amount + Number.EPSILON) * 100) / 100, currency, description };
  });
}

const money = (value: number | null | undefined, currency = "INR") => {
  const amount = Number(value ?? 0);
  try {
    return new Intl.NumberFormat("en-IN", { style: "currency", currency, minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(amount);
  } catch {
    return currency + " " + amount.toFixed(2);
  }
};

export default function StatementReconciliationPage() {
  const [memberships, setMemberships] = useState<Membership[]>([]);
  const [tenantId, setTenantId] = useState("");
  const [role, setRole] = useState("");
  const [records, setRecords] = useState<Reconciliation[]>([]);
  const [reconciliationId, setReconciliationId] = useState("");
  const [lines, setLines] = useState<StatementLine[]>([]);
  const [preview, setPreview] = useState<CsvLine[]>([]);
  const [fileName, setFileName] = useState("");
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const activeRecord = useMemo(() => records.find(r => r.id === reconciliationId) ?? null, [records, reconciliationId]);
  const mayImport = ["owner", "manager", "accountant"].includes(role);
  const lineCounts = useMemo(() => {
    const out: Record<string, number> = { matched: 0, amount_mismatch: 0, unmatched: 0, duplicate_reference: 0, ambiguous_match: 0 };
    for (const line of lines) out[line.line_status] = (out[line.line_status] ?? 0) + 1;
    return out;
  }, [lines]);

  const loadRecords = useCallback(async (shopId: string, preferId?: string) => {
    if (!shopId) { setRecords([]); setReconciliationId(""); setLines([]); return; }
    const { data, error: queryError } = await createClient().from("reconciliation_records")
      .select("id,provider,period_start,period_end,branch_id,expected_amount,actual_amount,difference_amount,status")
      .eq("tenant_id", shopId).order("period_start", { ascending: false }).limit(500);
    if (queryError) throw queryError;
    const result = (data ?? []) as Reconciliation[];
    setRecords(result);
    const next = preferId && result.some(r => r.id === preferId) ? preferId : result[0]?.id ?? "";
    setReconciliationId(next);
    if (next) await loadLines(shopId, next); else setLines([]);
  }, []);

  const loadLines = useCallback(async (shopId: string, reconId: string) => {
    if (!shopId || !reconId) { setLines([]); return; }
    const { data, error: queryError } = await createClient().from("reconciliation_statement_lines")
      .select("id,transaction_date,provider_reference,description,statement_amount,currency,line_status,matched_ledger_amount,difference_amount,created_at")
      .eq("tenant_id", shopId).eq("reconciliation_id", reconId)
      .order("transaction_date", { ascending: false }).limit(5000);
    if (queryError) throw queryError;
    setLines((data ?? []) as StatementLine[]);
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true); setError("");
      try {
        const db = createClient();
        const { data: { user }, error: authError } = await db.auth.getUser();
        if (authError || !user) throw new Error("Sign in to import or review reconciliation statements.");
        const { data, error: membershipError } = await db.from("tenant_memberships")
          .select("tenant_id,role,is_active,tenants(display_name,slug)")
          .eq("user_id", user.id).eq("is_active", true).order("created_at", { ascending: true });
        if (membershipError) throw membershipError;
        const allowed = ((data ?? []) as Membership[]).filter(m => ["owner", "manager", "accountant"].includes(m.role));
        if (!cancelled) {
          setMemberships(allowed);
          if (allowed.length) { setTenantId(allowed[0].tenant_id); setRole(allowed[0].role); }
          else setError("You need an owner, manager or accountant role to import statements.");
        }
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : "Could not load shop access.");
      } finally { if (!cancelled) setLoading(false); }
    })();
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (!tenantId) return;
    let cancelled = false;
    (async () => {
      setLoading(true); setError("");
      try { await loadRecords(tenantId); }
      catch (e) { if (!cancelled) setError(e instanceof Error ? e.message : "Could not load reconciliation periods."); }
      finally { if (!cancelled) setLoading(false); }
    })();
    return () => { cancelled = true; };
  }, [tenantId, loadRecords]);

  useEffect(() => {
    if (!tenantId || !reconciliationId) return;
    let cancelled = false;
    (async () => {
      try { await loadLines(tenantId, reconciliationId); }
      catch (e) { if (!cancelled) setError(e instanceof Error ? e.message : "Could not load imported statement lines."); }
    })();
    return () => { cancelled = true; };
  }, [tenantId, reconciliationId, loadLines]);

  async function onFile(file?: File) {
    if (!file) return;
    setError(""); setNotice(""); setPreview([]); setFileName("");
    if (file.size > 2_000_000) { setError("CSV file is larger than 2 MB. Split it into batches of up to 1,000 rows."); return; }
    try {
      const parsed = parseStatementCsv(await file.text());
      if (activeRecord && parsed.some(line => line.transaction_date < activeRecord.period_start || line.transaction_date > activeRecord.period_end)) {
        throw new Error("Every row date must fall between " + activeRecord.period_start + " and " + activeRecord.period_end + " for the selected reconciliation.");
      }
      setPreview(parsed); setFileName(file.name);
      setNotice(parsed.length + " rows validated. No ledger entries have been changed.");
    } catch (e) { setError(e instanceof Error ? e.message : "CSV could not be read."); }
  }

  async function importPreview() {
    if (!tenantId || !activeRecord || !preview.length || !mayImport) return;
    setBusy(true); setError(""); setNotice("");
    try {
      const { data, error: rpcError } = await createClient().rpc("import_reconciliation_statement_lines", {
        p_tenant_id: tenantId, p_reconciliation_id: activeRecord.id, p_lines: preview
      });
      if (rpcError) throw rpcError;
      const result = (data ?? {}) as RpcResult;
      setPreview([]);
      setFileName("");
      setNotice("Statement import complete: " + (result.inserted ?? 0) + " rows added, " +
        (result.duplicateLinesSkipped ?? 0) + " duplicate rows skipped. Statement total " +
        money(result.statementTotal) + "; remaining difference " + money(result.difference) + ".");
      await loadRecords(tenantId, activeRecord.id);
      await loadLines(tenantId, activeRecord.id);
    } catch (e) { setError(e instanceof Error ? e.message : "Statement rows could not be imported."); }
    finally { setBusy(false); }
  }

  function downloadTemplate() {
    const csv = "transaction_date,provider_reference,amount,currency,description\r\n2026-10-01,pay_example123,1000.00,INR,Example row — replace before import\r\n";
    const url = URL.createObjectURL(new Blob(["\uFEFF" + csv], { type: "text/csv;charset=utf-8" }));
    const anchor = document.createElement("a"); anchor.href = url; anchor.download = "gold-reconciliation-template.csv";
    document.body.appendChild(anchor); anchor.click(); anchor.remove(); URL.revokeObjectURL(url);
  }

  if (loading) return <main className="page-shell"><p className="muted">Loading statement reconciliation…</p></main>;

  return <main className="page-shell">
    <header className="page-header">
      <div><p className="eyebrow">Accounting · Reconciliation</p><h1>Statement import & matching</h1><p className="muted">Import a provider or bank CSV, match Razorpay payment references to confirmed ledger payments, and review differences. Imports never rewrite customer payments.</p></div>
      <div className="header-actions"><Link className="btn btn-secondary" href="/reconciliation">Back to reconciliation</Link><button type="button" className="btn btn-secondary" onClick={downloadTemplate}>Download CSV template</button></div>
    </header>

    {error && <div className="notice notice-error" role="alert">{error}</div>}
    {notice && <div className="notice" role="status">{notice}</div>}

    <section className="panel" style={{ marginBottom: 16 }}>
      <div className="field"><label htmlFor="statement-shop">Shop</label><select id="statement-shop" value={tenantId} onChange={e => {
        const id = e.target.value; setTenantId(id); setRole(memberships.find(m => m.tenant_id === id)?.role ?? "");
        setReconciliationId(""); setPreview([]); setFileName(""); setLines([]); setError(""); setNotice("");
      }}>{memberships.map(m => <option key={m.tenant_id} value={m.tenant_id}>{m.tenants?.display_name ?? m.tenants?.slug ?? m.tenant_id} · {m.role}</option>)}</select></div>
      <div className="field" style={{ marginTop: 12 }}><label htmlFor="statement-reconciliation">Reconciliation period</label><select id="statement-reconciliation" value={reconciliationId} onChange={e => { setReconciliationId(e.target.value); setPreview([]); setFileName(""); }}>{records.map(r => <option key={r.id} value={r.id}>{r.provider} · {r.period_start} to {r.period_end} · {r.status}</option>)}</select>{!records.length && <p className="small muted">Create an open reconciliation period first, then import its statement here.</p>}</div>
      {activeRecord && <div className="grid-cards" style={{ marginTop: 16 }}>
        <div className="stat-card"><span className="small muted">Expected</span><strong>{money(activeRecord.expected_amount)}</strong></div>
        <div className="stat-card"><span className="small muted">Statement total</span><strong>{money(activeRecord.actual_amount)}</strong></div>
        <div className="stat-card"><span className="small muted">Difference</span><strong>{money(activeRecord.difference_amount)}</strong></div>
      </div>}
    </section>

    {activeRecord && mayImport && <section className="panel" style={{ marginBottom: 16 }}>
      <h2>Import statement CSV</h2>
      <p className="small muted">Required: transaction_date, provider_reference and amount. Optional: currency (defaults to INR) and description. Dates must be YYYY-MM-DD inside the selected period. Up to 1,000 rows / 2 MB per import. Import is deduplicated by row contents; it marks matches but does not create, edit or refund any payment.</p>
      <div className="field"><label htmlFor="statement-csv">Statement CSV</label><input id="statement-csv" type="file" accept=".csv,text/csv" onChange={e => void onFile(e.target.files?.[0])} /></div>
      {fileName && <p className="small muted">Preview: {fileName} · {preview.length} rows</p>}
      {preview.length > 0 && <><div style={{ overflowX: "auto", marginTop: 12 }}><table className="data-table"><thead><tr><th>Date</th><th>Reference</th><th>Amount</th><th>Currency</th><th>Description</th></tr></thead><tbody>{preview.slice(0,10).map((row,i)=><tr key={i}><td>{row.transaction_date}</td><td>{row.provider_reference}</td><td>{money(row.amount,row.currency)}</td><td>{row.currency}</td><td>{row.description || "—"}</td></tr>)}</tbody></table></div>{preview.length>10&&<p className="small muted">Showing the first 10 of {preview.length} rows in preview.</p>}<button type="button" className="btn btn-primary" disabled={busy} onClick={()=>void importPreview()}>{busy?"Importing…":"Import and match statement"}</button></>}
    </section>}

    {activeRecord && <section className="panel">
      <div className="section-heading"><div><h2>Imported statement lines</h2><p className="small muted">Matching compares a confirmed Razorpay payment reference, currency and amount. Unmatched lines may be settlement transfers, bank fees, manual transactions or references that need review.</p></div><button type="button" className="btn btn-secondary" disabled={busy} onClick={()=>void loadLines(tenantId,activeRecord.id)}>Refresh</button></div>
      <div className="grid-cards" style={{ marginTop: 12 }}>
        <div className="stat-card"><span className="small muted">Matched</span><strong>{lineCounts.matched}</strong></div>
        <div className="stat-card"><span className="small muted">Amount mismatch</span><strong>{lineCounts.amount_mismatch}</strong></div>
        <div className="stat-card"><span className="small muted">Unmatched</span><strong>{lineCounts.unmatched}</strong></div>
        <div className="stat-card"><span className="small muted">Duplicate refs / rows</span><strong>{lineCounts.duplicate_reference}</strong></div>
        <div className="stat-card"><span className="small muted">Ambiguous</span><strong>{lineCounts.ambiguous_match}</strong></div>
      </div>
      {lines.length===0?<p className="muted" style={{marginTop:16}}>No statement lines imported yet.</p>:<div style={{overflowX:"auto",marginTop:16}}><table className="data-table"><thead><tr><th>Date</th><th>Provider reference</th><th>Statement amount</th><th>Ledger amount</th><th>Difference</th><th>Match result</th><th>Description</th></tr></thead><tbody>{lines.map(line=><tr key={line.id}><td>{line.transaction_date}</td><td>{line.provider_reference}</td><td>{money(line.statement_amount,line.currency)}</td><td>{line.matched_ledger_amount===null?"—":money(line.matched_ledger_amount,line.currency)}</td><td>{line.difference_amount===null?"—":money(line.difference_amount,line.currency)}</td><td><span className={"status-pill status-"+line.line_status}>{line.line_status.replaceAll("_"," ")}</span></td><td>{line.description||"—"}</td></tr>)}</tbody></table></div>}
    </section>}
  </main>;
}
