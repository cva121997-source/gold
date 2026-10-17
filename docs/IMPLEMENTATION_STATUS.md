# Gold implementation status

Updated: 2026-10-17

## Included in the initial repository foundation

- Next.js App Router scaffold with TypeScript and Tailwind CSS.
- Responsive overview UI; demonstration prices are labelled as sample data.
- Shop onboarding form that calls the trusted create-tenant RPC.
- Manual locality-specific rate entry and append-only rate snapshots, with recent rate history.
- Starter customer CRM page with tenant-scoped creation, duplicate-mobile checks and recent search.
- Scheme draft UI, versioned terms, two draft templates automatically seeded for new tenants, and an owner-only review/publish RPC.
- Additive scheme workflow migration that restricts direct template/version writes so publishing uses the audited RPC.
- Interactive gold estimate calculator: 24K, 22K and 18K presets; weight; rate per gram; percentage, fixed and per-gram making charge modes; wastage; other charges; discount; GST estimate; calculation breakdown; approximate budget-to-weight.
- Supabase SSR browser/server clients and session refresh middleware.
- Phone/password sign-in using Supabase Auth; Supabase phone/password settings still need configuration and end-to-end testing.
- Authenticated dashboard that lists active shop memberships.
- Initial SQL migration for tenants, branches, memberships, settings, customers, customer auth links, metals, purities, rate sources, historical gold rates, scheme drafts/versions/enrolments, append-only transaction events and audit logs.
- RLS policies based on trusted membership and verified customer-link relationships.
- Tenant onboarding RPC that atomically creates the tenant, owner membership, settings, default branch and initial audit record.
- Environment template and local setup notes.

## Not implemented yet — do not treat these as production-ready

- Complete platform-admin console, invitations and full tenant lifecycle management.
- Full onboarding wizard UI, employee role editor, granular branch-level access rules and subscription billing.
- Verified live gold-price integration, scheduled refresh, provider adapters and rate approval workflows.
- Full CRM screens (customer profile details, consent-management history, notes, statements, exports) and verified customer account-linking/activation flow.
- Full scheme editing/version diffing, instalment schedule generation, customer terms acceptance, payment-linked contributions, benefit eligibility and redemption workflows.
- Payment gateway integration, verified signatures/webhooks, refunds, reconciliation and receipt numbering.
- SMS, WhatsApp Business and email integrations.
- POS, invoices/credit notes, inventory movements, old-gold exchange, repairs and orders.
- Business reports, spreadsheet/PDF exports, backup procedures and error monitoring.
- Automated unit, integration, tenant-isolation and end-to-end test suites.
- Vercel deployment configuration and end-to-end production deployment verification.

## Before production

1. Apply and review the SQL migration on the dedicated Gold Supabase project.
2. Test policies with two unrelated tenants, an employee, and a customer linked to only one shop.
3. Configure Supabase Auth phone/password and phone verification settings.
4. Set the Supabase URL and publishable/anon key in local and hosting environments.
5. Run install, lint, typecheck, build and security regression tests.
6. Configure and verify external providers before enabling those features.
7. Obtain appropriate review of published scheme terms and invoice tax behaviour.

## Scope notes

- The calculator provides estimates and does not represent a verified live market rate.
- Fixed rates on the overview and calculator are deterministic demonstration/regression inputs only.
- Customer login depends on Supabase Auth settings; the application does not store plaintext passwords.
- This schema is a foundation and must be expanded using reviewed migrations as modules are implemented.
