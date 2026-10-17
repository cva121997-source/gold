import type { Metadata } from "next";
import Link from "next/link";
import { Calculator, CircleUserRound, Coins, LayoutDashboard, Users, WalletCards, Receipt, Boxes, ClipboardList, BarChart3, UserCog, Settings, RefreshCw, ClipboardCheck, Banknote, History, PlugZap, MessageSquareText, Scale } from "lucide-react";
import "./globals.css";

export const metadata: Metadata = {
  title: "Gold — Jewellery Shop Workspace",
  description: "Gold rates, transparent jewellery calculations and shop operations in one workspace.",
  applicationName: "Gold"
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>
        <div className="app-frame">
          <header className="topbar">
            <Link href="/" className="brand-lockup" aria-label="Gold home">
              <span className="brand-mark"><Coins size={22} strokeWidth={1.8} /></span>
              <span><strong>gold</strong><small>JEWELLERY WORKSPACE</small></span>
            </Link>
            <nav className="topnav" aria-label="Main navigation">
              <Link href="/" className="nav-link"><LayoutDashboard size={16} /> Overview</Link>
              <Link href="/calculator" className="nav-link"><Calculator size={16} /> Calculator</Link>
              <Link href="/rates" className="nav-link"><Coins size={16} /> Rates</Link>
              <Link href="/customers" className="nav-link"><Users size={16} /> Customers</Link>
              <Link href="/customer-history" className="nav-link"><MessageSquareText size={16} /> CRM history</Link>
              <Link href="/schemes" className="nav-link"><WalletCards size={16} /> Schemes</Link>
              <Link href="/enrolments" className="nav-link"><ClipboardList size={16} /> Enrolments</Link>
              <Link href="/redemptions" className="nav-link"><ClipboardCheck size={16} /> Redemptions</Link>
              <Link href="/collections" className="nav-link"><Receipt size={16} /> Collections</Link>
              <Link href="/refunds" className="nav-link"><Banknote size={16} /> Refunds</Link>
              <Link href="/pos" className="nav-link"><Receipt size={16} /> POS</Link>
              <Link href="/inventory" className="nav-link"><Boxes size={16} /> Inventory</Link>
              <Link href="/orders" className="nav-link"><ClipboardList size={16} /> Orders & repairs</Link>
              <Link href="/old-gold" className="nav-link"><Coins size={16} /> Old gold</Link>
              <Link href="/reports" className="nav-link"><BarChart3 size={16} /> Reports</Link>
              <Link href="/reconciliation" className="nav-link"><Scale size={16} /> Reconciliation</Link>
              <Link href="/audit-logs" className="nav-link"><History size={16} /> Audit log</Link>
              <Link href="/integrations" className="nav-link"><PlugZap size={16} /> Integrations</Link>
              <Link href="/employees" className="nav-link"><UserCog size={16} /> Employees</Link>
              <Link href="/settings" className="nav-link"><Settings size={16} /> Settings</Link>
              <Link href="/subscription" className="nav-link"><RefreshCw size={16} /> Plan</Link>
            </nav>
            <Link href="/login" className="account-link"><CircleUserRound size={17} /> Sign in</Link>
          </header>
          {children}
          <footer className="site-footer">
            <span>Gold · Built for independent jewellery businesses</span>
            <span>Prices must be verified with your shop’s configured source.</span>
          </footer>
        </div>
      </body>
    </html>
  );
}
