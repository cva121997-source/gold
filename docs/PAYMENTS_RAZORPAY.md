# Razorpay setup and operational notes

Gold uses Razorpay only when the server-side credentials are configured. The integration is designed so a browser checkout callback cannot credit a scheme or invoice.

## Required server environment

Configure these values in local `.env.local` and the hosting provider's server environment settings:

- `RAZORPAY_KEY_ID`: Razorpay test or live key ID.
- `RAZORPAY_KEY_SECRET`: matching key secret. Never prefix this with `NEXT_PUBLIC_`.
- `RAZORPAY_WEBHOOK_SECRET`: webhook secret configured for `/api/payments/razorpay/webhook`.
- `RAZORPAY_SUBSCRIPTION_WEBHOOK_SECRET`: optional separate webhook secret for `/api/payments/razorpay/subscription-webhook`. It can fall back to `RAZORPAY_WEBHOOK_SECRET`, but a separate secret is recommended.
- `NEXT_PUBLIC_SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY`: server-side database access for the order and webhook APIs. The service-role key must never enter client bundles or Git.

Use Razorpay test credentials until the complete transaction workflow has been verified. Do not enable live-mode checkout until the business has tested the supported transaction cases.

## Configure Razorpay webhooks

In the Razorpay Dashboard, configure the webhook URL:

`https://YOUR-GOLD-DOMAIN/api/payments/razorpay/webhook`

For the payment webhook, subscribe to **payment.captured**. Set a strong webhook secret and copy it to `RAZORPAY_WEBHOOK_SECRET` on the server. Keep it separate from the checkout key secret.

Razorpay must send `x-razorpay-signature` and, where supported, `x-razorpay-event-id`. Gold validates the HMAC SHA-256 signature against the unmodified request body before calling the database processor.

## Processing behaviour

1. An authenticated staff member or a customer with a verified shop link requests a payment order.
2. Gold validates tenant status, user access, branch restrictions, enrolment/invoice ownership, allowed amount and (for flexible gold-weight contributions) a fresh verified gold-rate snapshot.
3. The server creates the provider order and saves the provider reference before opening Checkout.
4. Only a valid, signed `payment.captured` event can confirm the payment.
5. The database rejects amount/currency mismatches, deduplicates provider events and payment references, records a receipt and audit event, and updates an eligible scheme allocation or invoice settlement atomically.
6. A verified capture that no longer matches the current business state is recorded as requiring review. Reconcile those events before making any manual correction.

A successful browser callback is not proof of payment. The UI intentionally says “processing” until the signed webhook reaches Gold.

## SQL

The gateway migration is `supabase/migrations/202610170019_gold_razorpay_gateway_and_security_hardening.sql`. It was applied to the connected Gold Supabase project. Keep this file committed with the application and review it whenever database schema changes are made.


## SaaS subscription billing

Configure the subscription webhook URL separately:

`https://YOUR-GOLD-DOMAIN/api/payments/razorpay/subscription-webhook`

Subscribe to the provider subscription lifecycle events that your Razorpay account exposes: `subscription.activated`, `subscription.charged`, `subscription.cancelled`, `subscription.completed`, `subscription.halted`, `subscription.paused`, `subscription.resumed`, `subscription.pending` and `subscription.authenticated`. Gold validates the raw-body HMAC signature, deduplicates provider event IDs and applies status changes through a service-role-only SQL function. Older webhook events cannot overwrite newer subscription state.

Before a paid checkout is available, configure actual monthly/annual INR prices in **Platform Admin → Manage plans**. All plan prices in the connected project were initially zero, so the implementation deliberately does not invent prices or send ₹0 to Razorpay. The provider plan is created automatically on the first paid checkout for a configured price. Razorpay plan resources are immutable; price updates reset the stored reference so future checkouts create a new provider plan while existing subscriptions keep their provider-side terms.

Shop owners can activate a zero-cost plan/trial directly. Paid plans open Razorpay-hosted subscription checkout and remain `pending` until a signed webhook confirms activation. Cancellation for paid subscriptions is scheduled at the end of the period; free plans/trials can be cancelled locally. The database records provider events, subscription status changes and platform plan edits in audit logs.

Test subscription creation, invalid webhook signatures, duplicate/replayed event IDs, activation, charge, pause/halt, cancellation, and old-event replay in **Razorpay test mode** before live billing. The integration is code-complete for the happy-path flow, but production behaviour still depends on valid merchant configuration, active paid plan prices, webhook event selection and provider test results.

## Still not supplied by this integration

The repository does not contain merchant credentials and cannot verify provider-side checkout without them. Gateway refunds, full provider settlement reconciliation, dispute handling and business/legal review of scheme terms and tax rules remain separate tasks.
