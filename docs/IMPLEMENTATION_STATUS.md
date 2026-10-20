# Gold implementation status

Updated: 2026-10-20

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
- A provider-agnostic JSON-feed refresh API validates timestamped rates, matches state/district/city/locality, records per-shop import runs, avoids duplicate snapshots, and imports as private indicative/stale rows. A Vercel Cron schedule runs daily at 09:00 India time when secrets/provider are configured.
- Owner/manager review RPC lets shops verify or reject imported indicative rates and separately choose whether a verified rate is public. Expired or older-than-36-hour feed rows cannot be verified.
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
- Manual provider/bank reconciliation register supports period comparison, evidence notes, status tracking and CSV export; it does not fetch statements or validate provider payouts automatically.
- Credit-note workflow creates an invoice-linked draft for selected line quantities, reserves already-credited quantities, prorates from invoice line/tax snapshots, and supports audited issue/void. Stock return and refund payment remain separate explicit workflows.

### Shop operations
- POS invoice draft/issue workflow with tax profile requirements and rate/item snapshots.
- Inventory product/item records, item-level barcode/HUID/weights, Current Gold and Sold Gold registers, printable Code 39 stock labels, supplier purchase order drafts/submission, partial goods receipt, receipt history, and atomic inventory movement/audit tracking.
- Stocktake snapshot/count/review workflow with barcode/HUID search; missing/extra/changed-in-flight counts are audited and are not automatically written off.
- Branch/product low-stock thresholds backed by server-computed on-hand quantities; audited item revaluation with prior/new values, reason/reference, actor, initial-history baseline and CSV export.
- Inter-branch transfer request, independent approval (requester cannot self-approve), dispatch and destination receipt. Items become unavailable at submission, stay in transit until receipt, and are only assigned to the destination branch on confirmation.
- Date-range and branch-filtered reports for collections, invoice values and issued credit notes, collections by payment method, outstanding/overdue instalments, with scoped CSV export.
- Old-gold valuation and owner/manager review.
- Customer order and repair tracking.
- Reports page with baseline totals/CSV output.
- Shop settings for profile, branches, language and effective-dated tax configuration.
- Subscription/trial overview and feature-entitlement display.
- Platform-admin plan catalogue editor for monthly/annual INR prices, trial duration, feature limits and activation state.
- Owner-only free plan/trial activation and Razorpay-hosted paid subscription checkout; paid subscriptions remain pending until a signature-verified lifecycle webhook updates the database. Paid cancellations are scheduled at the period end.
- Separate raw-body HMAC-verified subscription webhook, deduplicated event ledger, service-role-only state processor, stale-event protection and plan entitlement synchronization on activation/cancellation.
- Consent-aware queued notification worker with exponential retries and stale-processing recovery; Resend email, Twilio SMS, WhatsApp approved-template and in-app delivery adapters; signed raw-body delivery-status callbacks; replay-safe provider event ledger; and pending-callback reconciliation from the scheduled worker. The integration page reports outbound and callback readiness without exposing secrets. These paths still need real provider credentials, endpoint registration and end-to-end provider tests.
- Owner/manager audit-log view with search, event details and CSV export.
- CI workflow runs type-check, unit tests, lint and production build on main pushes and pull requests.

### Database safeguards added
- CRM customer notes/interactions are tenant/branch scoped and append-only for authenticated clients.
- Customer consent is recorded through a role-checked and audited RPC.
- Refunds require a confirmed payment, are reviewed and audited, and cannot exceed the remaining refundable amount.
- Platform-level administrative events are stored separately from tenant audit history and are service-role-only.
- Rate provider run-history and notification retry metadata have been added for operational instrumentation.
- All public tables currently have RLS enabled (verified live on the connected project after adding the lifecycle tables). The Supabase security advisor currently reports `authenticated_security_definer_function_executable` warnings for workflow RPCs that are granted to authenticated callers; those functions perform tenant/role/branch checks internally, but the warnings need a formal security review. The performance advisor has also reported unused-index information and permissive-policy overlap warnings that need review.

## Not production-complete — remaining requirements

- **Live market-rate feed:** the generic importer, daily schedule, input validation, import audit, stale handling and owner/manager review are implemented, but no actual provider has been selected/configured or tested. Provider schema compatibility, authorisation/licensing, alerting and real feed monitoring remain; no real rate data is imported until secrets are set. Do not describe any static/sample input as a live price.
- **Payments:** configure Razorpay test credentials and test checkout, duplicate webhook, invalid signature, delayed/replayed event and failed payment. Gateway refunds, signed refund webhooks, disputes, automatic retries and automated provider settlement reconciliation are not finished; only a manual expected-vs-statement reconciliation register is available.
- **Subscriptions/billing:** plan pricing/entitlement management, free trials, hosted Razorpay subscription checkout, signed lifecycle webhooks and cancellation are wired. No paid prices or merchant secrets are configured yet, and test-mode end-to-end checkout has not been performed. Dunning/retry recovery, SaaS billing invoices, grace-period policy and full subscription analytics remain.
- **Notifications:** provider adapters, active templates, send-time channel/promotional consent checks, a 5-minute worker schedule, exponential retries, stale-processing recovery, signed Resend Svix validation, Twilio signature validation, WhatsApp Meta challenge/HMAC validation, idempotent callback ledger, and pending event reconciliation are implemented. Configure `RESEND_WEBHOOK_SECRET`, `TWILIO_STATUS_CALLBACK_URL` (or `NOTIFICATION_PUBLIC_BASE_URL`), `WHATSAPP_APP_SECRET` and `WHATSAPP_WEBHOOK_VERIFY_TOKEN`; register provider callbacks and perform test sends. No real provider delivery has been verified because credentials/accounts are not confirmed in the environment.
- **POS and inventory:** supplier purchase-order creation/submission, item-by-item partial goods receipts, printable Code 39 labels, count snapshots with manager review, branch-specific reorder thresholds, reason-required revaluation history, and inter-branch transfer request/approval/dispatch/receipt are implemented. Supplier invoice/AP ledgers now support PO-linked quantity matching to received stock, duplicate invoice-number guard, due dates, partial payment tracking, idempotent payment recording and audited reason-required reversals. Supplier bill price or tax differences from a linked purchase order require a separate owner/manager approval with a reason; editing invoice lines invalidates that approval. Supplier bills can be voided only while unpaid with a reason; this is an audited status change, not deletion. Still incomplete: supplier statement/bank-feed reconciliation, payment scheduling with approval thresholds, approved inventory variance posting/writes-off, QR labels, full inventory accounting and credit-note-linked stock return/refund processing.
- **Scheme operations:** richer scheme editor/version diff and rollback, configurable first/monthly grace or weight-in periods, mature payout handling, cancellation policies, benefits/redeem-to-invoice settlement, statements and dispute handling need more coverage and legal review.
- **CRM/customer service:** customer self-service activation, profile maintenance, richer consent/customer export workflow, statements, duplicate merge and purpose-limited data retention are incomplete.
- **Reports and operations:** reports have date/branch filters, collection-by-method totals and issued-credit-note totals, with CSV export. Queries remain limited to 2,000 records per source and are not suitable as a final paginated accounting export. A recovery/operations runbook is documented, but backup-plan selection, off-site exports, monitoring/alerting, retention policy, scheduled reports, accounting-grade pagination and a real restore drill still require owner configuration and verification.
- **Security/quality:** regression tests and CI typecheck/lint/build cover key code paths, but automated live database integration tests using unrelated shops, branch-role variants, linked/unlinked customers, concurrency tests and browser E2E are not yet complete. The live Supabase Security Advisor reports `authenticated_security_definer_function_executable` warnings for authenticated workflow RPCs that rely on in-function auth/tenant/branch checks; review each warning and keep grants/privileges least-privileged. Performance Advisor also reports duplicate indexes, overlapping permissive policies and unused-index candidates; these need reviewed, measured remediation rather than blind deletion. Static tests are not a substitute for production security testing.
- **Deployment:** Vercel production environment, required secrets, redirect URLs, cron/worker setup, domain, observability and end-to-end live deployment still need owner configuration and verification.

## External setup required

1. Configure server-only `SUPABASE_SERVICE_ROLE_KEY`, plus browser-safe Supabase URL and anon/publishable key.
2. Bootstrap the intended platform administrator through the project's protected admin table using the exact existing Supabase Auth user ID.
3. Add Supabase Auth callback URLs and configure the intended phone/email authentication and verification providers.
4. Configure Razorpay **test** credentials and subscribe to `payment.captured` at `/api/payments/razorpay/webhook`; configure the separate `/api/payments/razorpay/subscription-webhook` for subscription lifecycle events and set a webhook secret. Run end-to-end tests before considering live mode.
5. Configure notification providers and templates in test mode. Register Resend at `/api/notifications/webhooks/resend`, configure Twilio's exact HTTPS status callback to `/api/notifications/webhooks/twilio`, and verify Meta's WhatsApp callback at `/api/notifications/webhooks/whatsapp`. Set callback environment variables documented in `.env.example`, send a real test message per channel, and confirm `delivered` or terminal `failed` state via callbacks.
6. Set real INR plan prices, trial policy and entitlements in Platform Admin → Manage plans. Do not enable live billing until hosted checkout and all subscription webhook paths have been tested.
7. Select and obtain authorised gold-rate and messaging providers before configuring any related secrets.
8. Configure Vercel production environment variables and prove the production deployment—not just a preview—works.
9. Follow [the operations runbook](OPERATIONS_RUNBOOK.md) to configure backups, export critical data to encrypted off-site storage, test a restore in an isolated project and document recovery objectives.
10. Have jurisdiction-appropriate professionals review GST, invoice, scheme, consent, record-retention and customer-communication rules.

## Current honest status

The repo has a broad functional foundation and now includes CRM/consent history, refund controls, redemption UI, invoice-linked credit notes/returns, manual reconciliation, an auditable gold-rate provider importer/review flow, Current Gold/Sold Gold tabs linked to named customers, supplier purchase orders/receipts and accounts payable, stocktake reconciliation, reorder rules, valuation audit history, transfer approvals, printable barcode labels, date/branch-filtered reports, notification queue/delivery recovery, subscription checkout/webhook/cancellation flow, platform plan editor, audit-log viewer and regression checks. The new SQL migrations were applied to the connected Gold Supabase project. This is **not yet a complete production SaaS**; the remaining items above are real implementation and external-configuration work, not just a checklist of credentials.
