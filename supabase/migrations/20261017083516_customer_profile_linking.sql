-- Customer self-linking from a verified Supabase phone identity and stricter branch visibility.
begin;

-- Enforce no duplicate phone numbers within one shop even under concurrent submissions.
create unique index if not exists tenant_customers_tenant_mobile_uq
  on public.tenant_customers(tenant_id, mobile_e164);

-- Assigned staff can only read a branch record for their own branch; owners and managers can read all.
drop policy if exists branches_read_members on public.branches;
create policy branches_read_assigned_branch on public.branches
for select to authenticated
using (private.has_tenant_branch_access(tenant_id,id,null));

-- Receipt visibility includes direct payments as well as scheme enrolment receipts.
drop policy if exists receipts_branch_customer_read on public.receipts;
create policy receipts_branch_customer_read on public.receipts
for select to authenticated using (
  private.has_tenant_branch_access(tenant_id,branch_id,null)
  or (enrolment_id is not null and exists (
    select 1 from public.scheme_enrolments e
    where e.tenant_id=receipts.tenant_id and e.id=receipts.enrolment_id
      and private.is_linked_customer(e.tenant_id,e.customer_id)
  ))
  or (payment_id is not null and exists (
    select 1 from public.payments p
    where p.tenant_id=receipts.tenant_id and p.id=receipts.payment_id
      and p.customer_id is not null
      and private.is_linked_customer(p.tenant_id,p.customer_id)
  ))
);

-- Customers link their own profile only after Supabase has verified the account phone.
-- They pass the tenant id, not an arbitrary customer id; profile selection is by verified mobile.
create or replace function private.link_my_customer_profile(p_tenant_id uuid)
returns uuid
language plpgsql security definer set search_path=public,private,pg_temp as $$
declare
 v_user uuid:=auth.uid(); v_phone text; v_phone_confirmed timestamptz;
 v_customer_id uuid; v_existing_user uuid;
begin
 if v_user is null then raise exception 'Authentication required' using errcode='42501'; end if;
 select phone,phone_confirmed_at into v_phone,v_phone_confirmed from auth.users where id=v_user;
 if v_phone is null or v_phone_confirmed is null then
   raise exception 'A verified mobile number is required to link your customer profile' using errcode='42501';
 end if;

 select c.id into v_customer_id
 from public.tenant_customers c
 where c.tenant_id=p_tenant_id and c.status='active'
   and regexp_replace(c.mobile_e164,'[^0-9]','','g')=regexp_replace(v_phone,'[^0-9]','','g')
 for update;
 if not found then raise exception 'No active customer profile for your verified mobile number was found in this shop'; end if;

 select auth_user_id into v_existing_user from public.customer_auth_links
 where tenant_id=p_tenant_id and customer_id=v_customer_id for update;
 if found then
   if v_existing_user<>v_user then raise exception 'This customer profile is already linked to another account' using errcode='42501'; end if;
   return v_customer_id;
 end if;
 if exists(select 1 from public.customer_auth_links where tenant_id=p_tenant_id and auth_user_id=v_user) then
   raise exception 'Your account is already linked to another customer profile for this shop' using errcode='42501';
 end if;

 insert into public.customer_auth_links(tenant_id,customer_id,auth_user_id,verified_at)
 values(p_tenant_id,v_customer_id,v_user,now());
 insert into public.audit_logs(tenant_id,actor_user_id,event_name,entity_type,entity_id,details)
 values(p_tenant_id,v_user,'customer.profile_linked','tenant_customer',v_customer_id::text,
   jsonb_build_object('method','verified_phone','phone_confirmed_at',v_phone_confirmed));
 return v_customer_id;
end;
$$;
revoke execute on function private.link_my_customer_profile(uuid) from public,anon;
grant execute on function private.link_my_customer_profile(uuid) to authenticated;

create or replace function public.link_my_customer_profile(p_tenant_id uuid)
returns uuid language sql security invoker set search_path=public,private,pg_temp
as $$ select private.link_my_customer_profile(p_tenant_id); $$;
revoke execute on function public.link_my_customer_profile(uuid) from public,anon;
grant execute on function public.link_my_customer_profile(uuid) to authenticated;

-- This table is system-owned; customer links are created by the verified-phone workflow only.
revoke insert,update,delete on public.customer_auth_links from public,anon,authenticated;
grant select on public.customer_auth_links to authenticated;

commit;
