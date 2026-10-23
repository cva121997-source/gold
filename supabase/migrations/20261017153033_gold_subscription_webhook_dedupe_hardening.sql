begin;
create unique index if not exists subscription_webhook_body_sha256_key
  on public.subscription_webhook_events(body_sha256);
commit;