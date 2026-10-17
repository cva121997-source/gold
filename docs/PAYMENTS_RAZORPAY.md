# Razorpay setup and operational notes

Gold uses Razorpay only when the server-side credentials are configured. The integration is designed so a browser checkout callback cannot credit a scheme or invoice.

## Required server environment

Configure these values in local `.env.local` and the hosting provider's server environment settings:

- `RAZORPAY_KEY_ID`: Razorpay test or live key ID.
- `RAZORPAY_KEY_SECRET`: matching key secret. Never prefix this with `NEXT_PUBLIC_`.
- `RAZORPAY_WEBHOOK_SECRET`: webhook secret configured for this Gold endpoint.
- `NEXT_PUBLIC_SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY`: server-side database access for the order and webhook APIs. The service-role key must never enter client bundles or Git.

Use Razorpay test credentials until the complete transaction workflow has been verified. Do not enable live-mode checkout until the business has tested the supported transaction cases.

## Configure Razorpay webhooks

In the Razorpay Dashboard, configure the webhook URL:

`https://YOUR-GOLD-DOMAIN/api/payments/razorpay/webhook`

Subscribe to **payment.captured**. Set a strong webhook secret and copy that same value to `RAZORPAY_WEBHOOK_SECRET` on the server. Keep this secret separate from the checkout key secret.

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

## Still not supplied by this integration

The current gateway work does not configure Razorpay credentials, initiate subscription billing, execute refunds, import provider settlement reports, handle disputes, or replace business/legal review of scheme terms and tax rules. Those remain separate tasks.
