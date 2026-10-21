# Gold — Jewellery Shop SaaS

Gold is a multi-tenant jewellery shop management workspace for India, initially focused on Tamil Nadu. One Supabase project serves independent shops with database-enforced tenant isolation and branch-aware access.

## Current functional areas

- **Platform:** tenant onboarding and status controls, staff invitation workflows, platform-level administrative audit trail, plan-price/entitlement editor and Razorpay subscription checkout/cancellation workflow.
- **Rates & calculator:** manual effective-dated locality/branch rates, validated provider-feed importer, daily 09:00 IST schedule, rate import history and owner/manager review before rates can be verified or published; historical rate lookup, 24K/22K/18K calculator, making modes, wastage, other charges, discounts, GST estimate and budget-to-weight.
- **CRM:** customer directory, customer portal, append-only customer notes/interactions, follow-up history and audited consent grant/withdrawal history.
- **Schemes:** draft/version/publish workflow, customer enrolment and terms acceptance, fixed-monthly instalment generation, manual collections with payment/rate snapshots, benefit evaluation and redemption review.
- **Payments & billing:** server-side Razorpay order creation and HMAC-verified capture webhook, receipt/ledger settlement flow, free trial/free plan activation, hosted Razorpay subscription checkout, signed subscription status webhooks, period-end cancellation for paid subscriptions, refund request/review, and approved Razorpay gateway refund submission with signed refund events and safe receipt-based reconciliation. Cash/bank payout recording remains separate for non-gateway payments; provider settlement/fee reconciliation and disputes are still incomplete.
- **Shop operations:** POS invoice draft/issue, invoice-linked partial-return credit notes, tax profiles, current/sold gold registers with customer and invoice details, supplier purchase orders, submitted order tracking, partial item-by-item goods receipts with barcode/HUID/weight capture, Code 39 stock-label printing, current-stock reconciliation snapshots with audited discrepancy resolution, branch-specific reorder alerts, audited valuation history/revaluation, approval-based inter-branch transfers (request → independent review → dispatch → destination receipt), inventory movements, old-gold valuation, orders/repairs, date/branch-filtered reports and scoped CSV exports. Supplier receipt posts stock atomically. Issued credit notes now support explicit, audited physical returns for tracked pieces: a manager must confirm actual receipt, choose restock or repair and give a reason. Financial refunds remain separate and do not happen automatically.
- **Operations:** subscription/entitlements view, consent-aware Resend/Twilio/WhatsApp/in-app delivery adapters, signed provider delivery callbacks with replay-safe event storage, callback reconciliation via the scheduled worker, integration credential readiness plus tenant-scoped recent success/failure/pending activity, tenant audit search/export, and CI checks.

## Important: not yet a fully production-ready platform

The repository intentionally does not pretend that missing integrations work. The following still require implementation, credentials or verified end-to-end testing:

- No actual gold-rate vendor/credentials are selected or configured yet. The feed importer and daily schedule exist, but imported prices remain private and indicative until reviewed; displayed samples remain examples only.
- Razorpay must be configured in test mode and checkout, capture/refund webhooks, repeated events, uncertain refund outcomes, subscription activation/cancellation and provider settlement tested. The gateway-refund code is connected but has not been verified against merchant test credentials. All subscription plan prices are currently ₹0 in the connected database until a platform administrator configures them. Disputes and automatic settlement/fee reconciliation remain incomplete.
- Dunning/payment retry for subscriptions, invoices for SaaS billing, full platform analytics/usage limits, end-to-end feature enforcement and all tenant lifecycle operations are not finished.
- Provider delivery adapters, send-time consent checks, queued retries, signed Resend/Twilio/WhatsApp callback handlers, and a private idempotency ledger are implemented. No real provider delivery is verified yet: configure provider credentials, approved templates, HTTPS callback URLs and signing secrets, then test success, terminal failure, invalid signature and replay. See the [operations and recovery runbook](docs/OPERATIONS_RUNBOOK.md).
- Purchase orders now support draft creation, line-level products/quantity/cost/tax, validated submission and idempotent item-by-item partial goods receipts; receipts atomically create individual stock pieces, movement entries and an audit event. Supplier invoice/accounts-payable capture, matching PO-linked invoice quantities against received quantities, due-date tracking, partial/full payment ledger, idempotent payment recording and reason-required reversals are now implemented. Supplier bill price or tax differences from a linked purchase order require a separate owner/manager approval with a reason; editing invoice lines invalidates that approval. Supplier bills can be voided only while unpaid with a reason; this is an audited status change, not deletion. Remaining supplier-accounting gaps include supplier statement reconciliation, bank-feed ingestion, purchase tax return integration and scheduled payment approvals. Credit notes now have a separate authorized, reason-required and audited physical return workflow for tracked pieces; financial refunds remain separate and require their own approved process. Operational backups, monitoring and a real recovery drill still require owner configuration.
- Automated integration/E2E tests with multiple unrelated tenant identities and branch/role combinations are still required.

See [the implementation status checklist](docs/IMPLEMENTATION_STATUS.md), [operations/backup/recovery runbook](docs/OPERATIONS_RUNBOOK.md) and [Razorpay setup guide](docs/PAYMENTS_RAZORPAY.md) for the precise feature state and setup constraints.

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
