begin;

create or replace function public.begin_razorpay_gateway_refund(p_tenant_id uuid,p_refund_id uuid)
returns jsonb language plpgsql security definer set search_path=public,private,pg_temp as $$
declare
 v_user uuid:=auth.uid();
 v_refund public.refunds%rowtype;
 v_payment public.payments%rowtype;
 v_key text;
 v_submission_allowed boolean:=false;
begin
 if v_user is null then raise exception 'Authentication required' using errcode='42501'; end if;
 if not private.has_tenant_role(p_tenant_id,array['owner','manager','accountant']) then raise exception 'Permission denied' using errcode='42501'; end if;
 select * into v_refund from public.refunds where tenant_id=p_tenant_id and id=p_refund_id for update;
 if not found then raise exception 'Refund request not found for this shop'; end if;
 if v_refund.status not in ('approved','processing') then raise exception 'Only an approved or already-processing gateway refund can be submitted or reconciled'; end if;
 select * into v_payment from public.payments where tenant_id=p_tenant_id and id=v_refund.payment_id for update;
 if not found or v_payment.status<>'confirmed' then raise exception 'Original confirmed payment was not found'; end if;
 if lower(coalesce(v_payment.provider,''))<>'razorpay' or lower(coalesce(v_payment.payment_method,'')) not in ('gateway','razorpay','card') then raise exception 'This refund does not belong to a Razorpay gateway payment'; end if;
 if v_payment.provider_payment_ref is null or v_payment.provider_payment_ref !~ '^pay_[A-Za-z0-9]+$' then raise exception 'Original Razorpay payment reference is missing or invalid'; end if;
 if v_payment.currency<>'INR' or v_refund.amount<1 then raise exception 'Razorpay refund amount must be at least ₹1 and the payment currency must be INR'; end if;
 v_key:=v_refund.provider_idempotency_key;
 if v_refund.status='approved' then
  v_key:='gold_refund_'||replace(gen_random_uuid()::text,'-','');
  v_submission_allowed:=true;
  update public.refunds set status='processing',provider_idempotency_key=v_key,updated_at=now(),decline_reason=null where tenant_id=p_tenant_id and id=p_refund_id;
  insert into public.audit_logs(tenant_id,actor_user_id,event_name,entity_type,entity_id,details)
  values(p_tenant_id,v_user,'refund.gateway_submission_started','refund',p_refund_id::text,jsonb_build_object('payment_id',v_payment.id,'amount',v_refund.amount,'provider','razorpay'));
 elsif v_key is null then
  raise exception 'The existing processing refund has no idempotency key; review manually before retrying';
 end if;
 return jsonb_build_object(
  'refund_id',v_refund.id,'provider_payment_ref',v_payment.provider_payment_ref,
  'amount_paise',round(v_refund.amount*100)::bigint,'currency',v_payment.currency,
  'idempotency_key',v_key,'provider_ref',v_refund.provider_ref,
  'receipt','goldr'||replace(v_refund.id::text,'-',''),
  'submission_allowed',v_submission_allowed,'status','processing'
 );
end; $$;

create or replace function public.record_razorpay_gateway_refund_result(
 p_tenant_id uuid,p_refund_id uuid,p_provider_ref text,p_provider_status text,
 p_external_reference text default null,p_safe_error text default null
) returns jsonb language plpgsql security definer set search_path=public,private,pg_temp as $$
declare
 v_refund public.refunds%rowtype;
 v_payment public.payments%rowtype;
 v_next text;
begin
 -- This is an internal server-side RPC. Execution is revoked from authenticated users below.
 if p_provider_status not in ('pending','processed','failed') then raise exception 'Unsupported Razorpay refund status'; end if;
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
  values(p_tenant_id,v_payment.id,'refund',v_refund.amount,'Verified Razorpay refund: '||coalesce(p_provider_ref,v_refund.provider_ref,'provider confirmed'),null,now(),null);
 end if;
 insert into public.audit_logs(tenant_id,actor_user_id,event_name,entity_type,entity_id,details)
 values(p_tenant_id,null,'refund.gateway_provider_update','refund',p_refund_id::text,
  jsonb_build_object('provider','razorpay','provider_ref',coalesce(p_provider_ref,v_refund.provider_ref),
   'provider_status',p_provider_status,'stored_status',v_next,'external_reference',p_external_reference,
   'safe_error',case when v_next='failed' then left(coalesce(p_safe_error,''),240) else null end));
 return jsonb_build_object('refund_id',p_refund_id,'status',v_next);
end; $$;

revoke all on function public.record_razorpay_gateway_refund_result(uuid,uuid,text,text,text,text) from public,anon,authenticated;
grant execute on function public.record_razorpay_gateway_refund_result(uuid,uuid,text,text,text,text) to service_role;
grant execute on function public.begin_razorpay_gateway_refund(uuid,uuid) to authenticated;
commit;