-- Make the audit trigger safe for both order and repair tables with different column sets.
begin;
create or replace function private.log_customer_operation_change()
returns trigger language plpgsql security definer set search_path=public,private,pg_temp as $$
declare v_actor uuid:=auth.uid();v_type text;v_id text;v_tenant uuid;
begin
 v_type:=case when tg_table_name='customer_orders' then 'customer_order' else 'repair_job' end;
 v_id:=(to_jsonb(new)->>'id');
 v_tenant:=(to_jsonb(new)->>'tenant_id')::uuid;
 if tg_op='UPDATE' and (
   to_jsonb(new)->'status' is distinct from to_jsonb(old)->'status'
   or to_jsonb(new)->'estimated_amount' is distinct from to_jsonb(old)->'estimated_amount'
   or to_jsonb(new)->'deposit_amount' is distinct from to_jsonb(old)->'deposit_amount'
   or to_jsonb(new)->'balance_amount' is distinct from to_jsonb(old)->'balance_amount'
   or to_jsonb(new)->'expected_delivery' is distinct from to_jsonb(old)->'expected_delivery'
   or to_jsonb(new)->'estimated_cost' is distinct from to_jsonb(old)->'estimated_cost'
   or to_jsonb(new)->'final_cost' is distinct from to_jsonb(old)->'final_cost'
   or to_jsonb(new)->'promised_date' is distinct from to_jsonb(old)->'promised_date'
 ) then
   insert into public.audit_logs(tenant_id,actor_user_id,event_name,entity_type,entity_id,details)
   values(v_tenant,v_actor,v_type||'.updated',v_type,v_id,
     jsonb_build_object('old_status',to_jsonb(old)->>'status','new_status',to_jsonb(new)->>'status'));
 end if;
 return new;
end;
$$;
revoke execute on function private.log_customer_operation_change() from public,anon,authenticated;
drop trigger if exists audit_customer_order_updates on public.customer_orders;
create trigger audit_customer_order_updates after update on public.customer_orders for each row execute procedure private.log_customer_operation_change();
drop trigger if exists audit_repair_job_updates on public.repair_jobs;
create trigger audit_repair_job_updates after update on public.repair_jobs for each row execute procedure private.log_customer_operation_change();
commit;
