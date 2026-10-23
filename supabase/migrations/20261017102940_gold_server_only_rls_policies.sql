begin;

-- These tables are deliberately server-only. Explicit service_role-only policies remove
-- ambiguous "RLS enabled without policies" findings without granting browser access.
drop policy if exists payment_webhook_events_service_only on public.payment_webhook_events;
create policy payment_webhook_events_service_only on public.payment_webhook_events
  for all to service_role using (true) with check (true);

drop policy if exists platform_admins_service_only on public.platform_admins;
create policy platform_admins_service_only on public.platform_admins
  for all to service_role using (true) with check (true);

drop policy if exists platform_settings_service_only on public.platform_settings;
create policy platform_settings_service_only on public.platform_settings
  for all to service_role using (true) with check (true);

drop policy if exists feature_flags_service_only on public.feature_flags;
create policy feature_flags_service_only on public.feature_flags
  for all to service_role using (true) with check (true);

commit;