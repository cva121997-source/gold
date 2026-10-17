-- Platform administration and staff access workflows.
begin;

-- Shop owners/managers can see display names of members in their tenant, never credentials.
drop policy if exists profiles_read_same_tenant_staff on public.profiles;
create policy profiles_read_same_tenant_staff on public.profiles
for select to authenticated using (
 id=(select auth.uid())
 or exists(
   select 1 from public.tenant_memberships target
   where target.user_id=profiles.id
     and private.has_tenant_role(target.tenant_id,array['owner','manager'])
 )
);

-- Membership writes happen only through trusted invitation acceptance and this checked RPC.
revoke insert,update,delete on public.tenant_memberships from public,anon,authenticated;
grant select on public.tenant_memberships to authenticated;
create or replace function private.set_staff_membership_active(p_tenant_id uuid,p_membership_id uuid,p_is_active boolean)
returns void language plpgsql security definer set search_path=public,private,pg_temp as $$
declare v_user uuid:=auth.uid();v_target public.tenant_memberships%rowtype;
begin
 if v_user is null then raise exception 'Authentication required' using errcode='42501';end if;
 if not private.has_tenant_role(p_tenant_id,array['owner','manager']) then raise exception 'Only a shop owner or manager can change staff access' using errcode='42501';end if;
 select * into v_target from public.tenant_memberships where tenant_id=p_tenant_id and id=p_membership_id for update;
 if not found then raise exception 'Staff membership not found';end if;
 if v_target.role='owner' then raise exception 'Owner membership cannot be deactivated with this workflow';end if;
 if v_target.user_id=v_user then raise exception 'Use a separate manager to deactivate your own access';end if;
 update public.tenant_memberships set is_active=p_is_active,updated_at=now() where tenant_id=p_tenant_id and id=p_membership_id;
 insert into public.audit_logs(tenant_id,actor_user_id,event_name,entity_type,entity_id,details)
 values(p_tenant_id,v_user,case when p_is_active then 'staff.membership_activated' else 'staff.membership_deactivated' end,
 'tenant_membership',p_membership_id::text,jsonb_build_object('target_user_id',v_target.user_id,'role',v_target.role));
end;
$$;
revoke execute on function private.set_staff_membership_active(uuid,uuid,boolean) from public,anon;
grant execute on function private.set_staff_membership_active(uuid,uuid,boolean) to authenticated;
create or replace function public.set_staff_membership_active(p_tenant_id uuid,p_membership_id uuid,p_is_active boolean)
returns void language plpgsql security invoker set search_path=public,private,pg_temp as $$
begin perform private.set_staff_membership_active(p_tenant_id,p_membership_id,p_is_active);end;
$$;
revoke execute on function public.set_staff_membership_active(uuid,uuid,boolean) from public,anon;
grant execute on function public.set_staff_membership_active(uuid,uuid,boolean) to authenticated;

-- Server-side platform admin onboarding operation. Its wrapper is service-role-only.
create or replace function private.platform_admin_create_tenant(
 p_actor_user_id uuid,p_owner_user_id uuid,p_display_name text,p_legal_name text,p_slug text,
 p_state text,p_district text,p_city text,p_locality text
)
returns uuid language plpgsql security definer set search_path=public,private,pg_temp as $$
declare v_tenant uuid;v_branch uuid;v_plan uuid;v_slug text:=lower(trim(p_slug));
begin
 if not exists(select 1 from public.platform_admins where user_id=p_actor_user_id and admin_role in ('platform_owner','platform_admin')) then
   raise exception 'Platform administrator permission is required' using errcode='42501';
 end if;
 if p_owner_user_id is null or not exists(select 1 from auth.users where id=p_owner_user_id) then raise exception 'Invited shop owner user does not exist';end if;
 if length(trim(coalesce(p_display_name,'')))<2 then raise exception 'Shop display name is required';end if;
 if v_slug !~ '^[a-z0-9]+(-[a-z0-9]+)*$' or length(v_slug)>60 then raise exception 'Shop URL slug format is invalid';end if;
 insert into public.tenants(code,slug,display_name,legal_name,state,district,city,locality,status)
 values(upper(substr(replace(gen_random_uuid()::text,'-',''),1,8)),v_slug,trim(p_display_name),nullif(trim(p_legal_name),''),nullif(trim(p_state),''),nullif(trim(p_district),''),nullif(trim(p_city),''),nullif(trim(p_locality),''),'trial')
 returning id into v_tenant;
 insert into public.branches(tenant_id,branch_code,name,state,district,city,locality,is_default)
 values(v_tenant,'MAIN','Main Branch',nullif(trim(p_state),''),nullif(trim(p_district),''),nullif(trim(p_city),''),nullif(trim(p_locality),''),true)
 returning id into v_branch;
 insert into public.tenant_memberships(tenant_id,user_id,branch_id,role,is_active)
 values(v_tenant,p_owner_user_id,v_branch,'owner',true);
 insert into public.tenant_settings(tenant_id) values(v_tenant);
 select id into v_plan from public.subscription_plans where code='starter' and is_active limit 1;
 insert into public.tenant_subscriptions(tenant_id,plan_id,status,trial_ends_at,current_period_start,current_period_end)
 values(v_tenant,v_plan,'trial',now()+interval '14 days',now(),now()+interval '14 days');
 insert into public.audit_logs(tenant_id,actor_user_id,event_name,entity_type,entity_id,details)
 values(v_tenant,p_actor_user_id,'platform.tenant_created','tenant',v_tenant::text,jsonb_build_object('owner_user_id',p_owner_user_id,'source','platform_admin','trial_days',14));
 return v_tenant;
end;
$$;
revoke execute on function private.platform_admin_create_tenant(uuid,uuid,text,text,text,text,text,text,text) from public,anon,authenticated;
grant execute on function private.platform_admin_create_tenant(uuid,uuid,text,text,text,text,text,text,text) to service_role;
grant usage on schema private to service_role;
create or replace function public.platform_admin_create_tenant(p_actor_user_id uuid,p_owner_user_id uuid,p_display_name text,p_legal_name text,p_slug text,p_state text,p_district text,p_city text,p_locality text)
returns uuid language sql security invoker set search_path=public,private,pg_temp
as $$ select private.platform_admin_create_tenant(p_actor_user_id,p_owner_user_id,p_display_name,p_legal_name,p_slug,p_state,p_district,p_city,p_locality); $$;
revoke execute on function public.platform_admin_create_tenant(uuid,uuid,text,text,text,text,text,text,text) from public,anon,authenticated;
grant execute on function public.platform_admin_create_tenant(uuid,uuid,text,text,text,text,text,text,text) to service_role;

commit;
