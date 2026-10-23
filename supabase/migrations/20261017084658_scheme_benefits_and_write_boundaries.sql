-- Restrict high-value mutations to audited database workflows, and add benefit/redemption workflows.
begin;

-- High-risk lifecycle and financial tables are read-only to browser clients.
revoke insert,update,delete on public.scheme_enrolments,public.scheme_installments,public.scheme_benefits,public.scheme_redemptions from public,anon,authenticated;
grant select on public.scheme_enrolments,public.scheme_installments,public.scheme_benefits,public.scheme_redemptions to authenticated;
revoke insert,update,delete on public.payment_orders,public.invoices,public.invoice_lines,public.sales,public.sale_items,public.products from public,anon,authenticated;
grant select on public.payment_orders,public.invoices,public.invoice_lines,public.sales,public.sale_items,public.products to authenticated;
revoke insert,update,delete on public.notifications from public,anon,authenticated;
grant select on public.notifications to authenticated;

drop policy if exists enrolments_insert_staff on public.scheme_enrolments;
drop policy if exists enrolments_branch_insert on public.scheme_enrolments;
drop policy if exists enrolments_update_managers on public.scheme_enrolments;
drop policy if exists enrolments_branch_update on public.scheme_enrolments;
drop policy if exists installments_managers_insert on public.scheme_installments;
drop policy if exists installments_managers_update on public.scheme_installments;
drop policy if exists benefits_managers_insert on public.scheme_benefits;
drop policy if exists benefits_owner_update on public.scheme_benefits;
drop policy if exists redemptions_staff_insert on public.scheme_redemptions;
drop policy if exists redemptions_owner_update on public.scheme_redemptions;
drop policy if exists notifications_staff_enqueue on public.notifications;

-- Calculate eligibility from the exact accepted terms snapshot and the actual confirmed instalment schedule.
create or replace function private.evaluate_scheme_benefit(p_tenant_id uuid,p_enrolment_id uuid)
returns uuid language plpgsql security definer set search_path=public,private,pg_temp as $$
declare
 v_user uuid:=auth.uid(); v_enrol public.scheme_enrolments%rowtype; v_type text; v_terms jsonb; v_scheme_type text;
 v_total_due numeric(14,2);v_total_paid numeric(14,2);v_unpaid integer;v_benefit_type text;v_value numeric(14,2);v_weight numeric(14,6);v_existing uuid;
begin
 if v_user is null then raise exception 'Authentication required' using errcode='42501';end if;
 select * into v_enrol from public.scheme_enrolments where tenant_id=p_tenant_id and id=p_enrolment_id for update;
 if not found then raise exception 'Enrolment not found';end if;
 if not private.has_tenant_branch_access(p_tenant_id,v_enrol.branch_id,array['owner','manager','scheme_manager','accountant']) then
   if not private.is_linked_customer(p_tenant_id,v_enrol.customer_id) then raise exception 'Permission denied' using errcode='42501';end if;
 end if;
 if v_enrol.status in ('cancelled','disputed','redeemed') then raise exception 'This enrolment is not eligible for maturity evaluation';end if;
 select st.scheme_type,sv.terms into v_scheme_type,v_terms
 from public.scheme_versions sv join public.scheme_templates st on st.tenant_id=sv.tenant_id and st.id=sv.scheme_id
 where sv.tenant_id=p_tenant_id and sv.id=v_enrol.scheme_version_id;
 if not found then raise exception 'Accepted scheme version not found';end if;
 if v_enrol.maturity_date is null or v_enrol.maturity_date>current_date then raise exception 'Scheme has not reached its maturity date';end if;
 select count(*) filter(where amount_paid<amount_due and status not in ('waived','cancelled')),
        coalesce(sum(amount_due),0),coalesce(sum(amount_paid),0)
 into v_unpaid,v_total_due,v_total_paid from public.scheme_installments
 where tenant_id=p_tenant_id and enrolment_id=p_enrolment_id;
 if v_unpaid>0 or (v_total_due>0 and v_total_paid<v_total_due) then raise exception 'All scheduled instalments must be paid or formally waived before maturity';end if;
 if v_scheme_type='fixed_monthly' and coalesce(v_terms->>'benefit_type','none') not in ('none','') then
   v_benefit_type:=case v_terms->>'benefit_type'
     when 'gold_weight_bonus' then 'gold_weight_bonus'
     when 'making_charge_discount' then 'making_discount'
     else 'purchase_credit' end;
   if v_terms->>'benefit_type'='one_instalment_equivalent' then
     v_value:=round(coalesce((v_terms->>'monthly_instalment_inr')::numeric,0)*coalesce((v_terms->>'benefit_equivalent_monthly_instalments')::numeric,1),2);
   elsif v_terms ? 'benefit_amount_inr' then
     v_value:=round((v_terms->>'benefit_amount_inr')::numeric,2);
   end if;
   if v_terms ? 'benefit_weight_grams' then v_weight:=round((v_terms->>'benefit_weight_grams')::numeric,6);end if;
   if v_benefit_type='gold_weight_bonus' and coalesce(v_weight,0)<=0 then raise exception 'Published terms do not define a positive gold-weight bonus; no benefit can be granted';end if;
   if v_benefit_type<>'gold_weight_bonus' and coalesce(v_value,0)<=0 then raise exception 'Published terms do not define a positive benefit value; no benefit can be granted';end if;
   select id into v_existing from public.scheme_benefits where tenant_id=p_tenant_id and enrolment_id=p_enrolment_id and status not in ('cancelled','forfeited') limit 1;
   if v_existing is not null then return v_existing;end if;
   insert into public.scheme_benefits(tenant_id,enrolment_id,benefit_type,status,amount_value,weight_grams,rules_snapshot,eligible_at)
   values(p_tenant_id,p_enrolment_id,v_benefit_type,'eligible',v_value,v_weight,
     jsonb_build_object('terms',v_terms,'scheduled_due',v_total_due,'scheduled_paid',v_total_paid,'evaluated_at',now()),now())
   returning id into v_existing;
   update public.scheme_enrolments set status='matured' where tenant_id=p_tenant_id and id=p_enrolment_id and status in ('active','completed');
   insert into public.audit_logs(tenant_id,actor_user_id,event_name,entity_type,entity_id,details)
   values(p_tenant_id,v_user,'scheme.benefit_eligible','scheme_benefit',v_existing::text,jsonb_build_object('enrolment_id',p_enrolment_id,'benefit_type',v_benefit_type,'amount_value',v_value,'weight_grams',v_weight));
   return v_existing;
 else
   update public.scheme_enrolments set status='matured' where tenant_id=p_tenant_id and id=p_enrolment_id and status in ('active','completed');
   insert into public.audit_logs(tenant_id,actor_user_id,event_name,entity_type,entity_id,details)
   values(p_tenant_id,v_user,'scheme.matured_no_benefit','scheme_enrolment',p_enrolment_id::text,jsonb_build_object('scheduled_due',v_total_due,'scheduled_paid',v_total_paid));
   return null;
 end if;
end;
$$;
revoke execute on function private.evaluate_scheme_benefit(uuid,uuid) from public,anon;
grant execute on function private.evaluate_scheme_benefit(uuid,uuid) to authenticated;
create or replace function public.evaluate_scheme_benefit(p_tenant_id uuid,p_enrolment_id uuid)
returns uuid language sql security invoker set search_path=public,private,pg_temp as $$ select private.evaluate_scheme_benefit(p_tenant_id,p_enrolment_id); $$;
revoke execute on function public.evaluate_scheme_benefit(uuid,uuid) from public,anon;
grant execute on function public.evaluate_scheme_benefit(uuid,uuid) to authenticated;

create or replace function private.review_scheme_benefit(p_tenant_id uuid,p_benefit_id uuid,p_action text,p_notes text default null)
returns void language plpgsql security definer set search_path=public,private,pg_temp as $$
declare v_user uuid:=auth.uid();v_benefit public.scheme_benefits%rowtype;
begin
 if v_user is null then raise exception 'Authentication required' using errcode='42501';end if;
 if not private.has_tenant_role(p_tenant_id,array['owner','manager']) then raise exception 'Owner/manager permission required' using errcode='42501';end if;
 if p_action not in ('approve','forfeit','cancel') then raise exception 'Invalid benefit review action';end if;
 select * into v_benefit from public.scheme_benefits where tenant_id=p_tenant_id and id=p_benefit_id for update;
 if not found then raise exception 'Benefit not found';end if;
 if v_benefit.status<>'eligible' then raise exception 'Only eligible benefits can be reviewed';end if;
 update public.scheme_benefits set status=case p_action when 'approve' then 'approved' when 'forfeit' then 'forfeited' else 'cancelled' end,
   approved_by=case when p_action='approve' then v_user else null end,approved_at=case when p_action='approve' then now() else null end,
   rules_snapshot=rules_snapshot||jsonb_build_object('review_action',p_action,'review_notes',p_notes,'reviewed_at',now(),'reviewed_by',v_user)
 where tenant_id=p_tenant_id and id=p_benefit_id;
 insert into public.audit_logs(tenant_id,actor_user_id,event_name,entity_type,entity_id,details)
 values(p_tenant_id,v_user,'scheme.benefit_reviewed','scheme_benefit',p_benefit_id::text,jsonb_build_object('action',p_action,'notes',p_notes));
end;
$$;
revoke execute on function private.review_scheme_benefit(uuid,uuid,text,text) from public,anon;
grant execute on function private.review_scheme_benefit(uuid,uuid,text,text) to authenticated;
create or replace function public.review_scheme_benefit(p_tenant_id uuid,p_benefit_id uuid,p_action text,p_notes text default null)
returns void language plpgsql security invoker set search_path=public,private,pg_temp as $$ begin perform private.review_scheme_benefit(p_tenant_id,p_benefit_id,p_action,p_notes);end; $$;
revoke execute on function public.review_scheme_benefit(uuid,uuid,text,text) from public,anon;
grant execute on function public.review_scheme_benefit(uuid,uuid,text,text) to authenticated;

create or replace function private.request_scheme_redemption(p_tenant_id uuid,p_branch_id uuid,p_enrolment_id uuid,p_benefit_id uuid,p_value_inr numeric default null,p_weight_grams numeric default null,p_notes text default null)
returns uuid language plpgsql security definer set search_path=public,private,pg_temp as $$
declare v_user uuid:=auth.uid();v_enrol public.scheme_enrolments%rowtype;v_benefit public.scheme_benefits%rowtype;v_code text;v_id uuid;
begin
 if v_user is null then raise exception 'Authentication required' using errcode='42501';end if;
 select * into v_enrol from public.scheme_enrolments where tenant_id=p_tenant_id and id=p_enrolment_id for update;
 if not found then raise exception 'Enrolment not found';end if;
 if not private.is_linked_customer(p_tenant_id,v_enrol.customer_id) and not private.has_tenant_branch_access(p_tenant_id,p_branch_id,array['owner','manager','scheme_manager','cashier']) then
   raise exception 'Permission denied' using errcode='42501';
 end if;
 select * into v_benefit from public.scheme_benefits where tenant_id=p_tenant_id and id=p_benefit_id and enrolment_id=p_enrolment_id for update;
 if not found or v_benefit.status not in ('eligible','approved') then raise exception 'Benefit is not eligible for redemption';end if;
 if v_benefit.benefit_type='gold_weight_bonus' then
   if coalesce(p_weight_grams,0)<=0 or p_weight_grams>coalesce(v_benefit.weight_grams,0) then raise exception 'Requested gold weight is outside the eligible benefit';end if;
 else
   if coalesce(p_value_inr,0)<=0 or p_value_inr>coalesce(v_benefit.amount_value,0) then raise exception 'Requested value is outside the eligible benefit';end if;
 end if;
 if exists(select 1 from public.scheme_redemptions where tenant_id=p_tenant_id and benefit_id=p_benefit_id and status in ('requested','approved','completed')) then
   raise exception 'A redemption is already open or completed for this benefit';
 end if;
 v_code:='RED-'||to_char(now(),'YYYYMMDD')||'-'||upper(substr(replace(gen_random_uuid()::text,'-',''),1,8));
 insert into public.scheme_redemptions(tenant_id,branch_id,enrolment_id,benefit_id,redemption_code,status,value_inr,weight_grams,notes)
 values(p_tenant_id,p_branch_id,p_enrolment_id,p_benefit_id,v_code,'requested',coalesce(p_value_inr,0),coalesce(p_weight_grams,0),nullif(trim(p_notes),'')) returning id into v_id;
 insert into public.audit_logs(tenant_id,actor_user_id,event_name,entity_type,entity_id,details)
 values(p_tenant_id,v_user,'scheme.redemption_requested','scheme_redemption',v_id::text,jsonb_build_object('benefit_id',p_benefit_id,'value_inr',p_value_inr,'weight_grams',p_weight_grams));
 return v_id;
end;
$$;
revoke execute on function private.request_scheme_redemption(uuid,uuid,uuid,uuid,numeric,numeric,text) from public,anon;
grant execute on function private.request_scheme_redemption(uuid,uuid,uuid,uuid,numeric,numeric,text) to authenticated;
create or replace function public.request_scheme_redemption(p_tenant_id uuid,p_branch_id uuid,p_enrolment_id uuid,p_benefit_id uuid,p_value_inr numeric default null,p_weight_grams numeric default null,p_notes text default null)
returns uuid language sql security invoker set search_path=public,private,pg_temp as $$ select private.request_scheme_redemption(p_tenant_id,p_branch_id,p_enrolment_id,p_benefit_id,p_value_inr,p_weight_grams,p_notes); $$;
revoke execute on function public.request_scheme_redemption(uuid,uuid,uuid,uuid,numeric,numeric,text) from public,anon;
grant execute on function public.request_scheme_redemption(uuid,uuid,uuid,uuid,numeric,numeric,text) to authenticated;

create or replace function private.review_scheme_redemption(p_tenant_id uuid,p_redemption_id uuid,p_action text,p_notes text default null)
returns void language plpgsql security definer set search_path=public,private,pg_temp as $$
declare v_user uuid:=auth.uid();v_red public.scheme_redemptions%rowtype;
begin
 if v_user is null then raise exception 'Authentication required' using errcode='42501';end if;
 if not private.has_tenant_role(p_tenant_id,array['owner','manager']) then raise exception 'Owner/manager permission required' using errcode='42501';end if;
 if p_action not in ('approve','reject','complete','cancel') then raise exception 'Invalid redemption action';end if;
 select * into v_red from public.scheme_redemptions where tenant_id=p_tenant_id and id=p_redemption_id for update;
 if not found then raise exception 'Redemption not found';end if;
 if p_action='approve' then
   if v_red.status<>'requested' then raise exception 'Only requested redemptions can be approved';end if;
   update public.scheme_redemptions set status='approved',approved_by=v_user,approved_at=now(),notes=concat_ws(E'\n',notes,nullif(trim(p_notes),'')) where tenant_id=p_tenant_id and id=p_redemption_id;
 elsif p_action='reject' then
   if v_red.status<>'requested' then raise exception 'Only requested redemptions can be rejected';end if;
   update public.scheme_redemptions set status='rejected',approved_by=v_user,approved_at=now(),notes=concat_ws(E'\n',notes,nullif(trim(p_notes),'')) where tenant_id=p_tenant_id and id=p_redemption_id;
 elsif p_action='cancel' then
   if v_red.status not in ('requested','approved') then raise exception 'Only open redemptions can be cancelled';end if;
   update public.scheme_redemptions set status='cancelled',approved_by=v_user,approved_at=now(),notes=concat_ws(E'\n',notes,nullif(trim(p_notes),'')) where tenant_id=p_tenant_id and id=p_redemption_id;
 else
   if v_red.status<>'approved' then raise exception 'Only approved redemptions can be completed';end if;
   update public.scheme_redemptions set status='completed',approved_by=v_user,approved_at=coalesce(approved_at,now()),completed_at=now(),notes=concat_ws(E'\n',notes,nullif(trim(p_notes),'')) where tenant_id=p_tenant_id and id=p_redemption_id;
   update public.scheme_benefits set status='redeemed' where tenant_id=p_tenant_id and id=v_red.benefit_id and status in ('approved','eligible');
   update public.scheme_enrolments set status='redeemed' where tenant_id=p_tenant_id and id=v_red.enrolment_id and status='matured';
 end if;
 insert into public.audit_logs(tenant_id,actor_user_id,event_name,entity_type,entity_id,details)
 values(p_tenant_id,v_user,'scheme.redemption_'||p_action,'scheme_redemption',p_redemption_id::text,jsonb_build_object('notes',p_notes,'old_status',v_red.status));
end;
$$;
revoke execute on function private.review_scheme_redemption(uuid,uuid,text,text) from public,anon;
grant execute on function private.review_scheme_redemption(uuid,uuid,text,text) to authenticated;
create or replace function public.review_scheme_redemption(p_tenant_id uuid,p_redemption_id uuid,p_action text,p_notes text default null)
returns void language plpgsql security invoker set search_path=public,private,pg_temp as $$ begin perform private.review_scheme_redemption(p_tenant_id,p_redemption_id,p_action,p_notes);end; $$;
revoke execute on function public.review_scheme_redemption(uuid,uuid,text,text) from public,anon;
grant execute on function public.review_scheme_redemption(uuid,uuid,text,text) to authenticated;

-- Queue a truthful in-app notification; delivery workers/providers must explicitly update send events.
create or replace function private.queue_in_app_notification(p_tenant_id uuid,p_customer_id uuid,p_notification_type text,p_message text,p_scheduled_at timestamptz default null)
returns uuid language plpgsql security definer set search_path=public,private,pg_temp as $$
declare v_user uuid:=auth.uid();v_id uuid;v_customer public.tenant_customers%rowtype;
begin
 if v_user is null then raise exception 'Authentication required' using errcode='42501';end if;
 if not private.has_tenant_role(p_tenant_id,array['owner','manager','scheme_manager','cashier']) then raise exception 'Permission denied' using errcode='42501';end if;
 if length(trim(coalesce(p_message,'')))<2 then raise exception 'Message is required';end if;
 select * into v_customer from public.tenant_customers where tenant_id=p_tenant_id and id=p_customer_id;
 if not found or v_customer.status<>'active' then raise exception 'Active customer not found';end if;
 if not private.has_tenant_branch_access(p_tenant_id,v_customer.branch_id,array['owner','manager','scheme_manager','cashier']) then raise exception 'Customer is outside the permitted branch' using errcode='42501';end if;
 insert into public.notifications(tenant_id,customer_id,channel,notification_type,status,destination_snapshot,safe_payload,scheduled_at)
 values(p_tenant_id,p_customer_id,'in_app',coalesce(nullif(trim(p_notification_type),''),'shop_message'),'queued',v_customer.mobile_e164,
 jsonb_build_object('message',trim(p_message),'provider_configured',false),coalesce(p_scheduled_at,now())) returning id into v_id;
 insert into public.audit_logs(tenant_id,actor_user_id,event_name,entity_type,entity_id,details)
 values(p_tenant_id,v_user,'notification.queued','notification',v_id::text,jsonb_build_object('channel','in_app','customer_id',p_customer_id));
 return v_id;
end;
$$;
revoke execute on function private.queue_in_app_notification(uuid,uuid,text,text,timestamptz) from public,anon;
grant execute on function private.queue_in_app_notification(uuid,uuid,text,text,timestamptz) to authenticated;
create or replace function public.queue_in_app_notification(p_tenant_id uuid,p_customer_id uuid,p_notification_type text,p_message text,p_scheduled_at timestamptz default null)
returns uuid language sql security invoker set search_path=public,private,pg_temp as $$ select private.queue_in_app_notification(p_tenant_id,p_customer_id,p_notification_type,p_message,p_scheduled_at); $$;
revoke execute on function public.queue_in_app_notification(uuid,uuid,text,text,timestamptz) from public,anon;
grant execute on function public.queue_in_app_notification(uuid,uuid,text,text,timestamptz) to authenticated;

-- Audit state transitions for customer order and repair operations.
create or replace function private.log_customer_operation_change()
returns trigger language plpgsql security definer set search_path=public,private,pg_temp as $$
declare v_actor uuid:=auth.uid();v_type text;v_id text;v_tenant uuid;
begin
 v_type:=case when tg_table_name='customer_orders' then 'customer_order' else 'repair_job' end;
 v_id:=coalesce(new.id,old.id)::text;v_tenant:=coalesce(new.tenant_id,old.tenant_id);
 if tg_op='UPDATE' and row(new.status,new.estimated_amount,new.deposit_amount,new.balance_amount,new.expected_delivery)
   is distinct from row(old.status,old.estimated_amount,old.deposit_amount,old.balance_amount,old.expected_delivery) then
   insert into public.audit_logs(tenant_id,actor_user_id,event_name,entity_type,entity_id,details)
   values(v_tenant,v_actor,v_type||'.updated',v_type,v_id,jsonb_build_object('old_status',old.status,'new_status',new.status));
 end if;
 return coalesce(new,old);
end;
$$;
revoke execute on function private.log_customer_operation_change() from public,anon,authenticated;
drop trigger if exists audit_customer_order_updates on public.customer_orders;
create trigger audit_customer_order_updates after update on public.customer_orders for each row execute procedure private.log_customer_operation_change();
drop trigger if exists audit_repair_job_updates on public.repair_jobs;
create trigger audit_repair_job_updates after update on public.repair_jobs for each row execute procedure private.log_customer_operation_change();

commit;
