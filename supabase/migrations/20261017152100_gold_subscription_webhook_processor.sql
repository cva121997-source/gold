begin;

create or replace function public.apply_razorpay_subscription_event(
  p_subscription_ref text,
  p_status text,
  p_event_at timestamptz,
  p_period_start timestamptz default null,
  p_period_end timestamptz default null,
  p_cancel_at_period_end boolean default null,
  p_customer_ref text default null
) returns uuid
language plpgsql
security definer
set search_path=public,private,pg_temp
as $$
declare
  v_subscription public.tenant_subscriptions%rowtype;
  v_plan public.subscription_plans%rowtype;
  v_ent record;
  v_enabled boolean;
  v_limit integer;
  v_event_at timestamptz:=coalesce(p_event_at,now());
begin
  if coalesce(auth.role(),'') <> 'service_role' then
    raise exception 'Service role required' using errcode='42501';
  end if;
  if nullif(trim(coalesce(p_subscription_ref,'')),'') is null then raise exception 'Subscription reference is required'; end if;
  if p_status not in ('pending','active','past_due','cancelled','suspended') then raise exception 'Unsupported subscription status'; end if;

  select * into v_subscription from public.tenant_subscriptions
   where provider='razorpay' and provider_subscription_ref=p_subscription_ref
   for update;
  if not found then return null; end if;

  if v_subscription.latest_provider_event_at is not null and v_event_at < v_subscription.latest_provider_event_at then
    return v_subscription.id; -- older, replayed events must not roll status backwards
  end if;

  update public.tenant_subscriptions
    set status=p_status,
        current_period_start=coalesce(p_period_start,current_period_start),
        current_period_end=coalesce(p_period_end,current_period_end),
        cancel_at_period_end=coalesce(p_cancel_at_period_end,cancel_at_period_end),
        provider_customer_ref=coalesce(nullif(trim(coalesce(p_customer_ref,'')),''),provider_customer_ref),
        latest_provider_event_at=v_event_at,
        updated_at=now()
    where id=v_subscription.id
    returning * into v_subscription;

  select * into v_plan from public.subscription_plans where id=v_subscription.plan_id;

  if p_status in ('active','trial') and found then
    for v_ent in select key,value from jsonb_each(coalesce(v_plan.entitlements,'{}'::jsonb))
    loop
      if jsonb_typeof(v_ent.value)='boolean' then
        v_enabled:=(v_ent.value::text)::boolean;
        v_limit:=null;
      elsif jsonb_typeof(v_ent.value)='number' then
        v_limit:=case when v_ent.value::text ~ '^-?[0-9]+$' then (v_ent.value::text)::integer else null end;
        v_enabled:=v_limit is null or v_limit>0;
      elsif jsonb_typeof(v_ent.value)='null' then
        v_enabled:=true; v_limit:=null;
      else
        v_enabled:=false; v_limit:=null;
      end if;
      insert into public.feature_entitlements(tenant_id,feature_key,enabled,limit_value,configuration,updated_by,updated_at)
      values(v_subscription.tenant_id,v_ent.key,v_enabled,v_limit,
        jsonb_build_object('source','subscription_plan','plan_id',v_subscription.plan_id,'plan_value',v_ent.value),null,now())
      on conflict(tenant_id,feature_key) do update set enabled=excluded.enabled,limit_value=excluded.limit_value,
        configuration=excluded.configuration,updated_by=null,updated_at=now();
    end loop;
  elsif p_status in ('cancelled','suspended') then
    update public.feature_entitlements set enabled=false,updated_by=null,updated_at=now()
      where tenant_id=v_subscription.tenant_id;
  end if;

  insert into public.audit_logs(tenant_id,actor_user_id,event_name,entity_type,entity_id,details)
  values(v_subscription.tenant_id,null,'subscription.provider_status_changed','tenant_subscription',v_subscription.id::text,
    jsonb_build_object('status',p_status,'provider','razorpay','provider_subscription_ref',p_subscription_ref,
      'event_at',v_event_at,'period_start',v_subscription.current_period_start,'period_end',v_subscription.current_period_end,
      'cancel_at_period_end',v_subscription.cancel_at_period_end));
  return v_subscription.id;
end;
$$;

revoke all on function public.apply_razorpay_subscription_event(text,text,timestamptz,timestamptz,timestamptz,boolean,text) from public,anon,authenticated;
grant execute on function public.apply_razorpay_subscription_event(text,text,timestamptz,timestamptz,timestamptz,boolean,text) to service_role;

commit;