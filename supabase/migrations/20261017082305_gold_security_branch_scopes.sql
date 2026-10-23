-- Security hardening: put SECURITY DEFINER internals in a non-API schema,
-- narrow privileged RPC grants, and enforce branch scope on branch-owned records.
begin;
create schema if not exists private;
revoke all on schema private from public, anon, authenticated;
grant usage on schema private to authenticated;

-- Move membership lookups out of the API-exposed public schema. Existing RLS expressions keep
-- their function OIDs when functions move schemas; public invoker wrappers keep application code stable.
alter function public.is_tenant_member(uuid) set schema private;
alter function public.has_tenant_role(uuid,text[]) set schema private;
alter function public.is_linked_customer(uuid,uuid) set schema private;
alter function public.has_tenant_branch_access(uuid,uuid,text[]) set schema private;
alter function public.handle_new_auth_user() set schema private;
alter function public.seed_gold_default_schemes() set schema private;

revoke execute on function private.is_tenant_member(uuid) from public,anon;
revoke execute on function private.has_tenant_role(uuid,text[]) from public,anon;
revoke execute on function private.is_linked_customer(uuid,uuid) from public,anon;
revoke execute on function private.has_tenant_branch_access(uuid,uuid,text[]) from public,anon;
revoke execute on function private.handle_new_auth_user() from public,anon,authenticated;
revoke execute on function private.seed_gold_default_schemes() from public,anon,authenticated;
grant execute on function private.is_tenant_member(uuid) to authenticated;
grant execute on function private.has_tenant_role(uuid,text[]) to authenticated;
grant execute on function private.is_linked_customer(uuid,uuid) to authenticated;
grant execute on function private.has_tenant_branch_access(uuid,uuid,text[]) to authenticated;

create or replace function public.is_tenant_member(p_tenant_id uuid)
returns boolean language sql stable security invoker set search_path = public, private, pg_temp
as $$ select private.is_tenant_member(p_tenant_id); $$;
create or replace function public.has_tenant_role(p_tenant_id uuid,p_roles text[])
returns boolean language sql stable security invoker set search_path = public, private, pg_temp
as $$ select private.has_tenant_role(p_tenant_id,p_roles); $$;
create or replace function public.is_linked_customer(p_tenant_id uuid,p_customer_id uuid)
returns boolean language sql stable security invoker set search_path = public, private, pg_temp
as $$ select private.is_linked_customer(p_tenant_id,p_customer_id); $$;
create or replace function public.has_tenant_branch_access(p_tenant_id uuid,p_branch_id uuid,p_roles text[] default null)
returns boolean language sql stable security invoker set search_path = public, private, pg_temp
as $$ select private.has_tenant_branch_access(p_tenant_id,p_branch_id,p_roles); $$;

revoke execute on function public.is_tenant_member(uuid) from public,anon;
revoke execute on function public.has_tenant_role(uuid,text[]) from public,anon;
revoke execute on function public.is_linked_customer(uuid,uuid) from public,anon;
revoke execute on function public.has_tenant_branch_access(uuid,uuid,text[]) from public,anon;
grant execute on function public.is_tenant_member(uuid) to authenticated;
grant execute on function public.has_tenant_role(uuid,text[]) to authenticated;
grant execute on function public.is_linked_customer(uuid,uuid) to authenticated;
grant execute on function public.has_tenant_branch_access(uuid,uuid,text[]) to authenticated;

-- Privileged workflow RPCs are only callable by signed-in clients; their bodies verify the caller role.
revoke execute on function public.create_tenant_onboarding(text,text,text,text,text,text) from public,anon;
grant execute on function public.create_tenant_onboarding(text,text,text,text,text,text) to authenticated;
revoke execute on function public.create_scheme_draft(uuid,text,text,text,jsonb) from public,anon;
grant execute on function public.create_scheme_draft(uuid,text,text,text,jsonb) to authenticated;
revoke execute on function public.publish_scheme_draft(uuid,uuid,boolean) from public,anon;
grant execute on function public.publish_scheme_draft(uuid,uuid,boolean) to authenticated;
revoke execute on function public.record_manual_payment(uuid,uuid,uuid,uuid,numeric,text,text,text,text) from public,anon;
grant execute on function public.record_manual_payment(uuid,uuid,uuid,uuid,numeric,text,text,text,text) to authenticated;

-- Tighten tenant and branch data access. Owners/managers may access all branches; assigned staff
-- only access rows for their assigned branch. A null branch_id denotes shared tenant-wide records.
drop policy if exists customers_staff_or_self_read on public.tenant_customers;
drop policy if exists customers_staff_insert on public.tenant_customers;
drop policy if exists customers_staff_update on public.tenant_customers;
create policy customers_branch_or_self_read on public.tenant_customers for select to authenticated
using (public.has_tenant_branch_access(tenant_id,branch_id,null) or public.is_linked_customer(tenant_id,id));
create policy customers_branch_insert on public.tenant_customers for insert to authenticated
with check (public.has_tenant_branch_access(tenant_id,branch_id,array['owner','manager','accountant','cashier','scheme_manager','employee']));
create policy customers_branch_update on public.tenant_customers for update to authenticated
using (public.has_tenant_branch_access(tenant_id,branch_id,array['owner','manager','accountant','cashier','scheme_manager','employee']))
with check (public.has_tenant_branch_access(tenant_id,branch_id,array['owner','manager','accountant','cashier','scheme_manager','employee']));

drop policy if exists customer_links_read_self_or_staff on public.customer_auth_links;
create policy customer_links_read_self_or_branch_staff on public.customer_auth_links for select to authenticated
using (
 auth_user_id = (select auth.uid())
 or exists (
   select 1 from public.tenant_customers c
   where c.tenant_id=customer_auth_links.tenant_id and c.id=customer_auth_links.customer_id
     and public.has_tenant_branch_access(c.tenant_id,c.branch_id,array['owner','manager','accountant','cashier','scheme_manager','employee'])
 )
);

drop policy if exists rates_read_members on public.gold_rates;
drop policy if exists rates_insert_managers on public.gold_rates;
drop policy if exists rates_update_managers on public.gold_rates;
create policy rates_branch_read on public.gold_rates for select to authenticated using (public.has_tenant_branch_access(tenant_id,branch_id,null));
create policy rates_branch_insert on public.gold_rates for insert to authenticated with check (public.has_tenant_branch_access(tenant_id,branch_id,array['owner','manager']));
create policy rates_branch_update on public.gold_rates for update to authenticated
using (public.has_tenant_branch_access(tenant_id,branch_id,array['owner','manager']))
with check (public.has_tenant_branch_access(tenant_id,branch_id,array['owner','manager']));

drop policy if exists schemes_read_members on public.scheme_templates;
drop policy if exists schemes_insert_managers on public.scheme_templates;
drop policy if exists schemes_update_managers on public.scheme_templates;
create policy schemes_branch_read on public.scheme_templates for select to authenticated using (public.has_tenant_branch_access(tenant_id,branch_id,null));
create policy schemes_branch_insert on public.scheme_templates for insert to authenticated
with check (public.has_tenant_branch_access(tenant_id,branch_id,array['owner','manager','scheme_manager']));
create policy schemes_branch_update on public.scheme_templates for update to authenticated
using (public.has_tenant_branch_access(tenant_id,branch_id,array['owner','manager','scheme_manager']))
with check (public.has_tenant_branch_access(tenant_id,branch_id,array['owner','manager','scheme_manager']));

drop policy if exists scheme_versions_read_members on public.scheme_versions;
create policy scheme_versions_branch_read on public.scheme_versions for select to authenticated
using (exists(select 1 from public.scheme_templates st where st.tenant_id=scheme_versions.tenant_id and st.id=scheme_versions.scheme_id and public.has_tenant_branch_access(st.tenant_id,st.branch_id,null)));

drop policy if exists enrolments_staff_or_customer_read on public.scheme_enrolments;
drop policy if exists scheme_enrolments_staff_insert_v2 on public.scheme_enrolments;
drop policy if exists enrolments_update_managers on public.scheme_enrolments;
create policy enrolments_branch_customer_read on public.scheme_enrolments for select to authenticated
using (public.has_tenant_branch_access(tenant_id,branch_id,null) or public.is_linked_customer(tenant_id,customer_id));
create policy enrolments_branch_insert on public.scheme_enrolments for insert to authenticated
with check (public.has_tenant_branch_access(tenant_id,branch_id,array['owner','manager','scheme_manager','cashier','employee']));
create policy enrolments_branch_update on public.scheme_enrolments for update to authenticated
using (public.has_tenant_branch_access(tenant_id,branch_id,array['owner','manager','scheme_manager']))
with check (public.has_tenant_branch_access(tenant_id,branch_id,array['owner','manager','scheme_manager']));

drop policy if exists scheme_transactions_staff_or_customer_read on public.scheme_transactions;
create policy scheme_transactions_branch_customer_read on public.scheme_transactions for select to authenticated using (
 public.has_tenant_branch_access(tenant_id,branch_id,null)
 or exists(select 1 from public.scheme_enrolments e where e.tenant_id=scheme_transactions.tenant_id and e.id=scheme_transactions.enrolment_id and public.is_linked_customer(e.tenant_id,e.customer_id))
);

drop policy if exists installments_staff_customer_read on public.scheme_installments;
create policy installments_branch_customer_read on public.scheme_installments for select to authenticated using (
 exists(select 1 from public.scheme_enrolments e where e.tenant_id=scheme_installments.tenant_id and e.id=scheme_installments.enrolment_id
   and (public.has_tenant_branch_access(e.tenant_id,e.branch_id,null) or public.is_linked_customer(e.tenant_id,e.customer_id)))
);
drop policy if exists benefits_staff_customer_read on public.scheme_benefits;
create policy benefits_branch_customer_read on public.scheme_benefits for select to authenticated using (
 exists(select 1 from public.scheme_enrolments e where e.tenant_id=scheme_benefits.tenant_id and e.id=scheme_benefits.enrolment_id
   and (public.has_tenant_branch_access(e.tenant_id,e.branch_id,null) or public.is_linked_customer(e.tenant_id,e.customer_id)))
);
drop policy if exists redemptions_staff_customer_read on public.scheme_redemptions;
create policy redemptions_branch_customer_read on public.scheme_redemptions for select to authenticated using (
 public.has_tenant_branch_access(tenant_id,branch_id,null)
 or exists(select 1 from public.scheme_enrolments e where e.tenant_id=scheme_redemptions.tenant_id and e.id=scheme_redemptions.enrolment_id and public.is_linked_customer(e.tenant_id,e.customer_id))
);

drop policy if exists payment_orders_staff_or_customer_read on public.payment_orders;
create policy payment_orders_branch_customer_read on public.payment_orders for select to authenticated using (
 public.has_tenant_branch_access(tenant_id,branch_id,null) or (customer_id is not null and public.is_linked_customer(tenant_id,customer_id))
);
drop policy if exists payments_staff_or_customer_read on public.payments;
create policy payments_branch_customer_read on public.payments for select to authenticated using (
 public.has_tenant_branch_access(tenant_id,branch_id,null) or (customer_id is not null and public.is_linked_customer(tenant_id,customer_id))
);
drop policy if exists receipts_staff_or_customer_read on public.receipts;
create policy receipts_branch_customer_read on public.receipts for select to authenticated using (
 public.has_tenant_branch_access(tenant_id,branch_id,null) or (enrolment_id is not null and exists(select 1 from public.scheme_enrolments e where e.tenant_id=receipts.tenant_id and e.id=receipts.enrolment_id and public.is_linked_customer(e.tenant_id,e.customer_id)))
);

drop policy if exists memberships_read_self_or_managers on public.tenant_memberships;
create policy memberships_read_self_or_branch_managers on public.tenant_memberships for select to authenticated
using (
 user_id = (select auth.uid())
 or public.has_tenant_branch_access(tenant_id,branch_id,array['owner','manager'])
);

drop policy if exists subscriptions_owner_read on public.tenant_subscriptions;
create policy subscriptions_owner_read on public.tenant_subscriptions for select to authenticated using (public.has_tenant_role(tenant_id,array['owner']));

-- Limit anonymous access to the branch helper endpoint.
revoke execute on function public.has_tenant_branch_access(uuid,uuid,text[]) from anon,public;
grant execute on function public.has_tenant_branch_access(uuid,uuid,text[]) to authenticated;

-- Keep platform administration data invisible to app clients. These tables are intentionally
-- controlled via a separately authenticated server endpoint with the service role configured server-side.
commit;
