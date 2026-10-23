begin;

-- Browser roles may inspect payments through RLS but cannot write provider-backed financial rows.
alter table public.payment_orders add column if not exists invoice_id uuid;
do $gold_payment_order_invoice_fk$
begin
  if not exists (select 1 from pg_constraint where conname='payment_orders_tenant_id_invoice_id_fkey' and conrelid='public.payment_orders'::regclass) then
    alter table public.payment_orders add constraint payment_orders_tenant_id_invoice_id_fkey
      foreign key (tenant_id,invoice_id) references public.invoices(tenant_id,id);
  end if;
end
$gold_payment_order_invoice_fk$;

revoke all privileges on table public.payment_orders, public.payments, public.payment_webhook_events,
  public.platform_admins, public.platform_settings, public.feature_flags from public, anon, authenticated;
grant select on table public.payment_orders, public.payments to authenticated;
grant all privileges on table public.payment_orders, public.payments, public.payment_webhook_events,
  public.platform_admins, public.platform_settings, public.feature_flags to service_role;

comment on table public.payment_webhook_events is 'Server-only provider webhook inbox. RLS is intentionally enabled without browser policies; processing is available only through the service-role payment endpoint.';
comment on table public.platform_admins is 'Server-only platform administrator registry. Never expose direct browser access; administration APIs verify this table using a server-only service key.';
comment on table public.platform_settings is 'Server-only global platform settings. RLS without browser policies is intentional.';
comment on table public.feature_flags is 'Server-only platform feature flags. RLS without browser policies is intentional.';

-- Preserve invoice pricing/tax history; permit only monotonic amount-paid/status settlement updates.
create or replace function private.prevent_invoice_history_edit()
returns trigger language plpgsql security definer set search_path=public,private,pg_temp as $$
begin
  if tg_op='DELETE' then raise exception 'Invoice history is immutable; use an audited void, credit-note or reversal workflow'; end if;
  if old.status='draft' then return new; end if;
  if (to_jsonb(new) - array['status','amount_paid','updated_at']::text[])
     is distinct from (to_jsonb(old) - array['status','amount_paid','updated_at']::text[]) then
    raise exception 'Issued invoice pricing, customer, line, rate and tax snapshots are immutable; use an audited credit-note or reversal workflow';
  end if;
  if old.status in ('issued','partially_paid') and new.status in ('partially_paid','paid')
     and new.amount_paid >= old.amount_paid and new.amount_paid <= new.total_amount then
    return new;
  end if;
  raise exception 'Issued invoice history is immutable except for monotonic payment settlement';
end;
$$;
revoke execute on function private.prevent_invoice_history_edit() from public,anon,authenticated;

-- Server-only RPC. The webhook handler must verify Razorpay's HMAC before invoking this function.
create or replace function public.process_razorpay_webhook_event(
  p_provider_event_id text,p_event_type text,p_order_ref text,p_payment_ref text,
  p_amount_paise bigint,p_currency text,p_payload_hash text,p_safe_payload jsonb
) returns jsonb language plpgsql security invoker set search_path=public,pg_temp as $$
declare
  v_event_id uuid;
  v_order public.payment_orders%rowtype;
  v_payment_id uuid;
  v_existing public.payments%rowtype;
  v_enrol public.scheme_enrolments%rowtype;
  v_scheme_type text;
  v_terms jsonb;
  v_rate numeric(14,2);
  v_weight numeric(14,6);
  v_remaining numeric(14,2);
  v_allocation numeric(14,2);
  v_inst record;
  v_invoice public.invoices%rowtype;
  v_invoice_review boolean := false;
  v_status text := 'processed';
  v_receipt_number text;
begin
  if nullif(trim(coalesce(p_provider_event_id,'')),'') is null or nullif(trim(coalesce(p_event_type,'')),'') is null then
    raise exception 'Provider event ID and event type are required';
  end if;

  insert into public.payment_webhook_events(provider,provider_event_id,event_type,payload_hash,safe_payload,signature_verified)
  values ('razorpay',trim(p_provider_event_id),trim(p_event_type),p_payload_hash,coalesce(p_safe_payload,'{}'::jsonb),true)
  on conflict (provider,provider_event_id) do nothing returning id into v_event_id;
  if v_event_id is null then return jsonb_build_object('status','duplicate_event'); end if;

  if p_event_type <> 'payment.captured' then
    update public.payment_webhook_events set processed_at=now() where id=v_event_id;
    return jsonb_build_object('status','ignored_event','event_type',p_event_type);
  end if;

  if nullif(trim(coalesce(p_order_ref,'')),'') is null or nullif(trim(coalesce(p_payment_ref,'')),'') is null
     or p_amount_paise is null or p_amount_paise <= 0 then
    update public.payment_webhook_events set processed_at=now(),processing_error='Captured event is missing order, payment or amount data' where id=v_event_id;
    return jsonb_build_object('status','invalid_capture_payload');
  end if;

  select * into v_order from public.payment_orders where provider='razorpay' and provider_order_ref=trim(p_order_ref) for update;
  if not found then
    update public.payment_webhook_events set processed_at=now(),processing_error='No Gold payment order matches the Razorpay order reference' where id=v_event_id;
    return jsonb_build_object('status','unmatched_order');
  end if;

  if p_currency is distinct from v_order.currency or p_amount_paise <> round(v_order.amount*100)::bigint then
    update public.payment_webhook_events set processed_at=now(),processing_error='Captured amount or currency does not match the Gold order' where id=v_event_id;
    insert into public.audit_logs(tenant_id,actor_user_id,event_name,entity_type,entity_id,details)
    values(v_order.tenant_id,null,'payment.webhook_mismatch','payment_order',v_order.id::text,
      jsonb_build_object('provider','razorpay','event_id',p_provider_event_id,'expected_amount_paise',round(v_order.amount*100)::bigint,
        'received_amount_paise',p_amount_paise,'expected_currency',v_order.currency,'received_currency',p_currency));
    return jsonb_build_object('status','amount_or_currency_mismatch','order_id',v_order.id);
  end if;

  select * into v_existing from public.payments where provider='razorpay' and provider_payment_ref=trim(p_payment_ref) limit 1 for update;
  if found then
    if v_existing.tenant_id=v_order.tenant_id and v_existing.payment_order_id=v_order.id and v_existing.status='confirmed' then
      update public.payment_orders set status='paid',updated_at=now() where id=v_order.id;
      update public.payment_webhook_events set processed_at=now() where id=v_event_id;
      return jsonb_build_object('status','duplicate_payment','payment_id',v_existing.id,'order_id',v_order.id);
    end if;
    update public.payment_webhook_events set processed_at=now(),processing_error='Provider payment reference is already linked to a different Gold order' where id=v_event_id;
    return jsonb_build_object('status','payment_reference_conflict','order_id',v_order.id);
  end if;

  if v_order.status='paid' then
    update public.payment_webhook_events set processed_at=now(),processing_error='Gold order is already marked paid by a different capture' where id=v_event_id;
    return jsonb_build_object('status','already_paid_conflict','order_id',v_order.id);
  end if;
  if v_order.status in ('failed','cancelled','expired') then v_status := 'payment_received_needs_review'; end if;

  if v_order.purpose='invoice' then
    select * into v_invoice from public.invoices where tenant_id=v_order.tenant_id and id=v_order.invoice_id for update;
    if not found or v_invoice.status not in ('issued','partially_paid') or (v_invoice.total_amount-v_invoice.amount_paid)<v_order.amount then
      v_invoice_review := true; v_status := 'payment_received_needs_review';
    end if;
  end if;

  insert into public.payments(tenant_id,branch_id,customer_id,enrolment_id,invoice_id,payment_order_id,
    payment_method,status,amount,currency,reference,provider,provider_payment_ref,idempotency_key,
    confirmation_source,confirmed_at,metadata)
  values(v_order.tenant_id,v_order.branch_id,v_order.customer_id,v_order.enrolment_id,v_order.invoice_id,v_order.id,
    'gateway','confirmed',v_order.amount,v_order.currency,trim(p_payment_ref),'razorpay',trim(p_payment_ref),
    'razorpay:'||trim(p_payment_ref),'provider_webhook',now(),
    jsonb_build_object('provider_event_id',p_provider_event_id,'provider_order_ref',p_order_ref,
      'safe_payload',coalesce(p_safe_payload,'{}'::jsonb),'order_metadata',v_order.metadata,
      'needs_review',v_status='payment_received_needs_review')) returning id into v_payment_id;

  update public.payment_orders set status='paid',updated_at=now() where id=v_order.id;

  if v_order.purpose='scheme_contribution' and v_order.enrolment_id is not null then
    select * into v_enrol from public.scheme_enrolments where tenant_id=v_order.tenant_id and id=v_order.enrolment_id for update;
    if found and v_enrol.status in ('active','pending') then
      select st.scheme_type,sv.terms into v_scheme_type,v_terms
      from public.scheme_templates st join public.scheme_versions sv on sv.tenant_id=st.tenant_id and sv.scheme_id=st.id
      where st.tenant_id=v_order.tenant_id and sv.id=v_enrol.scheme_version_id;

      if v_order.metadata ? 'gold_rate_snapshot' then v_rate := nullif(v_order.metadata->>'gold_rate_snapshot','')::numeric; end if;
      if v_scheme_type='flexible_gold_weight' then
        if coalesce(v_rate,0)<=0 then
          update public.payments set metadata=metadata||jsonb_build_object('needs_review',true,'review_reason','Missing locked gold rate snapshot') where id=v_payment_id;
          v_status := 'payment_received_needs_review';
        else
          v_weight := round(v_order.amount/v_rate,6);
        end if;
      end if;

      insert into public.scheme_transactions(tenant_id,branch_id,enrolment_id,transaction_type,status,amount,
        gold_rate_snapshot,weight_grams_snapshot,reference,idempotency_key,notes,confirmed_at)
      values(v_order.tenant_id,v_order.branch_id,v_order.enrolment_id,'contribution','confirmed',v_order.amount,
        v_rate,v_weight,trim(p_payment_ref),'razorpay:'||trim(p_payment_ref),'Verified Razorpay payment capture',now())
      on conflict (tenant_id,idempotency_key) do nothing;

      v_remaining := v_order.amount;
      for v_inst in select id,amount_due,amount_paid from public.scheme_installments
        where tenant_id=v_order.tenant_id and enrolment_id=v_order.enrolment_id
          and status not in ('paid','waived','cancelled') and amount_paid<amount_due
        order by due_date,installment_no for update
      loop
        exit when v_remaining<=0;
        v_allocation := least(v_remaining,v_inst.amount_due-v_inst.amount_paid);
        update public.scheme_installments set amount_paid=amount_paid+v_allocation,
          status=case when amount_paid+v_allocation>=amount_due then 'paid' else 'partial' end,
          paid_at=case when amount_paid+v_allocation>=amount_due then now() else null end,
          updated_at=now() where id=v_inst.id;
        v_remaining := v_remaining-v_allocation;
      end loop;
    else
      update public.payments set metadata=metadata||jsonb_build_object('needs_review',true,'review_reason','Scheme enrolment is no longer active') where id=v_payment_id;
      v_status := 'payment_received_needs_review';
    end if;
  elsif v_order.purpose='invoice' and not v_invoice_review then
    update public.invoices set amount_paid=amount_paid+v_order.amount,
      status=case when amount_paid+v_order.amount>=total_amount then 'paid' else 'partially_paid' end,updated_at=now()
    where tenant_id=v_order.tenant_id and id=v_order.invoice_id;
  end if;

  v_receipt_number := 'RCPT-'||to_char(now(),'YYYYMMDD')||'-'||upper(substr(replace(gen_random_uuid()::text,'-',''),1,8));
  insert into public.receipts(tenant_id,branch_id,payment_id,enrolment_id,invoice_id,receipt_number,receipt_type,snapshot,issued_by)
  values(v_order.tenant_id,v_order.branch_id,v_payment_id,v_order.enrolment_id,v_order.invoice_id,v_receipt_number,'payment',
    jsonb_build_object('payment_id',v_payment_id,'payment_order_id',v_order.id,'order_code',v_order.order_code,
      'amount',v_order.amount,'currency',v_order.currency,'payment_method','gateway','provider','razorpay',
      'provider_payment_ref',p_payment_ref,'customer_id',v_order.customer_id,'invoice_id',v_order.invoice_id,
      'enrolment_id',v_order.enrolment_id,'confirmed_at',now(),'needs_review',v_status='payment_received_needs_review'),null);

  insert into public.audit_logs(tenant_id,actor_user_id,event_name,entity_type,entity_id,details)
  values(v_order.tenant_id,null,'payment.gateway_confirmed','payment',v_payment_id::text,
    jsonb_build_object('provider','razorpay','order_id',v_order.id,'payment_order_code',v_order.order_code,
      'amount',v_order.amount,'event_id',p_provider_event_id,'review_required',v_status='payment_received_needs_review'));
  update public.payment_webhook_events set processed_at=now() where id=v_event_id;
  return jsonb_build_object('status',v_status,'payment_id',v_payment_id,'order_id',v_order.id,'receipt_number',v_receipt_number);
end;
$$;

revoke execute on function public.process_razorpay_webhook_event(text,text,text,text,bigint,text,text,jsonb) from public,anon,authenticated;
grant execute on function public.process_razorpay_webhook_event(text,text,text,text,bigint,text,text,jsonb) to service_role;

-- Optimize self/profile notification and support-request policies without broadening their access.
drop policy if exists profiles_read_self on public.profiles;
create policy profiles_read_self on public.profiles for select to authenticated using (id=(select auth.uid()));
drop policy if exists profiles_update_self on public.profiles;
create policy profiles_update_self on public.profiles for update to authenticated using (id=(select auth.uid())) with check (id=(select auth.uid()));

drop policy if exists notifications_staff_or_customer_read on public.notifications;
create policy notifications_staff_or_customer_read on public.notifications for select to authenticated
using (private.is_tenant_member(tenant_id) or recipient_user_id=(select auth.uid())
  or (customer_id is not null and private.is_linked_customer(tenant_id,customer_id)));

drop policy if exists support_request_create on public.support_tickets;
create policy support_request_create on public.support_tickets for insert to authenticated with check (created_by=(select auth.uid()));
drop policy if exists support_request_read on public.support_tickets;
create policy support_request_read on public.support_tickets for select to authenticated
using (created_by=(select auth.uid()) or (tenant_id is not null and private.has_tenant_role(tenant_id,array['owner','manager'])));

commit;