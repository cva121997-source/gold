begin;

create or replace function private.create_scheme_enrolment(
 p_tenant_id uuid,p_branch_id uuid,p_customer_id uuid,p_scheme_version_id uuid,p_terms_accepted boolean
) returns uuid
language plpgsql security definer
set search_path=public,private,pg_temp
as $function$
declare
 v_user uuid:=auth.uid(); v_scheme_id uuid; v_scheme_type text; v_status text; v_scheme_branch uuid;
 v_version integer; v_terms jsonb; v_tenure integer; v_monthly numeric(14,2);
 v_enrolment_id uuid; v_code text; v_maturity date; i integer; v_customer_branch uuid;
 v_due_day integer; v_weight_in_period integer; v_grace_days integer; v_first_due date;
begin
 if v_user is null then raise exception 'Authentication required' using errcode='42501'; end if;
 if p_terms_accepted is not true then raise exception 'Customer acceptance of scheme terms must be recorded'; end if;
 if not private.has_tenant_branch_access(p_tenant_id,p_branch_id,array['owner','manager','scheme_manager','cashier','employee']) then
  raise exception 'Permission denied' using errcode='42501';
 end if;
 select c.branch_id into v_customer_branch from public.tenant_customers c
  where c.tenant_id=p_tenant_id and c.id=p_customer_id and c.status='active';
 if not found then raise exception 'Active customer not found'; end if;
 if not private.has_tenant_branch_access(p_tenant_id,v_customer_branch,array['owner','manager','scheme_manager','cashier','employee']) then
  raise exception 'Permission denied for the customer branch' using errcode='42501';
 end if;
 select st.id,st.scheme_type,st.status,st.current_version,sv.terms,st.branch_id
 into v_scheme_id,v_scheme_type,v_status,v_version,v_terms,v_scheme_branch
 from public.scheme_versions sv join public.scheme_templates st
   on st.tenant_id=sv.tenant_id and st.id=sv.scheme_id
 where sv.tenant_id=p_tenant_id and sv.id=p_scheme_version_id;
 if not found or v_status<>'published' or v_version<>(select version_no from public.scheme_versions where tenant_id=p_tenant_id and id=p_scheme_version_id) then
  raise exception 'Select the current version of a published scheme';
 end if;
 if v_scheme_branch is not null and v_scheme_branch is distinct from p_branch_id
    and not private.has_tenant_role(p_tenant_id,array['owner','manager']) then
  raise exception 'This scheme is not available at the selected branch' using errcode='42501';
 end if;
 if v_scheme_type='fixed_monthly' then
  v_tenure:=coalesce((v_terms->>'tenure_months')::integer,0);
  v_monthly:=coalesce((v_terms->>'monthly_instalment_inr')::numeric,0);
  v_due_day:=coalesce((v_terms->>'payment_due_day')::integer,5);
  v_weight_in_period:=coalesce((v_terms->>'weight_in_period_months')::integer,1);
  v_grace_days:=coalesce((v_terms->>'grace_period_days')::integer,0);
  if v_tenure not between 1 and 120 or v_monthly<=0 then
   raise exception 'Published monthly scheme terms are incomplete';
  end if;
  if v_due_day not between 1 and 28 or v_grace_days not between 0 and 60 or v_weight_in_period not between 0 and 24 then
   raise exception 'Published due-day, grace period or weight-in period is invalid';
  end if;
  v_maturity:=(current_date+make_interval(months=>v_tenure+v_weight_in_period))::date;
  v_first_due:=(date_trunc('month',current_date)::date+make_interval(months=>1)+(v_due_day-1))::date;
 end if;
 v_code:='ENR-'||to_char(now(),'YYYYMMDD')||'-'||upper(substr(replace(gen_random_uuid()::text,'-',''),1,8));
 insert into public.scheme_enrolments(
  tenant_id,branch_id,customer_id,scheme_version_id,enrolment_code,status,start_date,maturity_date,
  agreed_terms,terms_accepted_at,created_by
 ) values (
  p_tenant_id,p_branch_id,p_customer_id,p_scheme_version_id,v_code,'active',current_date,v_maturity,
  v_terms,now(),v_user
 ) returning id into v_enrolment_id;

 if v_scheme_type='fixed_monthly' then
  for i in 1..v_tenure loop
   insert into public.scheme_installments(
    tenant_id,branch_id,enrolment_id,installment_no,due_date,amount_due,status
   ) values (
    p_tenant_id,p_branch_id,v_enrolment_id,i,
    (v_first_due+make_interval(months=>i-1))::date,v_monthly,'upcoming'
   );
  end loop;
 end if;
 insert into public.customer_consents(
  tenant_id,customer_id,consent_type,consented,terms_version,source,captured_by,metadata
 ) values (
  p_tenant_id,p_customer_id,'scheme_terms',true,v_version::text,'staff_attestation',v_user,
  jsonb_build_object('enrolment_id',v_enrolment_id,'scheme_id',v_scheme_id,'terms',v_terms)
 );
 insert into public.audit_logs(tenant_id,actor_user_id,event_name,entity_type,entity_id,details)
 values(p_tenant_id,v_user,'scheme.enrolment_created','scheme_enrolment',v_enrolment_id::text,
  jsonb_build_object('customer_id',p_customer_id,'scheme_id',v_scheme_id,'terms_version',v_version,
   'maturity_date',v_maturity,'payment_due_day',coalesce((v_terms->>'payment_due_day')::integer,5),
   'weight_in_period_months',coalesce((v_terms->>'weight_in_period_months')::integer,1),
   'grace_period_days',coalesce((v_terms->>'grace_period_days')::integer,0)));
 return v_enrolment_id;
end;
$function$;

create or replace function private.publish_scheme_draft(
 p_tenant_id uuid,p_scheme_id uuid,p_owner_approved boolean
) returns void
language plpgsql security definer
set search_path=public,private,pg_temp
as $function$
declare
 v_user_id uuid:=auth.uid(); v_version integer; v_type text; v_terms jsonb;
 v_benefit text; v_multiplier numeric; v_benefit_amount numeric; v_benefit_weight numeric;
 v_due_day integer; v_grace integer; v_weight_in integer;
begin
 if v_user_id is null then raise exception 'Authentication required' using errcode='42501'; end if;
 if p_owner_approved is not true then raise exception 'Owner approval is required'; end if;
 if not public.has_tenant_role(p_tenant_id,array['owner']) then
  raise exception 'Only the shop owner can publish a scheme' using errcode='42501';
 end if;
 select current_version,scheme_type into v_version,v_type
  from public.scheme_templates
  where tenant_id=p_tenant_id and id=p_scheme_id and status='draft' for update;
 if not found then raise exception 'Draft scheme not found or it is no longer a draft'; end if;
 select terms into v_terms from public.scheme_versions
  where tenant_id=p_tenant_id and scheme_id=p_scheme_id and version_no=v_version for update;
 if not found then raise exception 'Scheme terms version not found'; end if;
 if v_type='fixed_monthly' then
  if coalesce((v_terms->>'tenure_months')::integer,0) not between 1 and 120 then
   raise exception 'Monthly scheme tenure must be between 1 and 120 months';
  end if;
  if coalesce((v_terms->>'monthly_instalment_inr')::numeric,0)<=0 then
   raise exception 'Set a positive monthly instalment amount before publication';
  end if;
  v_due_day:=coalesce((v_terms->>'payment_due_day')::integer,5);
  v_grace:=coalesce((v_terms->>'grace_period_days')::integer,0);
  v_weight_in:=coalesce((v_terms->>'weight_in_period_months')::integer,1);
  if v_due_day not between 1 and 28 or v_grace not between 0 and 60 or v_weight_in not between 0 and 24 then
   raise exception 'Due day, grace period or weight-in period is out of range';
  end if;
  v_benefit:=coalesce(v_terms->>'benefit_type','none');
  if v_benefit not in ('gold_weight_bonus','jewellery_purchase_credit','making_charge_discount','custom','none','one_instalment_equivalent') then
   raise exception 'Configure a valid maturity benefit';
  end if;
  if v_benefit='one_instalment_equivalent' then
   v_multiplier:=coalesce((v_terms->>'benefit_equivalent_monthly_instalments')::numeric,1);
   if v_multiplier<=0 or v_multiplier>24 then raise exception 'Instalment-equivalent benefit must be greater than zero and at most 24'; end if;
  elsif v_benefit='gold_weight_bonus' then
   v_benefit_weight:=coalesce((v_terms->>'benefit_weight_grams')::numeric,0);
   if v_benefit_weight<=0 then raise exception 'Enter a positive gold-weight benefit before publication'; end if;
  elsif v_benefit<>'none' then
   v_benefit_amount:=coalesce((v_terms->>'benefit_amount_inr')::numeric,0);
   if v_benefit_amount<=0 then raise exception 'Enter a positive benefit amount before publication'; end if;
  end if;
 end if;
 update public.scheme_versions set reviewed_by=v_user_id,reviewed_at=now(),effective_from=now(),
  terms=terms||jsonb_build_object('customer_terms_approved',true,'owner_reviewed',true)
 where tenant_id=p_tenant_id and scheme_id=p_scheme_id and version_no=v_version;
 update public.scheme_templates set status='published',updated_at=now()
  where tenant_id=p_tenant_id and id=p_scheme_id;
 insert into public.audit_logs(tenant_id,actor_user_id,event_name,entity_type,entity_id,details)
 values(p_tenant_id,v_user_id,'scheme.published','scheme',p_scheme_id::text,
  jsonb_build_object('version',v_version,'owner_approved',true,'terms',v_terms));
end;
$function$;

commit;