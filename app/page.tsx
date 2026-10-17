import Link from "next/link";
import { ArrowRight, Calculator, CheckCircle2, Coins, MapPin, ShieldCheck, Smartphone, WalletCards } from "lucide-react";

const sampleRates = [
  { purity: "24K · 999", rate: "₹14,712", note: "per gram" },
  { purity: "22K · 916", rate: "₹13,535", note: "per gram" },
  { purity: "18K · 750", rate: "₹11,034", note: "per gram" }
];
const features = [
  { icon: MapPin, title: "Local rate management", body: "Configure rates for the shop, city and branch. Every saved rate should carry its source, timestamp and status." },
  { icon: Calculator, title: "Transparent calculator", body: "Explain metal value, making charges, wastage, discount and tax before a quotation is shared." },
  { icon: ShieldCheck, title: "Tenant-first foundation", body: "A shared database is structured around tenant memberships and row-level access controls—not frontend filters." }
];

export default function HomePage() {
  return <main><div className="page-wrap">
    <section className="hero">
      <div className="hero-copy">
        <div className="eyebrow"><span className="eyebrow-dot" /> Jewellery business, thoughtfully connected</div>
        <h1>Every detail of your shop. <span>In one clear view.</span></h1>
        <p className="lead">A modern workspace for jewellery retailers to manage local gold rates, customer relationships and savings operations—with clarity at every step.</p>
        <div className="action-row">
          <Link href="/login" className="btn btn-primary">Open your workspace <ArrowRight size={16} /></Link>
          <Link href="/calculator" className="btn btn-secondary"><Calculator size={16} /> Try the calculator</Link>
        </div>
        <p className="small muted" style={{ marginTop: 18 }}>Built for independent jewellery shops across India, starting with Tamil Nadu.</p>
      </div>
      <aside className="preview-panel" aria-label="Example gold-rate preview">
        <div className="preview-top">
          <div><div className="eyebrow"><MapPin size={13} /> Local rate board</div><h2 style={{ marginTop: 10, marginBottom: 4 }}>Hosur, Tamil Nadu</h2><p className="small muted" style={{ marginBottom: 0 }}>Example layout · not a live rate feed</p></div>
          <span className="pill pill-demo">SAMPLE</span>
        </div>
        <div className="rate-grid">{sampleRates.map((item) => <div className="rate-card" key={item.purity}><span className="purity">{item.purity}</span><strong>{item.rate}</strong><small>{item.note}</small></div>)}</div>
        <div className="notice" style={{ marginTop: 14 }}><Coins size={16} style={{ flexShrink: 0, marginTop: 1 }} /><span>These fixed values are demonstration data only. Production rates must come from a verified provider or be entered and confirmed by an authorised shop user.</span></div>
      </aside>
    </section>
    <section>
      <div className="section-head"><div><div className="eyebrow">A clear foundation</div><h2 style={{ marginTop: 10 }}>Built around real shop workflows</h2></div><p className="small muted">A phased build, with security and financial correctness first.</p></div>
      <div className="feature-grid">{features.map((item) => { const Icon = item.icon; return <article className="feature-card" key={item.title}><div className="feature-icon"><Icon size={20} /></div><h3>{item.title}</h3><p>{item.body}</p></article>; })}</div>
    </section>
    <section className="dashboard-grid" aria-label="Product capabilities">
      <div className="metric-card"><WalletCards size={19} color="#1f5c3e" /><div className="metric-value">Schemes</div><p className="small muted" style={{ marginBottom: 0 }}>Versioned terms and a traceable transaction ledger are part of the database foundation.</p></div>
      <div className="metric-card"><Smartphone size={19} color="#1f5c3e" /><div className="metric-value">Mobile-ready</div><p className="small muted" style={{ marginBottom: 0 }}>Responsive layouts for the devices shop staff and customers use every day.</p></div>
      <div className="metric-card"><CheckCircle2 size={19} color="#1f5c3e" /><div className="metric-value">Clear status</div><p className="small muted" style={{ marginBottom: 0 }}>Unconfigured live integrations are disclosed instead of showing fake success.</p></div>
    </section>
    <div style={{ display: "flex", justifyContent: "center", marginTop: 20 }}><Link href="/dashboard" className="link-text">Go to authenticated dashboard <ArrowRight size={14} style={{ display: "inline", verticalAlign: "middle" }} /></Link></div>
  </div></main>;
}
