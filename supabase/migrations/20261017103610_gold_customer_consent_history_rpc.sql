begin;

create or replace function public.record_customer_consent(
  p_tenant_id uuid,
  p_branch_id uuid,
  p_customer_id uuid,
  p_consent_type text,
  p_consented boolean,
  p_terms_version text default null,
  p_source text default 'staff_entry',
  p_metadata jsonb default '{}'::jsonb
) returns uuid
language plpgsql security definer
set search_path=public,private,pg_temp
as $$
declare
  v_user uuid:=auth.uid();
  v_id uuid;
  v_allowed text[]:=array['privacy_notice','scheme_terms','sms','whatsapp','email','promotional','data_processing'];
begin
  if v_user is null then raise exception 'Authentication required' using errcode='42501'; end if;
  if p_consent_type is null or not (p_consent_type=any(v_allowed)) then raise exception 'Invalid consent type'; end if;
  if p_consented is null then raise exception 'A consent decision is required'; end if;
  if p_source not in ('staff_entry','customer_portal','signed_form','phone','email','website','import') then
    raise exception 'Invalid consent source';
  end if;
  if not private.has_tenant_branch_access(p_tenant_id,p_branch_id,array['owner','manager','accountant','cashier','scheme_manager','employee']) then
    raise exception 'Permission denied' using errcode='42501';
  end if;
  perform 1 from public.tenant_customers c
    where c.tenant_id=p_tenant_id and c.id=p_customer_id and c.status='active'
      and private.has_tenant_branch_access(p_tenant_id,c.branch_id,array['owner','manager','accountant','cashier','scheme_manager','employee'])
    for update;
  if not found then raise exception 'Active customer not found or branch access denied'; end if;

  if not p_consented then
    update public.customer_consents set withdrawn_at=coalesce(withdrawn_at,now())
      where tenant_id=p_tenant_id and customer_id=p_customer_id and consent_type=p_consent_type
        and consented and withdrawn_at is null;
  end if;

  insert into public.customer_consents(
    tenant_id,customer_id,consent_type,consented,terms_version,source,captured_by,metadata,withdrawn_at
  ) values(
    p_tenant_id,p_customer_id,p_consent_type,p_consented,nullif(trim(coalesce(p_terms_version,'')),''),
    p_source,v_user,coalesce(p_metadata,'{}'::jsonb),case when p_consented then null else now() end
  ) returning id into v_id;

  insert into public.audit_logs(tenant_id,actor_user_id,event_name,entity_type,entity_id,details)
  values(p_tenant_id,v_user,case when p_consented then 'customer.consent_granted' else 'customer.consent_withdrawn' end,
    'customer_consent',v_id::text,jsonb_build_object('customer_id',p_customer_id,'consent_type',p_consent_type,
    'terms_version',p_terms_version,'source',p_source,'metadata',coalesce(p_metadata,'{}'::jsonb)));

  return v_id;
end;
$$;
revoke all on function public.record_customer_consent(uuid,uuid,uuid,text,boolean,text,text,jsonb) from public,anon;
grant execute on function public.record_customer_consent(uuid,uuid,uuid,text,boolean,text,text,jsonb) to authenticated;

commit;