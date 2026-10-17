begin;

create or replace function public.review_provider_gold_rate(
  p_tenant_id uuid,
  p_rate_id uuid,
  p_action text,
  p_publish boolean default false
) returns uuid
language plpgsql security definer
set search_path=public,private,pg_temp
as $$
declare
  v_user uuid:=auth.uid();
  v_rate public.gold_rates%rowtype;
  v_new_status text;
begin
  if v_user is null then raise exception 'Authentication required' using errcode='42501'; end if;
  if not private.has_tenant_role(p_tenant_id,array['owner','manager']) then
    raise exception 'Only a shop owner or manager can review provider rates' using errcode='42501';
  end if;
  if p_action not in ('verify','reject') then raise exception 'Action must be verify or reject'; end if;

  select * into v_rate from public.gold_rates
    where tenant_id=p_tenant_id and id=p_rate_id and source_type='provider'
    for update;
  if not found then raise exception 'Provider rate not found for this shop'; end if;
  if p_action='verify' then
    if v_rate.status not in ('indicative') then raise exception 'Only indicative provider rates can be verified'; end if;
    if v_rate.effective_at < now()-interval '36 hours' or (v_rate.expires_at is not null and v_rate.expires_at<=now()) then
      update public.gold_rates set status='stale',is_public=false where tenant_id=p_tenant_id and id=p_rate_id;
      raise exception 'Provider rate has expired or is older than 36 hours; it was marked stale';
    end if;
    v_new_status:='verified';
    update public.gold_rates set status=v_new_status,is_public=coalesce(p_publish,false),updated_by=v_user
      where tenant_id=p_tenant_id and id=p_rate_id;
  else
    v_new_status:='stale';
    update public.gold_rates set status=v_new_status,is_public=false,updated_by=v_user
      where tenant_id=p_tenant_id and id=p_rate_id;
  end if;

  insert into public.audit_logs(tenant_id,actor_user_id,event_name,entity_type,entity_id,details)
  values(p_tenant_id,v_user,'rate.provider_reviewed','gold_rate',p_rate_id::text,
    jsonb_build_object('action',p_action,'status',v_new_status,'published',case when p_action='verify' then coalesce(p_publish,false) else false end,
      'source_label',v_rate.source_label,'price_per_gram',v_rate.price_per_gram,'effective_at',v_rate.effective_at));
  return p_rate_id;
end;
$$;
revoke all on function public.review_provider_gold_rate(uuid,uuid,text,boolean) from public,anon;
grant execute on function public.review_provider_gold_rate(uuid,uuid,text,boolean) to authenticated;

commit;