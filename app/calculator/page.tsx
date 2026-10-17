import Link from "next/link";
import { ArrowLeft, Calculator } from "lucide-react";
import GoldCalculator from "./calculator";

export default function CalculatorPage() {
  return <main><div className="page-wrap">
    <Link className="link-text small" href="/"><ArrowLeft size={13} style={{ display: "inline", verticalAlign: "middle" }} /> Back to overview</Link>
    <div style={{ marginTop: 20, marginBottom: 24 }}>
      <div className="eyebrow"><Calculator size={14} /> Price estimation</div>
      <h1 style={{ marginTop: 12 }}>Gold calculator</h1>
      <p className="lead">Work through metal value and charges step by step. Change the sample rate to the rate confirmed by your shop before sharing a quotation.</p>
    </div>
    <GoldCalculator />
  </div></main>;
}
