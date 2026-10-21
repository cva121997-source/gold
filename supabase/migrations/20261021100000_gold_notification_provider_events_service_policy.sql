begin;
drop policy if exists notification_provider_events_service_role on public.notification_provider_events;
create policy notification_provider_events_service_role
on public.notification_provider_events
for all
to service_role
using (true)
with check (true);
revoke all on public.notification_provider_events from public,anon,authenticated;
grant all on public.notification_provider_events to service_role;
commit;