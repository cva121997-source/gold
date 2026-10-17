-- Old gold estimates are server-calculated and use auditable approval.
begin;
create or replace function private.create_old_gold_valuation(
 p_tenant_id uuid,p_branch_id uuid,p_customer_id uuid,p_metal_id smallint,p_purity_id smallint,
 p_estimated_weight numeric,p_net_weight numeric,p_rate numeric,p_deduction_percent numeric,p_stone_deduction numeric,p_testing_notes text
)
returns uuid language plpgsql security definer set search_path=public,private,pg_temp as $$
declare v_user uuid:=auth.uid(); v_id uuid; v_value numeric(14,2); v_number text;
begin
 if v_user is null then raise exception 'Authentication required' using errcode='42501'; end if;
 if not private.has_tenant_branch_access(p_tenant_id,p_branch_id,array['owner','manager','cashier','employee']) then raise exception 'Permission denied' using errcode='42501'; end if;
 if p_estimated_weight is null or p_net_weight is null or p_estimated_weight<0 or p_net_weight<0 or p_net_weight>p_estimated_weight then raise exception 'Estimated and net weights are invalid'; end if;
 if p_rate is null or p_rate<=0 then raise exception 'Enter a positive indicative rate per gram'; end if;
 if p_deduction_percent is null or p_deduction_percent<0 or p_deduction_percent>100 then raise exception 'Deduction percent must be between 0 and 100'; end if;
 if coalesce(p_stone_deduction,0)<0 then raise exception 'Stone deduction cannot be negative'; end if;
 if p_customer_id is not null and not exists(select 1 from public.tenant_customers where tenant_id=p_tenant_id and id=p_customer_id) then raise exception 'Customer belongs to another shop or does not exist'; end if;
 v_value:=greatest(0,round(p_net_weight*p_rate*(1-p_deduction_percent/100)-coalesce(p_stone_deduction,0),2));
 v_number:='OG-'||to_char(now(),'YYYYMMDD')||'-'||upper(substr(replace(gen_random_uuid()::text,'-',''),1,8));
 insert into public.old_gold_valuations(tenant_id,branch_id,customer_id,valuation_number,metal_id,purity_id,estimated_weight_grams,net_weight_grams,rate_per_gram,deduction_percent,stone_deduction_inr,testing_notes,estimated_value,status,rate_snapshot,created_by)
 values(p_tenant_id,p_branch_id,p_customer_id,v_number,p_metal_id,p_purity_id,p_estimated_weight,p_net_weight,p_rate,p_deduction_percent,coalesce(p_stone_deduction,0),nullif(trim(p_testing_notes),''),v_value,'estimate',
 jsonb_build_object('rate_per_gram',p_rate,'rate_source','staff-entered indicative quote','calculated_at',now()),v_user)
 returning id into v_id;
 insert into public.audit_logs(tenant_id,actor_user_id,event_name,entity_type,entity_id,details)
 values(p_tenant_id,v_user,'old_gold.valuation_created','old_gold_valuation',v_id::text,jsonb_build_object('estimated_value',v_value,'customer_id',p_customer_id,'rate_per_gram',p_rate));
 return v_id;
end;
$$;
revoke execute on function private.create_old_gold_valuation(uuid,uuid,uuid,smallint,smallint,numeric,numeric,numeric,numeric,numeric,text) from public,anon;
grant execute on function private.create_old_gold_valuation(uuid,uuid,uuid,smallint,smallint,numeric,numeric,numeric,numeric,numeric,text) to authenticated;
create or replace function public.create_old_gold_valuation(p_tenant_id uuid,p_branch_id uuid,p_customer_id uuid,p_metal_id smallint,p_purity_id smallint,p_estimated_weight numeric,p_net_weight numeric,p_rate numeric,p_deduction_percent numeric,p_stone_deduction numeric,p_testing_notes text)
returns uuid language sql security invoker set search_path=public,private,pg_temp as $$
 select private.create_old_gold_valuation(p_tenant_id,p_branch_id,p_customer_id,p_metal_id,p_purity_id,p_estimated_weight,p_net_weight,p_rate,p_deduction_percent,p_stone_deduction,p_testing_notes);
$$;
revoke execute on function public.create_old_gold_valuation(uuid,uuid,uuid,smallint,smallint,numeric,numeric,numeric,numeric,numeric,text) from public,anon;
grant execute on function public.create_old_gold_valuation(uuid,uuid,uuid,smallint,smallint,numeric,numeric,numeric,numeric,numeric,text) to authenticated;
revoke insert,update,delete on public.old_gold_valuations from public,anon,authenticated;
grant select on public.old_gold_valuations to authenticated;
commit;
