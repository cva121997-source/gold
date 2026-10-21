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

## Gateway refunds (merchant test mode required)

After an authorized owner/manager/accountant approves a refund request, the Refunds screen exposes **Submit Razorpay refund** for a confirmed payment whose provider is Razorpay. The server validates the refund and original payment in a locked database function, reserves the request before making the provider call, and sends amount in paise with a stable receipt and notes containing Gold's refund identifier. Do not mark gateway refunds complete through the manual cash/bank payout action.

Register these refund events on the same signed webhook URL:

- `refund.created`
- `refund.processed`
- `refund.failed`
- `refund.speed_changed`

The handler validates the HMAC signature on the raw request body before persisting the event, and deduplicates provider event IDs. The database applies the provider event to a single matching refund and a confirmed Razorpay payment; unmatched or ambiguous events are left unprocessed for reconciliation rather than being assigned to the first plausible refund.

The Razorpay Payment Refunds API does not document the custom idempotency header used by RazorpayX payouts. Therefore, if a request times out or Gold already has a refund in `processing`, the retry path looks up existing refunds using the stable receipt and Gold note. It will **not blindly POST a second refund** when it cannot find an existing provider result. Check the Razorpay Dashboard, then reconcile; unknown provider outcomes need human review before any separate retry is initiated.

Test successful processing, a pending refund, a failed refund, repeated webhooks, invalid signatures, network timeout/reconciliation and two same-amount refunds on one payment in Razorpay test mode. Refund creation and callback code is implemented, but real merchant-account behavior remains unverified until these tests pass.

## Still not supplied by this integration

The repository does not contain merchant credentials and cannot verify provider-side checkout without them. Approved gateway refunds are implemented through a server-side Razorpay API route and signed `refund.created`, `refund.processed`, `refund.failed` and `refund.speed_changed` webhook events. The route writes a stable receipt and Gold refund identifier, and reconciles a processing refund against Razorpay's refund list instead of blindly submitting a second payout if a request outcome is uncertain. Configure refund events on the same `/api/payments/razorpay/webhook` endpoint. No merchant test credentials or real refund test are available in the repository environment. Full provider settlement reconciliation, dispute handling and business/legal review of scheme terms and tax rules remain separate tasks.
