-- Customer-friendly shop discovery for account linking and verification-aware staff invitation acceptance.
begin;

create or replace function private.link_my_customer_profile_by_slug(p_shop_slug text)
returns uuid language plpgsql security definer set search_path=public,private,pg_temp as $$
declare v_tenant_id uuid;
begin
 if auth.uid() is null then raise exception 'Authentication required' using errcode='42501'; end if;
 select id into v_tenant_id from public.tenants
 where lower(slug)=lower(trim(p_shop_slug)) and status in ('trial','active');
 if not found then raise exception 'No active shop was found for that shop URL'; end if;
 return private.link_my_customer_profile(v_tenant_id);
end;
$$;
revoke execute on function private.link_my_customer_profile_by_slug(text) from public,anon;
grant execute on function private.link_my_customer_profile_by_slug(text) to authenticated;
create or replace function public.link_my_customer_profile_by_slug(p_shop_slug text)
returns uuid language sql security invoker set search_path=public,private,pg_temp
as $$ select private.link_my_customer_profile_by_slug(p_shop_slug); $$;
revoke execute on function public.link_my_customer_profile_by_slug(text) from public,anon;
grant execute on function public.link_my_customer_profile_by_slug(text) to authenticated;

-- Enforce verified Supabase Auth contact channels during invitation redemption.
create or replace function private.accept_staff_invitation(p_token text)
returns uuid language plpgsql security definer set search_path=public,private,pg_temp as $$
declare
 v_user uuid:=auth.uid();
 v_auth_email text; v_auth_email_confirmed timestamptz;
 v_auth_phone text; v_auth_phone_confirmed timestamptz;
 v_inv public.staff_invitations%rowtype; v_membership uuid;
begin
 if v_user is null then raise exception 'Authentication required' using errcode='42501'; end if;
 select email,email_confirmed_at,phone,phone_confirmed_at
 into v_auth_email,v_auth_email_confirmed,v_auth_phone,v_auth_phone_confirmed
 from auth.users where id=v_user;

 select * into v_inv from public.staff_invitations
 where token_hash=encode(digest(p_token,'sha256'),'hex')
   and accepted_at is null and revoked_at is null and expires_at>now()
 for update;
 if not found then raise exception 'Invitation is invalid, expired or already used'; end if;

 if v_inv.invitee_email is not null then
   if v_auth_email_confirmed is null or lower(v_inv.invitee_email)<>lower(coalesce(v_auth_email,'')) then
     raise exception 'A verified email matching this invitation is required' using errcode='42501';
   end if;
 end if;
 if v_inv.invitee_mobile is not null then
   if v_auth_phone_confirmed is null or regexp_replace(v_inv.invitee_mobile,'[^0-9]','','g')<>regexp_replace(coalesce(v_auth_phone,''),'[^0-9]','','g') then
     raise exception 'A verified mobile number matching this invitation is required' using errcode='42501';
   end if;
 end if;
 if exists(select 1 from public.tenant_memberships where tenant_id=v_inv.tenant_id and user_id=v_user) then
   raise exception 'User is already a member of this shop';
 end if;
 insert into public.tenant_memberships(tenant_id,user_id,branch_id,role,permissions,is_active)
 values(v_inv.tenant_id,v_user,v_inv.branch_id,v_inv.role,v_inv.permissions,true) returning id into v_membership;
 update public.staff_invitations set accepted_by=v_user,accepted_at=now() where id=v_inv.id;
 insert into public.audit_logs(tenant_id,actor_user_id,event_name,entity_type,entity_id,details)
 values(v_inv.tenant_id,v_user,'staff.invitation_accepted','tenant_membership',v_membership::text,
 jsonb_build_object('role',v_inv.role,'branch_id',v_inv.branch_id));
 return v_membership;
end;
$$;
revoke execute on function private.accept_staff_invitation(text) from public,anon;
grant execute on function private.accept_staff_invitation(text) to authenticated;
create or replace function public.accept_staff_invitation(p_token text)
returns uuid language sql security invoker set search_path=public,private,pg_temp
as $$ select private.accept_staff_invitation(p_token); $$;
revoke execute on function public.accept_staff_invitation(text) from public,anon;
grant execute on function public.accept_staff_invitation(text) to authenticated;

commit;
