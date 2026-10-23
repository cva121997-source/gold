-- Gold workflow layer: scheme enrollment schedules, staff invitations, manual collections,
-- immutable issued invoices, plus non-exposed privileged implementations.
begin;

-- Branch-scoped memberships must not bypass branch checks by passing a NULL branch on writes.
create or replace function private.has_tenant_branch_access(p_tenant_id uuid,p_branch_id uuid,p_roles text[] default null)
returns boolean
language sql stable security definer set search_path = public, private, pg_temp
as $$
 select exists (
   select 1 from public.tenant_memberships m
   where m.tenant_id=p_tenant_id and m.user_id=auth.uid() and m.is_active
     and (p_roles is null or m.role=any(p_roles))
     and (
       (p_roles is null and p_branch_id is null)
       or m.role in ('owner','manager')
       or (p_branch_id is not null and m.branch_id=p_branch_id)
       or (p_roles is not null and p_branch_id is null and m.branch_id is null)
     )
 );
$$;
create or replace function public.has_tenant_branch_access(p_tenant_id uuid,p_branch_id uuid,p_roles text[] default null)
returns boolean language sql stable security invoker set search_path=public,private,pg_temp
as $$ select private.has_tenant_branch_access(p_tenant_id,p_branch_id,p_roles); $$;

-- Move the authorised RPC implementations out of the exposed public schema.
alter function public.create_tenant_onboarding(text,text,text,text,text,text) set schema private;
alter function public.create_scheme_draft(uuid,text,text,text,jsonb) set schema private;
alter function public.publish_scheme_draft(uuid,uuid,boolean) set schema private;
alter function public.record_manual_payment(uuid,uuid,uuid,uuid,numeric,text,text,text,text) set schema private;

grant usage on schema private to authenticated;
grant execute on function private.create_tenant_onboarding(text,text,text,text,text,text) to authenticated;
grant execute on function private.create_scheme_draft(uuid,text,text,text,jsonb) to authenticated;
grant execute on function private.publish_scheme_draft(uuid,uuid,boolean) to authenticated;
grant execute on function private.record_manual_payment(uuid,uuid,uuid,uuid,numeric,text,text,text,text) to authenticated;
revoke execute on function private.create_tenant_onboarding(text,text,text,text,text,text) from public,anon;
revoke execute on function private.create_scheme_draft(uuid,text,text,text,jsonb) from public,anon;
revoke execute on function private.publish_scheme_draft(uuid,uuid,boolean) from public,anon;
revoke execute on function private.record_manual_payment(uuid,uuid,uuid,uuid,numeric,text,text,text,text) from public,anon;

-- Tenant onboarding sets up a real trial subscription and default settings atomically.
create or replace function private.create_tenant_onboarding(
 p_display_name text,p_slug text,p_state text default 'Tamil Nadu',
 p_city text default null,p_district text default null,p_locality text default null
)
returns uuid language plpgsql security definer set search_path=public,private,pg_temp as $$
declare
 v_user_id uuid := auth.uid(); v_tenant_id uuid; v_branch_id uuid; v_plan_id uuid;
 v_slug text := lower(trim(p_slug));
begin
 if v_user_id is null then raise exception 'Authentication required' using errcode='42501'; end if;
 if length(trim(coalesce(p_display_name,'')))<2 then raise exception 'Shop display name must contain at least 2 characters'; end if;
 if v_slug !~ '^[a-z0-9]+(-[a-z0-9]+)*$' or length(v_slug)>60 then raise exception 'Shop slug format is invalid'; end if;

 insert into public.tenants(code,slug,display_name,state,city,district,locality)
 values(upper(substr(replace(gen_random_uuid()::text,'-',''),1,8)),v_slug,trim(p_display_name),
 nullif(trim(p_state),''),nullif(trim(p_city),''),nullif(trim(p_district),''),nullif(trim(p_locality),''))
 returning id into v_tenant_id;

 insert into public.branches(tenant_id,branch_code,name,state,district,city,locality,is_default)
 values(v_tenant_id,'MAIN','Main Branch',nullif(trim(p_state),''),nullif(trim(p_district),''),nullif(trim(p_city),''),nullif(trim(p_locality),''),true)
 returning id into v_branch_id;
 insert into public.tenant_memberships(tenant_id,user_id,branch_id,role) values(v_tenant_id,v_user_id,v_branch_id,'owner');
 insert into public.tenant_settings(tenant_id) values(v_tenant_id);
 select id into v_plan_id from public.subscription_plans where code='starter' and is_active limit 1;
 insert into public.tenant_subscriptions(tenant_id,plan_id,status,trial_ends_at,current_period_start,current_period_end)
 values(v_tenant_id,v_plan_id,'trial',now()+interval '14 days',now(),now()+interval '14 days');
 insert into public.audit_logs(tenant_id,actor_user_id,event_name,entity_type,entity_id,details)
 values(v_tenant_id,v_user_id,'tenant.created','tenant',v_tenant_id::text,jsonb_build_object('source','owner_onboarding','trial_days',14));
 return v_tenant_id;
end;
$$;

create or replace function private.create_scheme_draft(p_tenant_id uuid,p_name text,p_description text,p_scheme_type text,p_terms jsonb)
returns uuid language plpgsql security definer set search_path=public,private,pg_temp as $$
declare v_user_id uuid:=auth.uid(); v_scheme_id uuid;
begin
 if v_user_id is null then raise exception 'Authentication required' using errcode='42501'; end if;
 if not public.has_tenant_role(p_tenant_id,array['owner','manager','scheme_manager']) then raise exception 'Permission denied' using errcode='42501'; end if;
 if length(trim(coalesce(p_name,'')))<2 then raise exception 'Scheme name is required'; end if;
 if p_scheme_type not in ('flexible_gold_weight','fixed_monthly','custom') then raise exception 'Unsupported scheme type'; end if;
 if p_terms is null or jsonb_typeof(p_terms)<>'object' then raise exception 'Scheme terms must be a JSON object'; end if;
 if p_scheme_type='fixed_monthly' and ((p_terms->>'tenure_months') is null or (p_terms->>'monthly_instalment_inr') is null) then
   raise exception 'Configure tenure and monthly instalment amount before creating a fixed monthly scheme';
 end if;
 insert into public.scheme_templates(tenant_id,name,description,scheme_type,status,current_version,created_by)
 values(p_tenant_id,trim(p_name),nullif(trim(p_description),''),p_scheme_type,'draft',1,v_user_id) returning id into v_scheme_id;
 insert into public.scheme_versions(tenant_id,scheme_id,version_no,terms,terms_markdown,created_by)
 values(p_tenant_id,v_scheme_id,1,p_terms||jsonb_build_object('requires_owner_review',true,'customer_terms_approved',false),
 coalesce(p_description,'Draft terms require owner review.'),v_user_id);
 insert into public.audit_logs(tenant_id,actor_user_id,event_name,entity_type,entity_id,details)
 values(p_tenant_id,v_user_id,'scheme.draft_created','scheme',v_scheme_id::text,jsonb_build_object('scheme_type',p_scheme_type,'version',1));
 return v_scheme_id;
end;
$$;

create or replace function private.publish_scheme_draft(p_tenant_id uuid,p_scheme_id uuid,p_owner_approved boolean)
returns void language plpgsql security definer set search_path=public,private,pg_temp as $$
declare
 v_user_id uuid:=auth.uid(); v_version integer; v_type text; v_terms jsonb;
begin
 if v_user_id is null then raise exception 'Authentication required' using errcode='42501'; end if;
 if p_owner_approved is not true then raise exception 'Owner approval is required'; end if;
 if not public.has_tenant_role(p_tenant_id,array['owner']) then raise exception 'Only the shop owner can publish a scheme' using errcode='42501'; end if;
 select current_version,scheme_type into v_version,v_type from public.scheme_templates where tenant_id=p_tenant_id and id=p_scheme_id and status='draft' for update;
 if not found then raise exception 'Draft scheme not found or it is no longer a draft'; end if;
 select terms into v_terms from public.scheme_versions where tenant_id=p_tenant_id and scheme_id=p_scheme_id and version_no=v_version for update;
 if not found then raise exception 'Scheme terms version not found'; end if;
 if v_type='fixed_monthly' then
   if coalesce((v_terms->>'tenure_months')::integer,0) not between 1 and 120 then raise exception 'Monthly scheme tenure must be between 1 and 120 months'; end if;
   if coalesce((v_terms->>'monthly_instalment_inr')::numeric,0)<=0 then raise exception 'Set a positive monthly instalment amount before publication'; end if;
   if coalesce(v_terms->>'benefit_type','') not in ('gold_weight_bonus','jewellery_purchase_credit','making_charge_discount','custom','none','one_instalment_equivalent') then raise exception 'Configure a valid maturity benefit'; end if;
 end if;
 update public.scheme_versions set reviewed_by=v_user_id,reviewed_at=now(),effective_from=now(),
   terms=terms||jsonb_build_object('customer_terms_approved',true,'owner_reviewed',true)
 where tenant_id=p_tenant_id and scheme_id=p_scheme_id and version_no=v_version;
 update public.scheme_templates set status='published',updated_at=now() where tenant_id=p_tenant_id and id=p_scheme_id;
 insert into public.audit_logs(tenant_id,actor_user_id,event_name,entity_type,entity_id,details)
 values(p_tenant_id,v_user_id,'scheme.published','scheme',p_scheme_id::text,jsonb_build_object('version',v_version,'owner_approved',true));
end;
$$;

create or replace function private.record_manual_payment(
 p_tenant_id uuid,p_branch_id uuid,p_customer_id uuid,p_enrolment_id uuid,
 p_amount numeric,p_method text,p_reference text,p_idempotency_key text,p_notes text default null
)
returns uuid language plpgsql security definer set search_path=public,private,pg_temp as $$
declare
 v_user uuid:=auth.uid(); v_payment_id uuid; v_customer_id uuid:=p_customer_id;
 v_enrolment_customer uuid; v_enrolment_branch uuid; v_branch uuid:=p_branch_id;
 v_remaining numeric(14,2):=round(p_amount,2); v_allocation numeric(14,2); inst record;
 v_receipt_number text;
begin
 if v_user is null then raise exception 'Authentication required' using errcode='42501'; end if;
 if not public.has_tenant_branch_access(p_tenant_id,p_branch_id,array['owner','manager','accountant','cashier']) then raise exception 'Permission denied' using errcode='42501'; end if;
 if p_amount is null or p_amount<=0 then raise exception 'Payment amount must be positive'; end if;
 if p_method not in ('cash','upi','bank_transfer','cheque','other') then raise exception 'Only staff-collected methods are allowed through this RPC'; end if;
 if nullif(trim(p_idempotency_key),'') is null then raise exception 'Idempotency key is required'; end if;
 select id into v_payment_id from public.payments where tenant_id=p_tenant_id and idempotency_key=p_idempotency_key;
 if v_payment_id is not null then return v_payment_id; end if;

 if p_enrolment_id is not null then
   select e.customer_id,e.branch_id into v_enrolment_customer,v_enrolment_branch
   from public.scheme_enrolments e where e.tenant_id=p_tenant_id and e.id=p_enrolment_id and e.status in ('active','pending');
   if not found then raise exception 'Scheme enrolment not found or inactive'; end if;
   if p_customer_id is not null and p_customer_id<>v_enrolment_customer then raise exception 'Customer does not match the selected scheme enrolment'; end if;
   if not public.has_tenant_branch_access(p_tenant_id,v_enrolment_branch,array['owner','manager','accountant','cashier']) then raise exception 'Permission denied for the enrolment branch' using errcode='42501'; end if;
   v_customer_id:=v_enrolment_customer;
   if v_branch is null then v_branch:=v_enrolment_branch; end if;
 end if;

 insert into public.payments(tenant_id,branch_id,customer_id,enrolment_id,payment_method,status,amount,reference,idempotency_key,confirmation_source,confirmed_by,confirmed_at,metadata)
 values(p_tenant_id,v_branch,v_customer_id,p_enrolment_id,p_method,'confirmed',round(p_amount,2),nullif(trim(p_reference),''),trim(p_idempotency_key),'staff',v_user,now(),jsonb_build_object('notes',p_notes))
 returning id into v_payment_id;

 if p_enrolment_id is not null then
   insert into public.scheme_transactions(tenant_id,branch_id,enrolment_id,transaction_type,status,amount,reference,idempotency_key,notes,actor_user_id,confirmed_at)
   values(p_tenant_id,v_branch,p_enrolment_id,'contribution','confirmed',round(p_amount,2),coalesce(nullif(trim(p_reference),''),v_payment_id::text),'payment:'||trim(p_idempotency_key),p_notes,v_user,now());
   for inst in select id,amount_due,amount_paid from public.scheme_installments
     where tenant_id=p_tenant_id and enrolment_id=p_enrolment_id and status not in ('paid','waived','cancelled')
       and amount_paid<amount_due order by due_date,installment_no for update
   loop
     exit when v_remaining<=0;
     v_allocation:=least(v_remaining,inst.amount_due-inst.amount_paid);
     update public.scheme_installments set amount_paid=amount_paid+v_allocation,
       status=case when amount_paid+v_allocation>=amount_due then 'paid' else 'partial' end,
       paid_at=case when amount_paid+v_allocation>=amount_due then now() else null end,
       updated_at=now() where id=inst.id;
     v_remaining:=v_remaining-v_allocation;
   end loop;
 end if;

 v_receipt_number:='RCPT-'||to_char(now(),'YYYYMMDD')||'-'||upper(substr(replace(gen_random_uuid()::text,'-',''),1,8));
 insert into public.receipts(tenant_id,branch_id,payment_id,enrolment_id,receipt_number,receipt_type,snapshot,issued_by)
 values(p_tenant_id,v_branch,v_payment_id,p_enrolment_id,v_receipt_number,'payment',
   jsonb_build_object('payment_id',v_payment_id,'amount',round(p_amount,2),'currency','INR','method',p_method,'reference',p_reference,'customer_id',v_customer_id,'notes',p_notes,'confirmed_at',now()),v_user);

 insert into public.audit_logs(tenant_id,actor_user_id,event_name,entity_type,entity_id,details)
 values(p_tenant_id,v_user,'payment.manual_confirmed','payment',v_payment_id::text,jsonb_build_object('amount',round(p_amount,2),'method',p_method,'enrolment_id',p_enrolment_id,'receipt_number',v_receipt_number));
 return v_payment_id;
end;
$$;

-- Replace public API endpoints with invoker wrappers. The privileged implementations above remain private.
create or replace function public.create_tenant_onboarding(p_display_name text,p_slug text,p_state text default 'Tamil Nadu',p_city text default null,p_district text default null,p_locality text default null)
returns uuid language sql security invoker set search_path=public,private,pg_temp
as $$ select private.create_tenant_onboarding(p_display_name,p_slug,p_state,p_city,p_district,p_locality); $$;
create or replace function public.create_scheme_draft(p_tenant_id uuid,p_name text,p_description text,p_scheme_type text,p_terms jsonb)
returns uuid language sql security invoker set search_path=public,private,pg_temp
as $$ select private.create_scheme_draft(p_tenant_id,p_name,p_description,p_scheme_type,p_terms); $$;
create or replace function public.publish_scheme_draft(p_tenant_id uuid,p_scheme_id uuid,p_owner_approved boolean)
returns void language plpgsql security invoker set search_path=public,private,pg_temp
as $$ begin perform private.publish_scheme_draft(p_tenant_id,p_scheme_id,p_owner_approved); end; $$;
create or replace function public.record_manual_payment(p_tenant_id uuid,p_branch_id uuid,p_customer_id uuid,p_enrolment_id uuid,p_amount numeric,p_method text,p_reference text,p_idempotency_key text,p_notes text default null)
returns uuid language sql security invoker set search_path=public,private,pg_temp
as $$ select private.record_manual_payment(p_tenant_id,p_branch_id,p_customer_id,p_enrolment_id,p_amount,p_method,p_reference,p_idempotency_key,p_notes); $$;

revoke execute on function public.create_tenant_onboarding(text,text,text,text,text,text) from public,anon;
revoke execute on function public.create_scheme_draft(uuid,text,text,text,jsonb) from public,anon;
revoke execute on function public.publish_scheme_draft(uuid,uuid,boolean) from public,anon;
revoke execute on function public.record_manual_payment(uuid,uuid,uuid,uuid,numeric,text,text,text,text) from public,anon;
grant execute on function public.create_tenant_onboarding(text,text,text,text,text,text) to authenticated;
grant execute on function public.create_scheme_draft(uuid,text,text,text,jsonb) to authenticated;
grant execute on function public.publish_scheme_draft(uuid,uuid,boolean) to authenticated;
grant execute on function public.record_manual_payment(uuid,uuid,uuid,uuid,numeric,text,text,text,text) to authenticated;

-- Customer scheme enrolment + due-date schedule are committed in one database transaction.
create or replace function private.create_scheme_enrolment(
 p_tenant_id uuid,p_branch_id uuid,p_customer_id uuid,p_scheme_version_id uuid,p_terms_accepted boolean
)
returns uuid language plpgsql security definer set search_path=public,private,pg_temp as $$
declare
 v_user uuid:=auth.uid(); v_scheme_id uuid; v_scheme_type text; v_status text;
 v_version integer; v_terms jsonb; v_tenure integer; v_monthly numeric(14,2);
 v_enrolment_id uuid; v_code text; v_maturity date; i integer; v_customer_branch uuid;
begin
 if v_user is null then raise exception 'Authentication required' using errcode='42501'; end if;
 if p_terms_accepted is not true then raise exception 'Customer acceptance of scheme terms must be recorded'; end if;
 if not private.has_tenant_branch_access(p_tenant_id,p_branch_id,array['owner','manager','scheme_manager','cashier','employee']) then raise exception 'Permission denied' using errcode='42501'; end if;
 select c.branch_id into v_customer_branch from public.tenant_customers c where c.tenant_id=p_tenant_id and c.id=p_customer_id and c.status='active';
 if not found then raise exception 'Active customer not found'; end if;
 if not private.has_tenant_branch_access(p_tenant_id,v_customer_branch,array['owner','manager','scheme_manager','cashier','employee']) then raise exception 'Permission denied for the customer branch' using errcode='42501'; end if;
 select st.id,st.scheme_type,st.status,st.current_version,sv.terms
 into v_scheme_id,v_scheme_type,v_status,v_version,v_terms
 from public.scheme_versions sv join public.scheme_templates st on st.tenant_id=sv.tenant_id and st.id=sv.scheme_id
 where sv.tenant_id=p_tenant_id and sv.id=p_scheme_version_id;
 if not found or v_status<>'published' or v_version<>(select version_no from public.scheme_versions where id=p_scheme_version_id) then
  raise exception 'Select the current version of a published scheme';
 end if;
 if v_scheme_type='fixed_monthly' then
  v_tenure:=coalesce((v_terms->>'tenure_months')::integer,0);
  v_monthly:=coalesce((v_terms->>'monthly_instalment_inr')::numeric,0);
  if v_tenure not between 1 and 120 or v_monthly<=0 then raise exception 'Published monthly scheme terms are incomplete'; end if;
  v_maturity:=(current_date+make_interval(months=>v_tenure))::date;
 end if;
 v_code:='ENR-'||to_char(now(),'YYYYMMDD')||'-'||upper(substr(replace(gen_random_uuid()::text,'-',''),1,8));
 insert into public.scheme_enrolments(tenant_id,branch_id,customer_id,scheme_version_id,enrolment_code,status,start_date,maturity_date,agreed_terms,terms_accepted_at,created_by)
 values(p_tenant_id,p_branch_id,p_customer_id,p_scheme_version_id,v_code,'active',current_date,v_maturity,v_terms,now(),v_user)
 returning id into v_enrolment_id;
 if v_scheme_type='fixed_monthly' then
  for i in 1..v_tenure loop
   insert into public.scheme_installments(tenant_id,branch_id,enrolment_id,installment_no,due_date,amount_due,status)
   values(p_tenant_id,p_branch_id,v_enrolment_id,i,(current_date+make_interval(months=>i))::date,v_monthly,'upcoming');
  end loop;
 end if;
 insert into public.customer_consents(tenant_id,customer_id,consent_type,consented,terms_version,source,captured_by,metadata)
 values(p_tenant_id,p_customer_id,'scheme_terms',true,v_version::text,'staff_attestation',v_user,jsonb_build_object('enrolment_id',v_enrolment_id,'scheme_id',v_scheme_id,'terms',v_terms));
 insert into public.audit_logs(tenant_id,actor_user_id,event_name,entity_type,entity_id,details)
 values(p_tenant_id,v_user,'scheme.enrolment_created','scheme_enrolment',v_enrolment_id::text,jsonb_build_object('customer_id',p_customer_id,'scheme_id',v_scheme_id,'terms_version',v_version));
 return v_enrolment_id;
end;
$$;
revoke execute on function private.create_scheme_enrolment(uuid,uuid,uuid,uuid,boolean) from public,anon;
grant execute on function private.create_scheme_enrolment(uuid,uuid,uuid,uuid,boolean) to authenticated;
create or replace function public.create_scheme_enrolment(p_tenant_id uuid,p_branch_id uuid,p_customer_id uuid,p_scheme_version_id uuid,p_terms_accepted boolean)
returns uuid language sql security invoker set search_path=public,private,pg_temp
as $$ select private.create_scheme_enrolment(p_tenant_id,p_branch_id,p_customer_id,p_scheme_version_id,p_terms_accepted); $$;
revoke execute on function public.create_scheme_enrolment(uuid,uuid,uuid,uuid,boolean) from public,anon;
grant execute on function public.create_scheme_enrolment(uuid,uuid,uuid,uuid,boolean) to authenticated;

-- One trusted operation creates an invoice with a full item/rate/charge snapshot.
create or replace function private.create_draft_invoice(
 p_tenant_id uuid,p_branch_id uuid,p_customer_id uuid,p_description text,p_quantity numeric,
 p_weight_grams numeric,p_rate_per_gram numeric,p_making_amount numeric,p_wastage_amount numeric,
 p_other_charges numeric,p_discount_amount numeric,p_tax_rate numeric
)
returns uuid language plpgsql security definer set search_path=public,private,pg_temp as $$
declare
 v_user uuid:=auth.uid(); v_invoice_id uuid; v_customer jsonb; v_invoice_no text;
 v_metal_value numeric(14,2); v_subtotal numeric(14,2); v_tax numeric(14,2); v_total numeric(14,2);
begin
 if v_user is null then raise exception 'Authentication required' using errcode='42501'; end if;
 if not private.has_tenant_branch_access(p_tenant_id,p_branch_id,array['owner','manager','cashier','accountant']) then raise exception 'Permission denied' using errcode='42501'; end if;
 if trim(coalesce(p_description,''))='' then raise exception 'Item description is required'; end if;
 if p_quantity is null or p_quantity<=0 or p_weight_grams is null or p_weight_grams<0 or p_rate_per_gram is null or p_rate_per_gram<0 then raise exception 'Quantity, weight or price is invalid'; end if;
 if coalesce(p_making_amount,0)<0 or coalesce(p_wastage_amount,0)<0 or coalesce(p_other_charges,0)<0 or coalesce(p_discount_amount,0)<0 or coalesce(p_tax_rate,0)<0 or p_tax_rate>100 then raise exception 'Charge or tax input is invalid'; end if;
 if p_customer_id is not null then
   select jsonb_build_object('id',id,'name',full_name,'mobile',mobile_e164,'customer_code',customer_code) into v_customer
   from public.tenant_customers where tenant_id=p_tenant_id and id=p_customer_id;
   if not found then raise exception 'Customer not found for this shop'; end if;
 end if;
 v_metal_value:=round(p_weight_grams*p_rate_per_gram,2);
 v_subtotal:=greatest(0,round(v_metal_value+coalesce(p_making_amount,0)+coalesce(p_wastage_amount,0)+coalesce(p_other_charges,0)-coalesce(p_discount_amount,0),2));
 v_tax:=round(v_subtotal*coalesce(p_tax_rate,0)/100,0);
 v_total:=v_subtotal+v_tax;
 v_invoice_no:='INV-'||to_char(now(),'YYYYMMDD')||'-'||upper(substr(replace(gen_random_uuid()::text,'-',''),1,8));
 insert into public.invoices(tenant_id,branch_id,customer_id,invoice_number,status,subtotal,discount_amount,taxable_amount,cgst_amount,sgst_amount,igst_amount,total_amount,amount_paid,customer_snapshot,tax_snapshot,rate_snapshot,created_by)
 values(p_tenant_id,p_branch_id,p_customer_id,v_invoice_no,'draft',round(v_metal_value+coalesce(p_making_amount,0)+coalesce(p_wastage_amount,0)+coalesce(p_other_charges,0),2),coalesce(p_discount_amount,0),v_subtotal,0,0,v_tax,v_total,0,coalesce(v_customer,'{}'::jsonb),jsonb_build_object('tax_rate_percent',coalesce(p_tax_rate,0),'tax_amount',v_tax),jsonb_build_object('price_per_gram',p_rate_per_gram,'weight_grams',p_weight_grams),v_user)
 returning id into v_invoice_id;
 insert into public.invoice_lines(tenant_id,invoice_id,line_number,description,quantity,net_metal_weight_grams,rate_per_gram,making_amount,wastage_amount,other_charges,discount_amount,tax_rate,tax_amount,line_total,item_snapshot)
 values(p_tenant_id,v_invoice_id,1,trim(p_description),p_quantity,p_weight_grams,p_rate_per_gram,coalesce(p_making_amount,0),coalesce(p_wastage_amount,0),coalesce(p_other_charges,0),coalesce(p_discount_amount,0),coalesce(p_tax_rate,0),v_tax,v_total,jsonb_build_object('description',trim(p_description),'quantity',p_quantity,'weight_grams',p_weight_grams,'rate_per_gram',p_rate_per_gram));
 insert into public.audit_logs(tenant_id,actor_user_id,event_name,entity_type,entity_id,details)
 values(p_tenant_id,v_user,'invoice.draft_created','invoice',v_invoice_id::text,jsonb_build_object('invoice_number',v_invoice_no,'total_amount',v_total));
 return v_invoice_id;
end;
$$;
revoke execute on function private.create_draft_invoice(uuid,uuid,uuid,text,numeric,numeric,numeric,numeric,numeric,numeric,numeric,numeric) from public,anon;
grant execute on function private.create_draft_invoice(uuid,uuid,uuid,text,numeric,numeric,numeric,numeric,numeric,numeric,numeric,numeric) to authenticated;
create or replace function public.create_draft_invoice(p_tenant_id uuid,p_branch_id uuid,p_customer_id uuid,p_description text,p_quantity numeric,p_weight_grams numeric,p_rate_per_gram numeric,p_making_amount numeric,p_wastage_amount numeric,p_other_charges numeric,p_discount_amount numeric,p_tax_rate numeric)
returns uuid language sql security invoker set search_path=public,private,pg_temp
as $$ select private.create_draft_invoice(p_tenant_id,p_branch_id,p_customer_id,p_description,p_quantity,p_weight_grams,p_rate_per_gram,p_making_amount,p_wastage_amount,p_other_charges,p_discount_amount,p_tax_rate); $$;
revoke execute on function public.create_draft_invoice(uuid,uuid,uuid,text,numeric,numeric,numeric,numeric,numeric,numeric,numeric,numeric) from public,anon;
grant execute on function public.create_draft_invoice(uuid,uuid,uuid,text,numeric,numeric,numeric,numeric,numeric,numeric,numeric,numeric) to authenticated;

-- Finalize by freezing price/charge/tax history. Further changes require reversal/credit-note flows.
create or replace function private.finalize_invoice(p_tenant_id uuid,p_invoice_id uuid)
returns void language plpgsql security definer set search_path=public,private,pg_temp as $$
declare v_user uuid:=auth.uid(); v_branch uuid; v_status text; v_lines integer; v_subtotal numeric(14,2); v_discount numeric(14,2); v_tax numeric(14,2); v_total numeric(14,2);
begin
 if v_user is null then raise exception 'Authentication required' using errcode='42501'; end if;
 select branch_id,status into v_branch,v_status from public.invoices where tenant_id=p_tenant_id and id=p_invoice_id for update;
 if not found then raise exception 'Invoice not found'; end if;
 if v_status<>'draft' then raise exception 'Only draft invoices can be issued'; end if;
 if not private.has_tenant_branch_access(p_tenant_id,v_branch,array['owner','manager','cashier','accountant']) then raise exception 'Permission denied' using errcode='42501'; end if;
 select count(*),coalesce(sum(line_total-tax_amount),0),coalesce(sum(discount_amount),0),coalesce(sum(tax_amount),0),coalesce(sum(line_total),0)
 into v_lines,v_subtotal,v_discount,v_tax,v_total from public.invoice_lines where tenant_id=p_tenant_id and invoice_id=p_invoice_id;
 if v_lines=0 then raise exception 'Add at least one invoice line before issuing'; end if;
 update public.invoices set status=case when v_total=0 then 'issued' else 'issued' end,
   subtotal=v_subtotal+v_discount,taxable_amount=v_subtotal,discount_amount=v_discount,igst_amount=v_tax,cgst_amount=0,sgst_amount=0,total_amount=v_total,issued_at=now(),updated_at=now()
 where tenant_id=p_tenant_id and id=p_invoice_id;
 insert into public.audit_logs(tenant_id,actor_user_id,event_name,entity_type,entity_id,details)
 values(p_tenant_id,v_user,'invoice.issued','invoice',p_invoice_id::text,jsonb_build_object('total_amount',v_total));
end;
$$;
revoke execute on function private.finalize_invoice(uuid,uuid) from public,anon;
grant execute on function private.finalize_invoice(uuid,uuid) to authenticated;
create or replace function public.finalize_invoice(p_tenant_id uuid,p_invoice_id uuid)
returns void language plpgsql security invoker set search_path=public,private,pg_temp
as $$ begin perform private.finalize_invoice(p_tenant_id,p_invoice_id); end; $$;
revoke execute on function public.finalize_invoice(uuid,uuid) from public,anon;
grant execute on function public.finalize_invoice(uuid,uuid) to authenticated;

-- Issued/paid invoices cannot be silently edited or deleted from browser code.
create or replace function private.prevent_invoice_history_edit()
returns trigger language plpgsql security definer set search_path=public,private,pg_temp as $$
begin
 if old.status<>'draft' then raise exception 'Issued invoice history is immutable; use an audited credit-note or reversal workflow'; end if;
 if tg_op='DELETE' then raise exception 'Invoice drafts cannot be deleted from the API; cancel them using an authorised workflow'; end if;
 return new;
end;
$$;
revoke execute on function private.prevent_invoice_history_edit() from public,anon,authenticated;
drop trigger if exists prevent_invoice_history_edit on public.invoices;
create trigger prevent_invoice_history_edit before update or delete on public.invoices
for each row execute procedure private.prevent_invoice_history_edit();

-- Staff invitations store only a hash; plaintext tokens are returned to the owner once for trusted sharing.
create or replace function private.create_staff_invitation(p_tenant_id uuid,p_branch_id uuid,p_role text,p_invitee_mobile text,p_invitee_email text,p_permissions jsonb default '{}'::jsonb)
returns jsonb language plpgsql security definer set search_path=public,private,pg_temp as $$
declare v_user uuid:=auth.uid(); v_token text; v_invite_id uuid;
begin
 if v_user is null then raise exception 'Authentication required' using errcode='42501'; end if;
 if not private.has_tenant_branch_access(p_tenant_id,p_branch_id,array['owner','manager']) then raise exception 'Permission denied' using errcode='42501'; end if;
 if p_role not in ('manager','accountant','cashier','scheme_manager','inventory_manager','employee') then raise exception 'Invalid staff role'; end if;
 if nullif(trim(p_invitee_mobile),'') is null and nullif(trim(p_invitee_email),'') is null then raise exception 'Provide a staff mobile number or email'; end if;
 v_token:=encode(gen_random_bytes(32),'hex');
 insert into public.staff_invitations(tenant_id,branch_id,invitee_mobile,invitee_email,role,permissions,token_hash,expires_at,created_by)
 values(p_tenant_id,p_branch_id,nullif(trim(p_invitee_mobile),''),nullif(trim(p_invitee_email),''),p_role,coalesce(p_permissions,'{}'::jsonb),encode(digest(v_token,'sha256'),'hex'),now()+interval '7 days',v_user)
 returning id into v_invite_id;
 insert into public.audit_logs(tenant_id,actor_user_id,event_name,entity_type,entity_id,details)
 values(p_tenant_id,v_user,'staff.invitation_created','staff_invitation',v_invite_id::text,jsonb_build_object('role',p_role,'expires_at',now()+interval '7 days'));
 return jsonb_build_object('invitation_id',v_invite_id,'token',v_token,'expires_at',now()+interval '7 days');
end;
$$;
revoke execute on function private.create_staff_invitation(uuid,uuid,text,text,text,jsonb) from public,anon;
grant execute on function private.create_staff_invitation(uuid,uuid,text,text,text,jsonb) to authenticated;
create or replace function public.create_staff_invitation(p_tenant_id uuid,p_branch_id uuid,p_role text,p_invitee_mobile text,p_invitee_email text,p_permissions jsonb default '{}'::jsonb)
returns jsonb language sql security invoker set search_path=public,private,pg_temp
as $$ select private.create_staff_invitation(p_tenant_id,p_branch_id,p_role,p_invitee_mobile,p_invitee_email,p_permissions); $$;
revoke execute on function public.create_staff_invitation(uuid,uuid,text,text,text,jsonb) from public,anon;
grant execute on function public.create_staff_invitation(uuid,uuid,text,text,text,jsonb) to authenticated;

create or replace function private.accept_staff_invitation(p_token text)
returns uuid language plpgsql security definer set search_path=public,private,pg_temp as $$
declare v_user uuid:=auth.uid(); v_auth_email text; v_auth_phone text; v_inv public.staff_invitations%rowtype; v_membership uuid;
begin
 if v_user is null then raise exception 'Authentication required' using errcode='42501'; end if;
 select email,phone into v_auth_email,v_auth_phone from auth.users where id=v_user;
 select * into v_inv from public.staff_invitations
 where token_hash=encode(digest(p_token,'sha256'),'hex') and accepted_at is null and revoked_at is null and expires_at>now()
 for update;
 if not found then raise exception 'Invitation is invalid, expired or already used'; end if;
 if v_inv.invitee_email is not null and lower(v_inv.invitee_email)<>lower(coalesce(v_auth_email,'')) then raise exception 'Signed-in email does not match this invitation'; end if;
 if v_inv.invitee_mobile is not null and regexp_replace(v_inv.invitee_mobile,'[^0-9]','','g')<>regexp_replace(coalesce(v_auth_phone,''),'[^0-9]','','g') then raise exception 'Verified mobile number does not match this invitation'; end if;
 if exists(select 1 from public.tenant_memberships where tenant_id=v_inv.tenant_id and user_id=v_user) then raise exception 'User is already a member of this shop'; end if;
 insert into public.tenant_memberships(tenant_id,user_id,branch_id,role,permissions,is_active)
 values(v_inv.tenant_id,v_user,v_inv.branch_id,v_inv.role,v_inv.permissions,true) returning id into v_membership;
 update public.staff_invitations set accepted_by=v_user,accepted_at=now() where id=v_inv.id;
 insert into public.audit_logs(tenant_id,actor_user_id,event_name,entity_type,entity_id,details)
 values(v_inv.tenant_id,v_user,'staff.invitation_accepted','tenant_membership',v_membership::text,jsonb_build_object('role',v_inv.role,'branch_id',v_inv.branch_id));
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

-- Legacy direct insert/update/delete permissions on memberships are limited to trusted invite/onboarding flows.
revoke insert,update,delete on public.tenant_memberships from public,anon,authenticated;
grant select on public.tenant_memberships to authenticated;

-- Basic server-side valuation approval records reviewer and preserves estimate snapshot.
create or replace function private.approve_old_gold_valuation(p_tenant_id uuid,p_valuation_id uuid,p_approved boolean,p_final_value numeric default null,p_notes text default null)
returns void language plpgsql security definer set search_path=public,private,pg_temp as $$
declare v_user uuid:=auth.uid(); v_branch uuid; v_status text;
begin
 if v_user is null then raise exception 'Authentication required' using errcode='42501'; end if;
 select branch_id,status into v_branch,v_status from public.old_gold_valuations where tenant_id=p_tenant_id and id=p_valuation_id for update;
 if not found then raise exception 'Valuation not found'; end if;
 if not private.has_tenant_branch_access(p_tenant_id,v_branch,array['owner','manager']) then raise exception 'Permission denied' using errcode='42501'; end if;
 if v_status not in ('estimate','approved') then raise exception 'Only estimates can be approved'; end if;
 if p_approved is true and (p_final_value is null or p_final_value<0) then raise exception 'A non-negative final value is required'; end if;
 update public.old_gold_valuations set status=case when p_approved then 'approved' else 'rejected' end,
   final_value=case when p_approved then p_final_value else null end,approved_by=v_user,approved_at=now(),
   testing_notes=concat_ws(E'\n',testing_notes,nullif(trim(p_notes),'')) where tenant_id=p_tenant_id and id=p_valuation_id;
 insert into public.audit_logs(tenant_id,actor_user_id,event_name,entity_type,entity_id,details)
 values(p_tenant_id,v_user,'old_gold.valuation_reviewed','old_gold_valuation',p_valuation_id::text,jsonb_build_object('approved',p_approved,'final_value',p_final_value,'notes',p_notes));
end;
$$;
revoke execute on function private.approve_old_gold_valuation(uuid,uuid,boolean,numeric,text) from public,anon;
grant execute on function private.approve_old_gold_valuation(uuid,uuid,boolean,numeric,text) to authenticated;
create or replace function public.approve_old_gold_valuation(p_tenant_id uuid,p_valuation_id uuid,p_approved boolean,p_final_value numeric default null,p_notes text default null)
returns void language plpgsql security invoker set search_path=public,private,pg_temp
as $$ begin perform private.approve_old_gold_valuation(p_tenant_id,p_valuation_id,p_approved,p_final_value,p_notes); end; $$;
revoke execute on function public.approve_old_gold_valuation(uuid,uuid,boolean,numeric,text) from public,anon;
grant execute on function public.approve_old_gold_valuation(uuid,uuid,boolean,numeric,text) to authenticated;

commit;
