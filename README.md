# Gold — Jewellery Shop SaaS

Gold is a multi-tenant jewellery-shop management SaaS for India, starting with Tamil Nadu. The target architecture uses one Supabase project for many independent shops, database-enforced tenant isolation, configurable local gold rates, customer savings schemes and operational tools.

## Current repository foundation

This initial commit establishes the application foundation and the first usable workflows. It is not a claim that every module in the full product brief is implemented yet.

- Next.js App Router, TypeScript and Tailwind CSS
- Supabase SSR client setup and environment template
- Multi-tenant schema, memberships, branch support, rate history and scheme foundations
- RLS policies for tenant-scoped records and an audited tenant-onboarding RPC
- Local manual rate management and historical rate snapshots
- Customer directory and draft savings-scheme administration foundations
- Configurable gold rate preview and calculator with transparent charge breakdown
- Mobile-friendly navigation and dashboard shell
- Development/test rate values clearly identified as examples

## Requirements

- Node.js 20.9+
- A Supabase project (the Gold project ref is configured separately in deployment secrets)
- GitHub repository: https://github.com/cva121997-source/gold
- Primary branch: `main`

## Local development

1. Install dependencies: `npm install`
2. Copy `.env.example` to `.env.local` and set the Supabase URL and publishable/anon key.
3. Apply SQL migrations in `supabase/migrations` using the Supabase CLI or SQL editor.
4. Start the app: `npm run dev`
5. Verify with `npm run lint`, `npm run typecheck` and `npm run build`.

Never put a Supabase service-role key in browser-exposed environment variables or commit secrets.

## Important implementation notes

- Gold prices must come from a verified provider or an authorised manual shop rate. No live-price provider is assumed to be configured.
- Example rates in the UI are development-only and visibly labelled as examples.
- The calculator is an estimate. Production invoices require the shop's approved tax configuration and legal review.
- Tenant isolation depends on database RLS and trusted membership relationships, not UI filtering.
- Payment, messaging and live rate integrations remain unavailable until provider credentials and callback configuration are supplied.

## Build roadmap

1. Foundation, tenancy, RLS, authentication and onboarding
2. Rates, history and calculator
3. Customers, login and versioned savings schemes
4. Collections, payment verification, receipts and messaging
5. POS, inventory, old-gold exchange, reports and operations
6. Security review, tenant-isolation tests and production deployment

See `docs/IMPLEMENTATION_STATUS.md` for the current scope and outstanding work.
