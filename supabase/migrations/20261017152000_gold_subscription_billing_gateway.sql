begin;

alter table public.subscription_plans
  add column if not exists provider_monthly_plan_ref text,
  add column if not exists provider_annual_plan_ref text;

alter table public.tenant_subscriptions
  add column if not exists billing_interval text not null default 'monthly',
  add column if not exists latest_provider_event_at timestamptz;

alter table public.tenant_subscriptions drop constraint if exists tenant_subscriptions_status_check;
alter table public.tenant_subscriptions add constraint tenant_subscriptions_status_check
  check (status = any (array['trial','pending','active','past_due','cancelled','suspended']::text[]));
alter table public.tenant_subscriptions drop constraint if exists tenant_subscriptions_billing_interval_check;
alter table public.tenant_subscriptions add constraint tenant_subscriptions_billing_interval_check
  check (billing_interval = any (array['monthly','annual']::text[]));

create table if not exists public.subscription_webhook_events (
  event_id text primary key,
  provider text not null default 'razorpay' check (provider='razorpay'),
  event_type text not null,
  provider_subscription_ref text,
  status text not null default 'received' check (status in ('received','processing','processed','ignored','failed')),
  body_sha256 text not null,
  safe_error text,
  received_at timestamptz not null default now(),
  processed_at timestamptz,
  updated_at timestamptz not null default now()
);
create index if not exists subscription_webhook_recent_idx
  on public.subscription_webhook_events(received_at desc);
create index if not exists tenant_subscriptions_provider_ref_idx
  on public.tenant_subscriptions(provider,provider_subscription_ref)
  where provider_subscription_ref is not null;

alter table public.subscription_webhook_events enable row level security;
drop policy if exists subscription_webhook_events_service_only on public.subscription_webhook_events;
create policy subscription_webhook_events_service_only on public.subscription_webhook_events
  for all to service_role using (true) with check (true);
revoke all on public.subscription_webhook_events from public,anon,authenticated;
grant all on public.subscription_webhook_events to service_role;

revoke insert, update, delete on public.subscription_plans from anon,authenticated;
revoke insert, update, delete on public.tenant_subscriptions from anon,authenticated;
grant select on public.subscription_plans to anon,authenticated;
grant select on public.tenant_subscriptions to authenticated;

commit;