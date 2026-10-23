begin;

create table if not exists public.notification_provider_events (
 id uuid primary key default gen_random_uuid(),
 provider text not null check(provider in ('resend','twilio','whatsapp')),
 provider_event_id text not null,
 event_type text not null,
 provider_message_ref text,
 mapped_status text check(mapped_status is null or mapped_status in ('delivered','failed')),
 received_at timestamptz not null default now(),
 processed_at timestamptz,
 processing_error text,
 unique(provider,provider_event_id)
);

create index if not exists notification_provider_events_pending_idx
 on public.notification_provider_events(provider,received_at)
 where processed_at is null;
create index if not exists notification_provider_events_message_ref_idx
 on public.notification_provider_events(provider,provider_message_ref)
 where provider_message_ref is not null;

alter table public.notification_provider_events enable row level security;
revoke all on public.notification_provider_events from public,anon,authenticated;
grant all on public.notification_provider_events to service_role;

comment on table public.notification_provider_events is
 'Service-role-only idempotency ledger for signed email/SMS/WhatsApp delivery callbacks; does not store raw provider payloads or message content.';

commit;