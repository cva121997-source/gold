import Link from "next/link";
import { redirect } from "next/navigation";
import { ArrowRight, Building2, CircleAlert, LogOut, ShieldCheck, Calculator, Coins, Users, WalletCards, ClipboardList, Receipt, Boxes, BarChart3, Settings2, Bell, UserCog, CreditCard, Gem, ShoppingCart, ClipboardCheck, Scale, ArrowRightLeft } from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { signOut } from "./signout";

type Membership = { tenant_id: string; role: string; tenants: { display_name: string; slug: string } | null };

export default async function DashboardPage() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/login");
  const { data, error } = await supabase.from("tenant_memberships").select("tenant_id, role, tenants(display_name, slug)").eq("user_id", user.id).eq("is_active", true);
  const memberships = (data ?? []) as unknown as Membership[];

  return <main><div className="page-wrap">
    <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 16, flexWrap: "wrap" }}>
      <div><div className="eyebrow"><span className="eyebrow-dot" /> Authenticated workspace</div><h1 style={{ marginTop: 12 }}>Your shops</h1><p className="lead">Choose a business where you have an active membership. Supabase RLS checks access again for each database request.</p></div>
      <form action={signOut}><button type="submit" className="btn btn-secondary"><LogOut size={15} /> Sign out</button></form>
    </div>
    {error && <div className="notice" style={{ marginTop: 18 }}><CircleAlert size={17} /> Membership data could not be loaded. Check that the Gold SQL migration has been applied to your Supabase project.</div>}
    <section style={{ marginTop: 24 }}>
      {memberships.length > 0 ? <div style={{ display: "grid", gap: 12 }}>{memberships.map((membership) => <article className="list-card" key={membership.tenant_id}>
        <div style={{ display: "flex", alignItems: "center", gap: 13, minWidth: 0 }}><div className="feature-icon" style={{ marginBottom: 0, flexShrink: 0 }}><Building2 size={19} /></div><div style={{ minWidth: 0 }}><strong>{membership.tenants?.display_name ?? "Jewellery shop"}</strong><div className="small muted" style={{ marginTop: 4 }}>Role: {membership.role.replaceAll("_", " ")} · Tenant ID: {membership.tenant_id.slice(0, 8)}…</div></div></div><span className="pill pill-green">Active membership</span>
      </article>)}</div> : <section className="panel" style={{ textAlign: "center", padding: "38px 22px" }}>
        <div className="feature-icon" style={{ margin: "0 auto 15px" }}><Building2 size={22} /></div><h2>No shop linked yet</h2>
        <p className="muted" style={{ maxWidth: 540, margin: "0 auto 18px", lineHeight: 1.7 }}>{error ? "The database setup needs attention before shops can be listed." : "Your account is signed in, but it is not linked to a shop yet. Tenant onboarding should create a shop and owner membership through the secure database RPC."}</p>
        <div className="action-row" style={{ justifyContent: "center", marginTop: 0 }}>
          {!error && <Link href="/onboarding" className="btn btn-primary">Set up your shop <ArrowRight size={15} /></Link>}
          <Link href="/" className="btn btn-secondary">Return to overview <ArrowRight size={15} /></Link>
        </div>
      </section>}
    </section>
    <section style={{ marginTop: 26 }}>
      <div className="section-head"><div><div className="eyebrow">Workspace</div><h2 style={{ marginTop: 10 }}>Shop operations</h2></div></div>
      <div className="feature-grid">
        {[
          { href: "/rates", icon: Coins, title: "Gold rates", detail: "Manual local rates and history" },
          { href: "/calculator", icon: Calculator, title: "Calculator", detail: "Weight, charges and tax estimate" },
          { href: "/customers", icon: Users, title: "Customers", detail: "Customer directory and profiles" },
          { href: "/schemes", icon: WalletCards, title: "Savings schemes", detail: "Drafts and versioned terms" },
          { href: "/enrolments", icon: ClipboardList, title: "Enrolments", detail: "Scheme members and due schedules" },
          { href: "/collections", icon: Receipt, title: "Collections", detail: "Manual receipts and payments" },
          { href: "/pos", icon: Receipt, title: "POS & billing", detail: "Draft and issued invoices" },
          { href: "/inventory", icon: Boxes, title: "Inventory", detail: "Stock register and movement history" },
          { href: "/purchasing", icon: ShoppingCart, title: "Purchasing", detail: "Suppliers, purchase orders and goods receipts" },
          { href: "/stocktakes", icon: ClipboardCheck, title: "Stock reconciliation", detail: "Physical stock counts and discrepancy review" },
          { href: "/inventory-controls", icon: Scale, title: "Stock alerts & valuation", detail: "Reorder thresholds and valuation audit trail" },
          { href: "/transfers", icon: ArrowRightLeft, title: "Branch transfers", detail: "Approval, dispatch, receiving and traceability" },
          { href: "/old-gold", icon: Gem, title: "Old-gold exchange", detail: "Indicative valuation and review" },
          { href: "/orders", icon: ClipboardList, title: "Orders & repairs", detail: "Customer items and job tracking" },
          { href: "/reports", icon: BarChart3, title: "Reports", detail: "Current totals and CSV exports" },
          { href: "/notifications", icon: Bell, title: "Notifications", detail: "In-app messages queue" },
          { href: "/employees", icon: UserCog, title: "Employees", detail: "Invite staff and manage access" },
          { href: "/settings", icon: Settings2, title: "Shop settings", detail: "Profile, branches and tax config" },
          { href: "/subscription", icon: CreditCard, title: "Subscription", detail: "Trial and plan details" },
          { href: "/my-account", icon: ShieldCheck, title: "Customer portal", detail: "Linked customer account view" },
          { href: "/platform-admin", icon: Building2, title: "Platform admin", detail: "Restricted SaaS tenant management" }
        ].map(({ href, icon: Icon, title, detail }) => (
          <Link href={href} key={href} className="feature-card">
            <div className="feature-icon"><Icon size={20} /></div><h3>{title}</h3><p>{detail}</p>
          </Link>
        ))}
      </div>
    </section>
    <div className="notice" style={{ marginTop: 22 }}><ShieldCheck size={17} style={{ flexShrink: 0, marginTop: 1 }} /><span>Shop creation is intentionally not exposed as a direct client-side insert. The tenant onboarding RPC creates the owner membership and default branch atomically.</span></div>
  </div></main>;
}
