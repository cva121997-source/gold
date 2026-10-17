# Gold implementation status

Updated: 2026-10-17

## Implemented in the repository

### Platform, tenancy and access controls
- Next.js App Router, TypeScript, Tailwind CSS and responsive shared workspace navigation.
- One Supabase project architecture for multiple shops, tenant membership, branches, role data, tax settings, audit events and RLS-backed data access.
- Tenant onboarding and platform-admin shop creation/status endpoints. Platform administrator bootstrap must be done manually by an existing project owner.
- Branch-aware staff memberships and single-use staff invitations with hashed tokens and accepted-contact matching.
- Customer login and verified shop linking through Supabase Auth. Auth phone/password/OTP and redirect settings require setup and end-to-end testing.
- Server-only service role usage. Provider keys are not exposed through client-facing status APIs.

### Gold rates and calculator
- Manual effective-dated shop rates by metal, purity and locality/branch, with source and status values and historical snapshots.
- Public price board can show only rates shops explicitly opt in to publish; date lookup exists.
- Calculator supports 24K, 22K and 18K, weight/rate inputs, percentage/fixed/per-gram making charges, wastage, other charges, discount, configurable GST estimate, calculation breakdown and approximate budget-to-weight.
- Screenshot-regression formula tests validate the example calculation. Demonstration inputs are labelled as examples; they must never be presented as verified live market prices.

### CRM and customer portal
- Shop customer directory with duplicate-mobile checks and tenant scoping.
- Customer portal shows linked shops, savings schemes, confirmed payments, instalments and receipts.
- Customer-history workspace records append-only internal notes, interactions and optional follow-up times.
- Consent history records channel/purpose, evidence source, terms/notice version, staff actor, grant/withdrawal events and audit log events.
- Customer profile self-linking requires verified mobile/contact matching. Full KYC/identity verification is not implemented.

### Schemes and collections
- Scheme draft templates, versioned terms, owner-controlled publish/review workflow, two seed templates on tenant creation and enrolled-customer terms snapshots.
- Fixed monthly scheme enrolment generates an instalment schedule from the published terms.
- Manual contributions validate staff access, idempotency and amount; flexible gold-weight contributions require a fresh verified rate and save the rate/weight snapshot to payment, transaction, receipt and audit event.
- Benefit eligibility evaluation and redemption workspace for requests, owner/manager approval, rejection, completion and cancellation.
- Customer-facing Razorpay checkout order and capture webhook path is implemented. Provider event HMAC is checked against the raw body; captured amounts and currency are verified server-side before the database settles the payment or invoice.
- Refund request/review and manual cash/bank payout recording exist. Refund requests reserve the remaining refundable amount and are audited. Staff cannot mark a Razorpay/card/gateway refund complete through the manual path.

### Shop operations
- POS invoice draft/issue workflow with tax profile requirements and rate/item snapshots.
- Inventory product/item records, stock receipt/movement workflow and HUID field.
- Old-gold valuation and owner/manager review.
- Customer order and repair tracking.
- Reports page with baseline totals/CSV output.
- Shop settings for profile, branches, language and effective-dated tax configuration.
- Subscription/trial overview and feature-entitlement display.
- Notification queue and per-notification provider delivery state fields. Integrations page reports credential readiness without returning secrets.
- Owner/manager audit-log view with search, event details and CSV export.
- CI workflow runs type-check, unit tests, lint and production build on main pushes and pull requests.

### Database safeguards added
- CRM customer notes/interactions are tenant/branch scoped and append-only for authenticated clients.
- Customer consent is recorded through a role-checked and audited RPC.
- Refunds require a confirmed payment, are reviewed and audited, and cannot exceed the remaining refundable amount.
- Platform-level administrative events are stored separately from tenant audit history and are service-role-only.
- Rate provider run-history and notification retry metadata have been added for operational instrumentation.
- All existing public tables have RLS enabled. Latest Supabase security advisor run returned no security lints; the performance advisor still reports unused-index information and permissive-policy overlap warnings that need review.

## Not production-complete — remaining requirements

- **Live market-rate feed:** no rate provider has been selected/configured and the fetch adapter, scheduled updater, market-data licensing, stale-rate fallback, alerting and shop approval flow are not finished. Do not describe any static/sample input as a live price.
- **Payments:** configure Razorpay test credentials and test checkout, duplicate webhook, invalid signature, delayed/replayed event and failed payment. Gateway refunds, signed refund webhooks, disputes, automatic retries and full settlement reconciliation are not finished.
- **Subscriptions/billing:** plans and entitlements are represented, but customer checkout/renewals, webhook updates, dunning, invoices and complete tenant lifecycle are not wired.
- **Notifications:** SMS, WhatsApp Business and email provider adapters, templates, opt-out enforcement at send time, background worker, provider callbacks and failure/retry runbooks need implementation and credentials. The queue UI and config-readiness check are not proof of delivery.
- **POS and inventory:** credit notes, item returns, purchase/supplier lifecycle, barcodes/label printing, stock-count adjustments, transfer approval, valuation history and full inventory accounting remain incomplete.
- **Scheme operations:** richer scheme editor/version diff and rollback, configurable first/monthly grace or weight-in periods, mature payout handling, cancellation policies, benefits/redeem-to-invoice settlement, statements and dispute handling need more coverage and legal review.
- **CRM/customer service:** customer self-service activation, profile maintenance, richer consent/customer export workflow, statements, duplicate merge and purpose-limited data retention are incomplete.
- **Reports and operations:** financial reconciliation UI, more comprehensive ledger reports, PDF/CSV statement exports, scheduled reports, backups/restore drill, monitoring/alerting and operational incident handling need work.
- **Security/quality:** automated database integration tests using two unrelated shops, different roles/branches, linked/unlinked customers, money-concurrency tests, and browser E2E flows are not yet complete. Structural regression tests do not replace live tenant-isolation tests.
- **Deployment:** Vercel production environment, required secrets, redirect URLs, cron/worker setup, domain, observability and end-to-end live deployment still need owner configuration and verification.

## External setup required

1. Configure server-only `SUPABASE_SERVICE_ROLE_KEY`, plus browser-safe Supabase URL and anon/publishable key.
2. Bootstrap the intended platform administrator through the project's protected admin table using the exact existing Supabase Auth user ID.
3. Add Supabase Auth callback URLs and configure the intended phone/email authentication and verification providers.
4. Configure Razorpay **test** credentials and subscribe to `payment.captured` at `/api/payments/razorpay/webhook`; run end-to-end tests before considering live mode.
5. Select and obtain authorised gold-rate and messaging providers before configuring any related secrets.
6. Configure Vercel production environment variables and prove the production deployment—not just a preview—works.
7. Have jurisdiction-appropriate professionals review GST, invoice, scheme, consent, record-retention and customer-communication rules.

## Current honest status

The repo has a broad functional foundation and now includes additional CRM/consent history, refund controls, redemption UI, audit-log viewer, integration-readiness view and regression checks. The new SQL migrations were applied to the connected Gold Supabase project. This is **not yet a complete production SaaS**; the remaining items above are real implementation and external-configuration work, not just a checklist of credentials.
