begin;

create or replace function private.record_manual_payment(
  p_tenant_id uuid,p_branch_id uuid,p_customer_id uuid,p_enrolment_id uuid,
  p_amount numeric,p_method text,p_reference text,p_idempotency_key text,p_notes text default null
)
returns uuid
language plpgsql
security definer
set search_path=public,private,pg_temp
as $$
declare
  v_user uuid := auth.uid();
  v_payment_id uuid;
  v_customer_id uuid := p_customer_id;
  v_enrolment_customer uuid;
  v_enrolment_branch uuid;
  v_branch uuid := p_branch_id;
  v_remaining numeric(14,2) := round(p_amount,2);
  v_allocation numeric(14,2);
  v_inst record;
  v_receipt_number text;
  v_scheme_type text;
  v_agreed_terms jsonb;
  v_version_terms jsonb;
  v_purity_code text;
  v_metal_id smallint;
  v_purity_id smallint;
  v_rate_id uuid;
  v_rate numeric(14,2);
  v_rate_effective_at timestamptz;
  v_rate_source_label text;
  v_weight numeric(14,6);
  v_rate_snapshot jsonb;
begin
  if v_user is null then raise exception 'Authentication required' using errcode='42501'; end if;
  if not private.has_tenant_branch_access(p_tenant_id,p_branch_id,array['owner','manager','accountant','cashier']) then
    raise exception 'Permission denied' using errcode='42501';
  end if;
  if p_amount is null or p_amount<=0 then raise exception 'Payment amount must be positive'; end if;
  if p_method not in ('cash','upi','bank_transfer','cheque','other') then
    raise exception 'Only staff-collected methods are allowed through this RPC';
  end if;
  if nullif(trim(p_idempotency_key),'') is null then raise exception 'Idempotency key is required'; end if;

  -- Serialise repeated submissions with the same idempotency key before checking the ledger.
  perform pg_advisory_xact_lock(hashtextextended(p_tenant_id::text||':'||trim(p_idempotency_key),0));
  select id into v_payment_id from public.payments
    where tenant_id=p_tenant_id and idempotency_key=trim(p_idempotency_key);
  if v_payment_id is not null then return v_payment_id; end if;

  if p_enrolment_id is not null then
    select e.customer_id,e.branch_id,e.agreed_terms,st.scheme_type,sv.terms
      into v_enrolment_customer,v_enrolment_branch,v_agreed_terms,v_scheme_type,v_version_terms
    from public.scheme_enrolments e
    join public.scheme_versions sv on sv.tenant_id=e.tenant_id and sv.id=e.scheme_version_id
    join public.scheme_templates st on st.tenant_id=sv.tenant_id and st.id=sv.scheme_id
    where e.tenant_id=p_tenant_id and e.id=p_enrolment_id and e.status in ('active','pending')
    for update of e;

    if not found then raise exception 'Scheme enrolment not found or inactive'; end if;
    if p_customer_id is not null and p_customer_id<>v_enrolment_customer then
      raise exception 'Customer does not match the selected scheme enrolment';
    end if;
    if not private.has_tenant_branch_access(p_tenant_id,v_enrolment_branch,array['owner','manager','accountant','cashier']) then
      raise exception 'Permission denied for the enrolment branch' using errcode='42501';
    end if;
    v_customer_id := v_enrolment_customer;
    if v_branch is null then v_branch := v_enrolment_branch; end if;

    if v_scheme_type='flexible_gold_weight' then
      v_purity_code := coalesce(nullif(trim(v_agreed_terms->>'purity_code'),''),nullif(trim(v_version_terms->>'purity_code'),''),'22K');
      select m.id,p.id into v_metal_id,v_purity_id
      from public.metals m
      join public.purity_definitions p on p.metal_id=m.id
      where m.code='gold' and m.is_active and p.code=v_purity_code and p.is_active;
      if not found then raise exception 'The scheme purity is not configured as an active gold purity'; end if;

      select r.id,r.price_per_gram,r.effective_at,r.source_label
        into v_rate_id,v_rate,v_rate_effective_at,v_rate_source_label
      from public.gold_rates r
      where r.tenant_id=p_tenant_id and r.metal_id=v_metal_id and r.purity_id=v_purity_id
        and r.status='verified' and r.effective_at<=now()
        and r.effective_at>=now()-interval '36 hours'
        and (r.expires_at is null or r.expires_at>now())
        and (r.branch_id=v_enrolment_branch or r.branch_id is null)
      order by case when r.branch_id=v_enrolment_branch then 0 else 1 end,r.effective_at desc,r.created_at desc
      limit 1;

      if not found or coalesce(v_rate,0)<=0 then
        raise exception 'No fresh verified rate exists for this scheme purity and branch. Update the shop rate before recording this contribution';
      end if;
      v_weight := round(round(p_amount,2)/v_rate,6);
      v_rate_snapshot := jsonb_build_object(
        'rate_id',v_rate_id,'purity_code',v_purity_code,'price_per_gram',v_rate,
        'effective_at',v_rate_effective_at,'source_label',v_rate_source_label,
        'valuation_method','price_per_gram_at_confirmed_contribution'
      );
    end if;
  end if;

  insert into public.payments(
    tenant_id,branch_id,customer_id,enrolment_id,payment_method,status,amount,reference,
    idempotency_key,confirmation_source,confirmed_by,confirmed_at,metadata
  ) values (
    p_tenant_id,v_branch,v_customer_id,p_enrolment_id,p_method,'confirmed',round(p_amount,2),
    nullif(trim(p_reference),''),trim(p_idempotency_key),'staff',v_user,now(),
    jsonb_build_object('notes',p_notes,'scheme_rate_snapshot',v_rate_snapshot,'weight_grams_snapshot',v_weight)
  ) returning id into v_payment_id;

  if p_enrolment_id is not null then
    insert into public.scheme_transactions(
      tenant_id,branch_id,enrolment_id,transaction_type,status,amount,
      gold_rate_snapshot,weight_grams_snapshot,reference,idempotency_key,notes,actor_user_id,confirmed_at
    ) values (
      p_tenant_id,v_branch,p_enrolment_id,'contribution','confirmed',round(p_amount,2),
      v_rate,v_weight,coalesce(nullif(trim(p_reference),''),v_payment_id::text),
      'payment:'||trim(p_idempotency_key),p_notes,v_user,now()
    );

    for v_inst in
      select id,amount_due,amount_paid from public.scheme_installments
      where tenant_id=p_tenant_id and enrolment_id=p_enrolment_id
        and status not in ('paid','waived','cancelled') and amount_paid<amount_due
      order by due_date,installment_no for update
    loop
      exit when v_remaining<=0;
      v_allocation:=least(v_remaining,v_inst.amount_due-v_inst.amount_paid);
      update public.scheme_installments set
        amount_paid=amount_paid+v_allocation,
        status=case when amount_paid+v_allocation>=amount_due then 'paid' else 'partial' end,
        paid_at=case when amount_paid+v_allocation>=amount_due then now() else null end,
        updated_at=now()
      where id=v_inst.id;
      v_remaining:=v_remaining-v_allocation;
    end loop;
  end if;

  v_receipt_number:='RCPT-'||to_char(now(),'YYYYMMDD')||'-'||upper(substr(replace(gen_random_uuid()::text,'-',''),1,8));
  insert into public.receipts(tenant_id,branch_id,payment_id,enrolment_id,receipt_number,receipt_type,snapshot,issued_by)
  values(p_tenant_id,v_branch,v_payment_id,p_enrolment_id,v_receipt_number,'payment',
    jsonb_build_object('payment_id',v_payment_id,'amount',round(p_amount,2),'currency','INR','method',p_method,
      'reference',p_reference,'customer_id',v_customer_id,'notes',p_notes,'confirmed_at',now(),
      'gold_rate_snapshot',v_rate_snapshot,'weight_grams_snapshot',v_weight),v_user);

  insert into public.audit_logs(tenant_id,actor_user_id,event_name,entity_type,entity_id,details)
  values(p_tenant_id,v_user,'payment.manual_confirmed','payment',v_payment_id::text,
    jsonb_build_object('amount',round(p_amount,2),'method',p_method,'enrolment_id',p_enrolment_id,
      'receipt_number',v_receipt_number,'gold_rate_id',v_rate_id,'weight_grams',v_weight));
  return v_payment_id;
end;
$$;

revoke execute on function private.record_manual_payment(uuid,uuid,uuid,uuid,numeric,text,text,text,text) from public,anon;
grant execute on function private.record_manual_payment(uuid,uuid,uuid,uuid,numeric,text,text,text,text) to authenticated;

commit;