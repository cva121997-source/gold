# Operations, backup and recovery runbook

Last reviewed: 2026-10-20

This runbook describes operator steps still required to run Gold safely. Writing a runbook does **not** mean backups, monitoring, a recovery point, or a restore drill have already been configured.

## 1. Release and migration discipline

1. Treat GitHub **main** as the source of truth. Require a green GitHub Actions run (type-check, regression tests, lint and production build) before promoting a release.
2. Apply migrations to a disposable/staging Supabase project first. Review SQL and test role/branch boundaries. Do not use **supabase db reset --linked** against production; the CLI warns that this destroys the linked database.
3. Before a production schema change, confirm a recent recoverable backup/export and a maintenance/rollback plan. Apply the migration through the approved Supabase migration workflow and verify relevant tables, constraints, grants, RLS and workflows afterwards.
4. After a release, run smoke checks against a non-sensitive shop: sign in, select the correct tenant/branch, read a rate and historical rate, run the calculator regression values, create a draft invoice, and exercise one stock workflow. Never test by inserting demo financial records into a real shop.
5. Record the commit SHA, migration names, deployment URL, result, operator and rollback decision in the release log.

## 2. Database backups

Consult the current [Supabase Database Backups guide](https://supabase.com/docs/guides/platform/backups) and [Backup and Restore using the CLI](https://supabase.com/docs/guides/platform/migrating-within-supabase/backup-restore). Availability and retention depend on the project's plan and configuration: do not assume daily backups or point-in-time recovery (PITR) are enabled without checking the actual project.

### Minimum setup

- In Supabase Dashboard, open **Database → Backups** and confirm the most recent recoverable backup and retention. Decide whether the business needs PITR and set a recovery point objective (RPO) and recovery time objective (RTO).
- Keep an independent, encrypted, access-controlled off-site backup. Do not upload customer/financial exports, dump files, database URLs or keys to this Git repository.
- Back up and verify **database data and configuration separately**. Supabase database backups do not include objects held by the Storage API; include required storage objects, auth redirect/provider settings, secrets, cron configuration and operational instructions in your recovery plan.
- If a manual logical export is needed, install the current Supabase CLI and Docker, use a private environment and a secure connection string from the dashboard, and keep outputs outside the repository. Example for a shell session with SUPABASE_DB_URL already set:

    umask 077
    supabase db dump --db-url "$SUPABASE_DB_URL" -f roles.sql --role-only
    supabase db dump --db-url "$SUPABASE_DB_URL" -f schema.sql
    supabase db dump --db-url "$SUPABASE_DB_URL" -f data.sql --data-only --use-copy

  Store the three files in encrypted off-site storage with limited access and retention. Review the current CLI instructions for extensions and provider-specific exclusions before use. These logical dumps do not constitute a complete backup of Storage objects or every Supabase-managed service.
- Do not add these backup artefacts to Git, GitHub Actions logs, issue attachments, or unsecured file shares. Do not echo connection strings in terminal logs.

### Restore drill (must be performed by the operator)

1. Choose a recent backup/export and record its timestamp and expected RPO.
2. Restore it into a **separate, isolated recovery project**, not the production project. Follow the current Supabase restore guide for role/schema/data order and privilege handling.
3. Reconfigure Auth callback URLs/providers and secrets with recovery-specific values; storage objects and non-database settings must be restored/configured separately.
4. Run schema/migration checks and login tests; verify tenant separation with two independent test tenants and test users; compare counts and control totals for invoices, payments, scheme transactions and inventory movements.
5. Record measured restore time, missing data, manual steps and pass/fail. Resolve discrepancies, then repeat the drill at an agreed cadence (at least quarterly for a money-handling production service, and after a major schema change).
6. Keep the restored recovery project isolated and dispose of it securely when approved; never email raw customer financial data.

No restore drill is recorded as completed for this repository at the time of writing.

## 3. Monitoring and incident response

Review these signals during routine operation and after each release:

- GitHub Actions failures and production deployment status.
- Supabase database health, backup/PITR availability, database logs and current Security/Performance Advisor findings.
- Gold-rate feed run history and age/status of the latest owner-verified rate. A provider failure must lead to a clearly marked stale/unavailable rate or manual verified fallback—not an invented live rate.
- Notifications queued, failed, processing for over 10 minutes, callback ledger rows awaiting processing, and provider credential/template readiness.
- Razorpay webhook failures, duplicate/replayed events, pending orders/subscriptions and reconciliation differences.
- Abnormal invoice/payment totals, stock movements, supplier-bill reversals, failed/voided transactions, and role/branch authorization failures.

### Responding to common incidents

- **Possible cross-tenant data exposure:** restrict affected access, preserve logs, stop risky admin/support actions, assess RLS/policy/function grants, follow the organisation's incident and legal notification policy, and do not export broad customer data for debugging.
- **Payment or ledger mismatch:** pause manual corrections, compare gateway reference, signed webhook event, payment order and append-only ledger; use the authorized reversal/refund workflow with evidence. Never directly edit a posted financial row to force a balance.
- **Rate feed is down or stale:** mark feed unavailable/stale, use a separately sourced rate entered by an authorized staff member, capture source/effective time and approval, and do not label sample/demo data as today's price.
- **Messaging callback failure:** inspect the provider dashboard and notification_provider_events processing errors, verify the configured public callback URL, signing secret and recent endpoint response, and reconcile against provider status. Provider acceptance is not the same as delivery confirmation.
- **Migration or release failure:** stop promotion, preserve failing CI/log output and migration state, restore service-compatible code if possible, and use a database restore only under an approved change/incident plan. Do not blindly rerun a non-idempotent SQL statement or reset production.
- **Suspected secret exposure:** rotate the affected provider/database secret in the provider console and deployment environment, redeploy, verify no secret remains in source/history/logs, and investigate use. Never paste the secret into a ticket or chat.

Define severity, on-call owner, escalation contacts, maximum response time, retention period, RPO and RTO with the actual business operator; they cannot safely be inferred from this code repository.

## 4. Provider webhooks

All provider callbacks require a public HTTPS deployment and provider-side webhook registration. Local structural tests do not prove that provider signatures or payloads have been validated against live provider accounts.

| Provider | Callback URL | Required server environment |
| --- | --- | --- |
| Resend email | /api/notifications/webhooks/resend | RESEND_WEBHOOK_SECRET |
| Twilio SMS | /api/notifications/webhooks/twilio | TWILIO_AUTH_TOKEN and the exact HTTPS TWILIO_STATUS_CALLBACK_URL (or NOTIFICATION_PUBLIC_BASE_URL) |
| WhatsApp Cloud API | /api/notifications/webhooks/whatsapp | WHATSAPP_APP_SECRET, WHATSAPP_WEBHOOK_VERIFY_TOKEN |

Resend uses Svix headers/signature over the raw body with a five-minute timestamp window. Twilio uses the configured callback URL and X-Twilio-Signature; configure the exact URL as seen by Twilio because URL changes invalidate signature verification. WhatsApp verifies the Meta challenge and X-Hub-Signature-256. All callback events are deduplicated in a service-role-only event ledger. The scheduled delivery worker also retries unprocessed callback records to handle a provider callback that arrives before the outbound message reference has been persisted.

After configuration, send at least one real test message per channel and verify: successful send, confirmed delivered status, terminal failure, invalid signature rejection and duplicate event handling. Keep provider event/message identifiers as operational data; do not store raw callback payloads or message bodies unnecessarily.

## 5. Financial and access smoke tests

Before enabling a new shop or role, verify:

- A user with membership in Shop A cannot read or mutate Shop B's data.
- A branch-restricted user cannot operate on another branch by modifying request IDs.
- Customer login only shows explicitly linked shop profiles and that customer's own records.
- A repeated payment/provider event does not double-credit a contribution or sale.
- Voids, refunds, payment reversals, price variance approvals, stock write-offs and branch transfers require the configured roles, reason and audit event.
- Current Gold and Sold Gold reconcile to item movements; a sale or return does not silently rewrite the historical invoice snapshot.
- All deployed required environment variables are set in the right environment and are not exposed through a client API.

An opt-in **read-only** two-tenant RLS check is provided in `tests/tenant-isolation-live.test.mjs`. To run it, provision a dedicated non-production Supabase staging project, create two distinct tenants, create a test phone/password account that belongs only to tenant A, and create a disposable customer fixture in tenant B. Export these environment variables in a private shell (do not put passwords in GitHub files or logs):

- `GOLD_ISOLATION_TEST_SUPABASE_URL`
- `GOLD_ISOLATION_TEST_ANON_KEY`
- `GOLD_ISOLATION_TEST_PHONE`
- `GOLD_ISOLATION_TEST_PASSWORD`
- `GOLD_ISOLATION_TEST_TENANT_A_ID`
- `GOLD_ISOLATION_TEST_TENANT_B_ID`
- `GOLD_ISOLATION_TEST_CUSTOMER_B_ID`

Then run `node --test tests/tenant-isolation-live.test.mjs`. It skips when the required variables are absent, refuses the connected production Gold project URL, authenticates the staging user, confirms the user belongs to A, and verifies RLS hides B's fixture. This first live check is intentionally read-only; it is not evidence that cross-tenant writes, branch-level roles or money-concurrency conditions have been fully tested. Keep staging fixtures disposable.

Structural unit tests are not a substitute for the live two-tenant, two-branch integration and browser end-to-end tests that remain on the implementation checklist.
