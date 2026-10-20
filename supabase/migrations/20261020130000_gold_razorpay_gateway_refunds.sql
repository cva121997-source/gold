begin;

alter table public.refunds add column if not exists provider_idempotency_key text;
create unique index if not exists refunds_tenant_provider_idempotency_uidx
  on public.refunds(tenant_id,provider_idempotency_key) where provider_idempotency_key is not null;

create or replace function public.begin_razorpay_gateway_refund(p_tenant_id uuid,p_refund_id uuid)
returns jsonb language plpgsql security definer set search_path=public,private,pg_temp as $$
declare v_user uuid:=auth.uid(); v_refund public.refunds%rowtype; v_payment public.payments%rowtype; v_key text;
begin
 if v_user is null then raise exception 'Authentication required' using errcode='42501'; end if;
 if not private.has_tenant_role(p_tenant_id,array['owner','manager','accountant']) then raise exception 'Permission denied' using errcode='42501'; end if;
 select * into v_refund from public.refunds where tenant_id=p_tenant_id and id=p_refund_id for update;
 if not found then raise exception 'Refund request not found for this shop'; end if;
 if v_refund.status not in ('approved','processing') then raise exception 'Only an approved or already-processing gateway refund can be submitted or retried'; end if;
 select * into v_payment from public.payments where tenant_id=p_tenant_id and id=v_refund.payment_id for update;
 if not found or v_payment.status<>'confirmed' then raise exception 'Original confirmed payment was not found'; end if;
 if lower(coalesce(v_payment.provider,''))<>'razorpay' or lower(coalesce(v_payment.payment_method,'')) not in ('gateway','razorpay','card') then raise exception 'This refund does not belong to a Razorpay gateway payment'; end if;
 if v_payment.provider_payment_ref is null or v_payment.provider_payment_ref !~ '^pay_[A-Za-z0-9]+$' then raise exception 'Original Razorpay payment reference is missing or invalid'; end if;
 if v_payment.currency<>'INR' or v_refund.amount<1 then raise exception 'Razorpay refund amount must be at least ₹1 and the payment currency must be INR'; end if;
 v_key:=v_refund.provider_idempotency_key;
 if v_refund.status='approved' then
  v_key:='gold_refund_'||replace(gen_random_uuid()::text,'-','');
  update public.refunds set status='processing',provider_idempotency_key=v_key,updated_at=now(),decline_reason=null where tenant_id=p_tenant_id and id=p_refund_id;
  insert into public.audit_logs(tenant_id,actor_user_id,event_name,entity_type,entity_id,details)
  values(p_tenant_id,v_user,'refund.gateway_submission_started','refund',p_refund_id::text,jsonb_build_object('payment_id',v_payment.id,'amount',v_refund.amount,'provider','razorpay'));
 elsif v_key is null then raise exception 'The existing processing refund has no idempotency key; review manually before retrying';
 end if;
 return jsonb_build_object('refund_id',v_refund.id,'provider_payment_ref',v_payment.provider_payment_ref,'amount_paise',round(v_refund.amount*100)::bigint,'currency',v_payment.currency,'idempotency_key',v_key,'provider_ref',v_refund.provider_ref,'status','processing');
end; $$;

create or replace function public.record_razorpay_gateway_refund_result(
 p_tenant_id uuid,p_refund_id uuid,p_provider_ref text,p_provider_status text,
 p_external_reference text default null,p_safe_error text default null
) returns jsonb language plpgsql security definer set search_path=public,private,pg_temp as $$
declare v_user uuid:=auth.uid(); v_refund public.refunds%rowtype; v_payment public.payments%rowtype; v_next text;
begin
 if v_user is null then raise exception 'Authentication required' using errcode='42501'; end if;
 if not private.has_tenant_role(p_tenant_id,array['owner','manager','accountant']) then raise exception 'Permission denied' using errcode='42501'; end if;
 select * into v_refund from public.refunds where tenant_id=p_tenant_id and id=p_refund_id for update;
 if not found then raise exception 'Refund request not found'; end if;
 select * into v_payment from public.payments where tenant_id=p_tenant_id and id=v_refund.payment_id for update;
 if not found or lower(coalesce(v_payment.provider,''))<>'razorpay' or v_payment.provider_payment_ref !~ '^pay_[A-Za-z0-9]+$' then raise exception 'Razorpay payment reference is not valid for this refund'; end if;
 if v_refund.status not in ('processing','completed','failed') then raise exception 'Gateway refund has not been authorized for submission'; end if;
 if p_provider_ref is not null and p_provider_ref !~ '^rfnd_[A-Za-z0-9]+$' then raise exception 'Razorpay refund reference is invalid'; end if;
 if v_refund.provider_ref like 'rfnd_%' and p_provider_ref is not null and v_refund.provider_ref<>p_provider_ref then raise exception 'A different Razorpay refund is already linked to this request'; end if;
 v_next:=case when p_provider_status='processed' then 'completed' when p_provider_status='failed' then 'failed' else 'processing' end;
 if v_refund.status='completed' then v_next:='completed'; end if;
 if v_refund.status='failed' and v_next='processing' then v_next:='failed'; end if;
 update public.refunds set status=v_next,provider_ref=coalesce(p_provider_ref,provider_ref),
  external_reference=coalesce(nullif(trim(coalesce(p_external_reference,'')),''),external_reference),
  completed_at=case when v_next='completed' then coalesce(completed_at,now()) else completed_at end,
  decline_reason=case when v_next='failed' then coalesce(nullif(left(trim(coalesce(p_safe_error,'')),240),''),'Razorpay reported refund failure.') else null end,
  updated_at=now() where tenant_id=p_tenant_id and id=p_refund_id;
 if v_next='completed' and v_refund.status<>'completed' then
  insert into public.financial_adjustments(tenant_id,payment_id,adjustment_type,amount,reason,approved_by,approved_at,created_by)
  values(p_tenant_id,v_payment.id,'refund',v_refund.amount,'Verified Razorpay refund: '||coalesce(p_provider_ref,v_refund.provider_ref,'provider confirmed'),v_user,now(),v_user);
 end if;
 insert into public.audit_logs(tenant_id,actor_user_id,event_name,entity_type,entity_id,details)
 values(p_tenant_id,v_user,'refund.gateway_provider_update','refund',p_refund_id::text,
  jsonb_build_object('provider','razorpay','provider_ref',coalesce(p_provider_ref,v_refund.provider_ref),'provider_status',p_provider_status,'stored_status',v_next,'external_reference',p_external_reference,'safe_error',case when v_next='failed' then left(coalesce(p_safe_error,''),240) else null end));
 return jsonb_build_object('refund_id',p_refund_id,'status',v_next);
end; $$;

create or replace function public.process_razorpay_refund_webhook_event(
 p_provider_event_id text,p_event_type text,p_refund_ref text,p_payment_ref text,
 p_amount_paise bigint,p_currency text,p_refund_status text,p_payload_hash text,p_safe_payload jsonb
) returns jsonb language plpgsql security definer set search_path=public,private,pg_temp as $$
declare
 v_event_id uuid; v_event public.payment_webhook_events%rowtype; v_refund public.refunds%rowtype;
 v_payment public.payments%rowtype; v_refund_id uuid; v_matches integer; v_next text;
 v_existing_status text; v_external text;
begin
 if nullif(trim(coalesce(p_provider_event_id,'')),'') is null or nullif(trim(coalesce(p_event_type,'')),'') is null then raise exception 'Provider refund event ID and type are required'; end if;
 if p_event_type not in ('refund.created','refund.processed','refund.failed','refund.speed_changed') then raise exception 'Unsupported Razorpay refund event type'; end if;
 if nullif(trim(coalesce(p_refund_ref,'')),'') is null or nullif(trim(coalesce(p_payment_ref,'')),'') is null or p_amount_paise is null or p_amount_paise<=0 or p_currency is distinct from 'INR' then raise exception 'Refund webhook is missing valid ID, payment, INR amount or currency'; end if;

 insert into public.payment_webhook_events(provider,provider_event_id,event_type,payload_hash,safe_payload,signature_verified)
 values('razorpay',trim(p_provider_event_id),trim(p_event_type),p_payload_hash,coalesce(p_safe_payload,'{}'::jsonb),true)
 on conflict(provider,provider_event_id) do nothing returning id into v_event_id;
 if v_event_id is null then
  select * into v_event from public.payment_webhook_events where provider='razorpay' and provider_event_id=trim(p_provider_event_id) for update;
  if not found then raise exception 'Could not find previously recorded Razorpay refund event'; end if;
  if v_event.event_type<>p_event_type then raise exception 'Razorpay event ID was reused with a different event type'; end if;
  if v_event.processed_at is not null then return jsonb_build_object('status','duplicate_event'); end if;
  v_event_id:=v_event.id;
 end if;

 select count(*) into v_matches
 from public.refunds r join public.payments p on p.tenant_id=r.tenant_id and p.id=r.payment_id
 where p.provider='razorpay' and p.provider_payment_ref=trim(p_payment_ref) and r.amount=round(p_amount_paise::numeric/100,2)
  and (r.provider_ref=trim(p_refund_ref) or (r.provider_ref is null and r.status in ('approved','processing')))
  and p.currency=p_currency;
 if v_matches<>1 then
  update public.payment_webhook_events set processing_error=case when v_matches=0 then 'No matching authorized refund found yet' else 'Multiple refunds match payment and amount; manual review required' end where id=v_event_id;
  return jsonb_build_object('status',case when v_matches=0 then 'unmatched_refund' else 'ambiguous_refund' end);
 end if;

 select r.id into v_refund_id from public.refunds r join public.payments p on p.tenant_id=r.tenant_id and p.id=r.payment_id
 where p.provider='razorpay' and p.provider_payment_ref=trim(p_payment_ref) and r.amount=round(p_amount_paise::numeric/100,2)
  and (r.provider_ref=trim(p_refund_ref) or (r.provider_ref is null and r.status in ('approved','processing')))
  and p.currency=p_currency limit 1 for update of r,p;
 if v_refund_id is null then update public.payment_webhook_events set processing_error='Refund candidate changed while processing' where id=v_event_id; return jsonb_build_object('status','unmatched_refund'); end if;
 select * into v_refund from public.refunds where id=v_refund_id;
 select * into v_payment from public.payments where tenant_id=v_refund.tenant_id and id=v_refund.payment_id;
 if v_refund.provider_ref is not null and v_refund.provider_ref<>trim(p_refund_ref) then
  update public.payment_webhook_events set processing_error='Provider refund ID does not match the reserved request' where id=v_event_id;
  return jsonb_build_object('status','refund_reference_conflict');
 end if;

 v_existing_status:=v_refund.status;
 v_next:=case when p_event_type='refund.processed' then 'completed' when p_event_type='refund.failed' then 'failed'
  when v_refund.status in ('completed','failed') then v_refund.status else 'processing' end;
 v_external:=nullif(trim(coalesce(p_safe_payload->>'arn','')),'');
 update public.refunds set status=v_next,provider_ref=trim(p_refund_ref),external_reference=coalesce(v_external,external_reference),
  completed_at=case when v_next='completed' then coalesce(completed_at,now()) else completed_at end,
  decline_reason=case when v_next='failed' then coalesce(nullif(left(trim(coalesce(p_safe_payload->>'failure_reason','')),240),''),'Razorpay reported refund failure.') else null end,
  updated_at=now() where tenant_id=v_refund.tenant_id and id=v_refund.id;
 if v_next='completed' and v_existing_status<>'completed' then
  insert into public.financial_adjustments(tenant_id,payment_id,adjustment_type,amount,reason,approved_by,approved_at,created_by)
  values(v_refund.tenant_id,v_payment.id,'refund',v_refund.amount,'Verified Razorpay refund: '||trim(p_refund_ref),null,now(),null);
 end if;
 insert into public.audit_logs(tenant_id,actor_user_id,event_name,entity_type,entity_id,details)
 values(v_refund.tenant_id,null,'refund.gateway_webhook_processed','refund',v_refund.id::text,
  jsonb_build_object('provider','razorpay','event_id',p_provider_event_id,'event_type',p_event_type,'provider_ref',p_refund_ref,'payment_ref',p_payment_ref,'amount',v_refund.amount,'previous_status',v_existing_status,'status',v_next));
 update public.payment_webhook_events set processed_at=now(),processing_error=null where id=v_event_id;
 return jsonb_build_object('status',v_next,'refund_id',v_refund.id);
end; $$;

revoke all on function public.begin_razorpay_gateway_refund(uuid,uuid) from public,anon;
revoke all on function public.record_razorpay_gateway_refund_result(uuid,uuid,text,text,text,text) from public,anon;
revoke all on function public.process_razorpay_refund_webhook_event(text,text,text,text,bigint,text,text,text,jsonb) from public,anon,authenticated;
grant execute on function public.begin_razorpay_gateway_refund(uuid,uuid) to authenticated;
grant execute on function public.record_razorpay_gateway_refund_result(uuid,uuid,text,text,text,text) to authenticated;
grant execute on function public.process_razorpay_refund_webhook_event(text,text,text,text,bigint,text,text,text,jsonb) to service_role;

update public.payment_webhook_events set processed_at=null,processing_error='Pending refund workflow association after deployment'
where provider='razorpay' and event_type in ('refund.created','refund.processed','refund.failed','refund.speed_changed') and processed_at is not null;
commit;