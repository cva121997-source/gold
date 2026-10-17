import type { Metadata } from "next";
import Link from "next/link";
import { Calculator, CircleUserRound, Coins, LayoutDashboard, Users, WalletCards } from "lucide-react";
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
              <Link href="/schemes" className="nav-link"><WalletCards size={16} /> Schemes</Link>
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
