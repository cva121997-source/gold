-- Final write-boundary hardening and privacy-preserving audit events.
begin;

-- All scheme balance mutations must originate in private transaction RPCs.
revoke insert,update,delete on public.scheme_transactions,public.scheme_enrolments,public.scheme_installments,
 public.scheme_benefits,public.scheme_redemptions from public,anon,authenticated;
grant select on public.scheme_transactions,public.scheme_enrolments,public.scheme_installments,
 public.scheme_benefits,public.scheme_redemptions to authenticated;

-- Rates are snapshots. Publishing a new rate is permitted; rewriting/deleting prior rates is not.
revoke update,delete on public.gold_rates from public,anon,authenticated;
grant select,insert on public.gold_rates to authenticated;
revoke update,delete on public.tax_configurations from public,anon,authenticated;
grant select,insert on public.tax_configurations to authenticated;

-- Keep customer, rate and tax audit events without copying private customer PII into the audit log.
create or replace function private.audit_selected_business_event()
returns trigger language plpgsql security definer set search_path=public,private,pg_temp as $$
declare v_row jsonb:=to_jsonb(new);v_old jsonb:=to_jsonb(old);v_tenant uuid;v_id text;v_event text;v_details jsonb;
begin
 v_tenant:=(v_row->>'tenant_id')::uuid;
 v_id:=coalesce(v_row->>'id',v_row->>'code',v_row->>'customer_code','unknown');
 if tg_table_name='gold_rates' then
   v_event:=case when tg_op='INSERT' then 'rate.created' else 'rate.updated' end;
   v_details:=jsonb_build_object('rate_id',v_id,'price_per_gram',v_row->>'price_per_gram','metal_id',v_row->>'metal_id','purity_id',v_row->>'purity_id','branch_id',v_row->>'branch_id','is_public',v_row->>'is_public','status',v_row->>'status','source_type',v_row->>'source_type','effective_at',v_row->>'effective_at');
 elsif tg_table_name='tenant_customers' then
   v_event:=case when tg_op='INSERT' then 'customer.created' else 'customer.updated' end;
   v_details:=jsonb_build_object('customer_id',v_id,'customer_code',v_row->>'customer_code','status',v_row->>'status','branch_id',v_row->>'branch_id');
 elsif tg_table_name='tax_configurations' then
   v_event:='tax_configuration.created';
   v_details:=jsonb_build_object('configuration_id',v_id,'name',v_row->>'name','effective_from',v_row->>'effective_from','effective_until',v_row->>'effective_until','approved_by',v_row->>'approved_by');
 elsif tg_table_name='branches' then
   v_event:=case when tg_op='INSERT' then 'branch.created' else 'branch.updated' end;
   v_details:=jsonb_build_object('branch_id',v_id,'branch_code',v_row->>'branch_code','name',v_row->>'name','is_active',v_row->>'is_active');
 else
   v_event:='business_record.changed';v_details=jsonb_build_object('record_id',v_id);
 end if;
 if tg_op='INSERT' or v_row is distinct from v_old then
   insert into public.audit_logs(tenant_id,actor_user_id,event_name,entity_type,entity_id,details)
   values(v_tenant,auth.uid(),v_event,tg_table_name,v_id,v_details);
 end if;
 return new;
end;
$$;
revoke execute on function private.audit_selected_business_event() from public,anon,authenticated;

drop trigger if exists audit_gold_rates_changes on public.gold_rates;
create trigger audit_gold_rates_changes after insert or update on public.gold_rates for each row execute procedure private.audit_selected_business_event();
drop trigger if exists audit_customer_profile_changes on public.tenant_customers;
create trigger audit_customer_profile_changes after insert or update on public.tenant_customers for each row execute procedure private.audit_selected_business_event();
drop trigger if exists audit_tax_configuration_changes on public.tax_configurations;
create trigger audit_tax_configuration_changes after insert on public.tax_configurations for each row execute procedure private.audit_selected_business_event();
drop trigger if exists audit_branch_changes on public.branches;
create trigger audit_branch_changes after insert or update on public.branches for each row execute procedure private.audit_selected_business_event();

commit;
