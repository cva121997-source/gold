# Gold — Jewellery Shop SaaS

Gold is a multi-tenant jewellery shop management workspace for India, initially focused on Tamil Nadu. One Supabase project serves independent shops with database-enforced tenant isolation and branch-aware access.

## Current functional areas

- **Platform:** tenant onboarding and status controls, staff invitation workflows, platform-level administrative audit trail.
- **Rates & calculator:** manual effective-dated locality/branch rates, opted-in public rate board/history lookup, 24K/22K/18K calculator, configurable making modes, wastage, other charges, discounts, GST estimate and budget-to-weight.
- **CRM:** customer directory, customer portal, append-only customer notes/interactions, follow-up history and audited consent grant/withdrawal history.
- **Schemes:** draft/version/publish workflow, customer enrolment and terms acceptance, fixed-monthly instalment generation, manual collections with payment/rate snapshots, benefit evaluation and redemption review.
- **Payments:** server-side Razorpay order creation and HMAC-verified capture webhook, receipt/ledger settlement flow, and a refund request/review/approved manual payout workflow for non-gateway payments.
- **Shop operations:** POS invoice draft/issue, tax profiles, inventory/HUID fields and stock movements, old-gold valuation, orders/repairs, baseline reports and CSV exports.
- **Operations:** subscription/entitlements view, notification queue, integration credential readiness page, tenant audit search/export, and CI checks.

## Important: not yet a fully production-ready platform

The repository intentionally does not pretend that missing integrations work. The following still require implementation, credentials or verified end-to-end testing:

- No live daily gold-rate provider or scheduled refresh worker is configured; displayed sample values are examples only until a shop publishes an approved rate.
- Razorpay must be configured in test mode and checkout, replay/duplicate webhook handling and provider settlement tested. Gateway refunds, disputes and comprehensive reconciliation are still incomplete.
- Subscription checkout/renewals, full platform analytics/usage limits, end-to-end feature enforcement and all tenant lifecycle operations are not finished.
- SMS, WhatsApp and email sending adapters, approved templates, opt-out checks, worker scheduling and provider delivery callbacks are not connected.
- POS returns/credit notes, detailed purchasing/supplier lifecycle, advanced inventory controls, complete exports/statements and monitoring/backups need further work.
- Automated integration/E2E tests with multiple unrelated tenant identities and branch/role combinations are still required.

See [the implementation status checklist](docs/IMPLEMENTATION_STATUS.md) and [Razorpay setup guide](docs/PAYMENTS_RAZORPAY.md) for the precise feature state and setup constraints.

## Stack

- Next.js App Router, React, TypeScript and Tailwind CSS
- Supabase PostgreSQL, Auth, RLS and trusted database functions
- GitHub Actions validation and Vercel-compatible build

## Local development

1. Use Node.js 22 (matches CI).
2. Install dependencies with `npm install`.
3. Copy `.env.example` to `.env.local`; set the Supabase URL and browser-safe publishable/anon key.
4. Keep `SUPABASE_SERVICE_ROLE_KEY` and all provider secrets server-only. Never prefix them with `NEXT_PUBLIC_` or commit their values.
5. Run `npm run dev`.
6. Validate with `npm run typecheck`, `npm test`, `npm run lint` and `npm run build`.

## Supabase migrations and initial admin

SQL migration files are in [supabase/migrations](supabase/migrations). The migrations have been applied to the connected Gold Supabase project as part of implementation, but any other environment must apply and verify them separately. After creating the intended platform admin user in Supabase Auth, bootstrap the exact user ID through the protected platform admin table using the Supabase SQL Editor. There is no self-service platform-admin registration.

## Deployment

Use the `main` branch for production workflow. Configure required environment variables and auth redirect URLs in the hosting project, set up external provider webhooks/workers only after credentials exist, and verify the actual production URL. A successful CI build does not prove that external credentials, live payments, scheduled jobs or production deployment are configured.
