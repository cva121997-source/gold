begin;

create or replace function private.update_scheme_draft(
  p_tenant_id uuid,
  p_scheme_id uuid,
  p_name text,
  p_description text,
  p_scheme_type text,
  p_terms jsonb
) returns uuid
language plpgsql
security definer
set search_path=public,private,pg_temp
as $$
declare
  v_user uuid:=auth.uid();
  v_role text;
  v_branch uuid;
  v_scheme public.scheme_templates%rowtype;
  v_next_version integer;
  v_version_id uuid;
  v_terms jsonb;
begin
  if v_user is null then raise exception 'Authentication required' using errcode='42501'; end if;
  select role,branch_id into v_role,v_branch
    from public.tenant_memberships where tenant_id=p_tenant_id and user_id=v_user and is_active;
  if v_role is null or v_role not in ('owner','manager','scheme_manager') then
    raise exception 'Permission denied' using errcode='42501';
  end if;
  if length(trim(coalesce(p_name,'')))<2 then raise exception 'Scheme name is required'; end if;
  if p_scheme_type not in ('flexible_gold_weight','fixed_monthly','custom') then raise exception 'Unsupported scheme type'; end if;
  if p_terms is null or jsonb_typeof(p_terms)<>'object' then raise exception 'Scheme terms must be a JSON object'; end if;
  if p_scheme_type='fixed_monthly' then
    if coalesce((p_terms->>'tenure_months')::integer,0) not between 1 and 120 then
      raise exception 'Monthly scheme tenure must be between 1 and 120 months';
    end if;
    if coalesce((p_terms->>'monthly_instalment_inr')::numeric,0)<=0 then
      raise exception 'Monthly instalment must be greater than zero';
    end if;
    if coalesce(p_terms->>'benefit_type','none') not in
       ('gold_weight_bonus','jewellery_purchase_credit','making_charge_discount','custom','none','one_instalment_equivalent') then
      raise exception 'Choose a supported benefit type';
    end if;
    if p_terms->>'benefit_type'='one_instalment_equivalent'
       and coalesce((p_terms->>'benefit_equivalent_monthly_instalments')::numeric,1)<=0 then
      raise exception 'One-instalment-equivalent benefit multiplier must be positive';
    end if;
  end if;

  select * into v_scheme from public.scheme_templates
    where tenant_id=p_tenant_id and id=p_scheme_id for update;
  if not found then raise exception 'Scheme not found for this shop'; end if;
  if v_scheme.status='retired' then raise exception 'Retired schemes cannot be edited; duplicate into a new draft instead'; end if;
  if v_role='scheme_manager' then
    if not private.has_tenant_branch_access(p_tenant_id,v_branch,array['scheme_manager']) then
      raise exception 'Permission denied' using errcode='42501';
    end if;
    if v_scheme.branch_id is distinct from v_branch then raise exception 'A scheme manager can edit only schemes assigned to their branch'; end if;
  elsif v_scheme.branch_id is not null and not private.has_tenant_branch_access(p_tenant_id,v_scheme.branch_id,array['owner','manager']) then
    raise exception 'Branch access denied' using errcode='42501';
  end if;

  v_next_version:=v_scheme.current_version+1;
  v_terms:=p_terms||jsonb_build_object(
    'requires_owner_review',true,
    'customer_terms_approved',false,
    'owner_reviewed',false,
    'supersedes_version',v_scheme.current_version
  );

  insert into public.scheme_versions(
    tenant_id,scheme_id,version_no,terms,terms_markdown,created_by
  ) values (
    p_tenant_id,p_scheme_id,v_next_version,v_terms,
    coalesce(nullif(trim(coalesce(p_description,'')),''),'Scheme terms require shop owner review.'),
    v_user
  ) returning id into v_version_id;

  update public.scheme_templates set
    name=trim(p_name),description=nullif(trim(coalesce(p_description,'')),''),
    scheme_type=p_scheme_type,current_version=v_next_version,status='draft',updated_at=now()
  where tenant_id=p_tenant_id and id=p_scheme_id;

  insert into public.audit_logs(tenant_id,actor_user_id,event_name,entity_type,entity_id,details)
  values(p_tenant_id,v_user,'scheme.version_draft_created','scheme',p_scheme_id::text,
    jsonb_build_object('version',v_next_version,'previous_version',v_scheme.current_version,
      'previous_status',v_scheme.status,'scheme_type',p_scheme_type,'version_id',v_version_id));
  return v_version_id;
end;
$$;

create or replace function private.set_scheme_lifecycle(
  p_tenant_id uuid,
  p_scheme_id uuid,
  p_action text
) returns text
language plpgsql
security definer
set search_path=public,private,pg_temp
as $$
declare
  v_user uuid:=auth.uid();
  v_scheme public.scheme_templates%rowtype;
  v_version public.scheme_versions%rowtype;
  v_new_status text;
begin
  if v_user is null then raise exception 'Authentication required' using errcode='42501'; end if;
  if not private.has_tenant_role(p_tenant_id,array['owner','manager']) then
    raise exception 'Permission denied' using errcode='42501';
  end if;
  if p_action not in ('pause','resume','retire') then raise exception 'Action must be pause, resume or retire'; end if;
  select * into v_scheme from public.scheme_templates
    where tenant_id=p_tenant_id and id=p_scheme_id for update;
  if not found then raise exception 'Scheme not found'; end if;

  if p_action='pause' then
    if v_scheme.status<>'published' then raise exception 'Only a published scheme can be paused'; end if;
    v_new_status:='paused';
  elsif p_action='resume' then
    if v_scheme.status<>'paused' then raise exception 'Only a paused scheme can be resumed'; end if;
    select * into v_version from public.scheme_versions
      where tenant_id=p_tenant_id and scheme_id=p_scheme_id and version_no=v_scheme.current_version;
    if not found or v_version.reviewed_at is null or v_version.effective_from is null
      or coalesce((v_version.terms->>'owner_reviewed')::boolean,false) is not true
      or coalesce((v_version.terms->>'customer_terms_approved')::boolean,false) is not true then
      raise exception 'The current scheme version must be owner-reviewed and published before resume';
    end if;
    v_new_status:='published';
  else
    if v_scheme.status='retired' then raise exception 'Scheme is already retired'; end if;
    v_new_status:='retired';
  end if;

  update public.scheme_templates set status=v_new_status,updated_at=now()
    where tenant_id=p_tenant_id and id=p_scheme_id;
  insert into public.audit_logs(tenant_id,actor_user_id,event_name,entity_type,entity_id,details)
  values(p_tenant_id,v_user,'scheme.lifecycle_changed','scheme',p_scheme_id::text,
    jsonb_build_object('previous_status',v_scheme.status,'new_status',v_new_status,'action',p_action,'version',v_scheme.current_version));
  return v_new_status;
end;
$$;

create or replace function public.update_scheme_draft(
  p_tenant_id uuid,p_scheme_id uuid,p_name text,p_description text,p_scheme_type text,p_terms jsonb
) returns uuid
language sql
security invoker
set search_path=public,private,pg_temp
as $$ select private.update_scheme_draft(p_tenant_id,p_scheme_id,p_name,p_description,p_scheme_type,p_terms); $$;

create or replace function public.set_scheme_lifecycle(
  p_tenant_id uuid,p_scheme_id uuid,p_action text
) returns text
language sql
security invoker
set search_path=public,private,pg_temp
as $$ select private.set_scheme_lifecycle(p_tenant_id,p_scheme_id,p_action); $$;

revoke all on function private.update_scheme_draft(uuid,uuid,text,text,text,jsonb) from public,anon,authenticated;
revoke all on function private.set_scheme_lifecycle(uuid,uuid,text) from public,anon,authenticated;
revoke all on function public.update_scheme_draft(uuid,uuid,text,text,text,jsonb) from public,anon;
revoke all on function public.set_scheme_lifecycle(uuid,uuid,text) from public,anon;
grant execute on function public.update_scheme_draft(uuid,uuid,text,text,text,jsonb) to authenticated;
grant execute on function public.set_scheme_lifecycle(uuid,uuid,text) to authenticated;

commit;