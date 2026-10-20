import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const read = (path) => readFileSync(join(process.cwd(), path), "utf8");
const webhook = read("app/api/notifications/webhooks/[provider]/route.ts");
const delivery = read("app/api/notifications/deliver/route.ts");
const schema = read("supabase/migrations/20261020123000_gold_notification_provider_webhooks.sql");
const env = read(".env.example");
const integrations = read("app/api/integrations/status/route.ts");

test("notification provider event ledger is private and replay-safe", () => {
  assert.match(schema, /create table if not exists public\.notification_provider_events/i);
  assert.match(schema, /unique\(provider,provider_event_id\)/i);
  assert.match(schema, /alter table public\.notification_provider_events enable row level security/i);
  assert.match(schema, /revoke all on public\.notification_provider_events from public,anon,authenticated/i);
  assert.match(schema, /grant all on public\.notification_provider_events to service_role/i);
  assert.doesNotMatch(schema, /raw_payload|message_body|recipient_email/i);
});

test("Resend webhooks verify Svix headers, raw-body signatures and replay timestamp", () => {
  assert.match(webhook, /RESEND_WEBHOOK_SECRET/);
  assert.match(webhook, /svix-id/);
  assert.match(webhook, /svix-timestamp/);
  assert.match(webhook, /svix-signature/);
  assert.match(webhook, /Date\.now\(\)\s*\/\s*1000.*>\s*300/);
  assert.match(webhook, /id\s*\+\s*"\."\s*\+\s*timestamp\s*\+\s*"\."\s*\+\s*rawBody/);
});

test("Twilio callbacks are signed and attached to outbound SMS when configured", () => {
  assert.match(webhook, /TWILIO_AUTH_TOKEN/);
  assert.match(webhook, /x-twilio-signature/i);
  assert.match(webhook, /createHmac\("sha1"/);
  assert.match(webhook, /MessageSid/);
  assert.match(webhook, /MessageStatus/);
  assert.match(delivery, /form\.set\("StatusCallback", statusCallback\)/);
});

test("WhatsApp callbacks verify Meta challenge and raw-body signature", () => {
  assert.match(webhook, /WHATSAPP_WEBHOOK_VERIFY_TOKEN/);
  assert.match(webhook, /hub\.verify_token/);
  assert.match(webhook, /WHATSAPP_APP_SECRET/);
  assert.match(webhook, /x-hub-signature-256/i);
  assert.match(webhook, /createHmac\("sha256"\)/);
  assert.match(webhook, /value\?\.statuses/);
});

test("delivery callbacks update terminal state without re-enqueueing provider failures", () => {
  assert.match(webhook, /notification_provider_events/);
  assert.match(webhook, /processed_at/);
  assert.match(webhook, /\.in\("status",\s*\["sent",\s*"processing"\]\)/);
  assert.match(webhook, /attempt_count:\s*Math\.max\([^\n]+max_attempts/);
  assert.match(delivery, /retryPendingProviderEvents/);
  assert.match(delivery, /providerEventsReconciled/);
});

test("notification callback configuration is documented and readiness is visible", () => {
  for (const key of ["RESEND_WEBHOOK_SECRET", "TWILIO_STATUS_CALLBACK_URL", "WHATSAPP_APP_SECRET", "WHATSAPP_WEBHOOK_VERIFY_TOKEN", "NOTIFICATION_PUBLIC_BASE_URL"]) {
    assert.match(env, new RegExp("^" + key + "=", "m"));
  }
  assert.match(integrations, /Email delivery callbacks/);
  assert.match(integrations, /SMS delivery callbacks/);
  assert.match(integrations, /WhatsApp delivery callbacks/);
});
