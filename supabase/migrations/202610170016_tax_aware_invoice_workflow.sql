-- Tax-aware draft invoices: derive intra/inter-state treatment from saved locations and effective tax config.
begin;

create or replace function private.create_draft_invoice_tax_aware(
 p_tenant_id uuid,p_branch_id uuid,p_customer_id uuid,p_description text,p_quantity numeric,
 p_weight_grams numeric,p_rate_per_gram numeric,p_making_amount numeric,p_wastage_amount numeric,
 p_other_charges numeric,p_discount_amount numeric
)
returns uuid language plpgsql security definer set search_path=public,private,pg_temp as $$
declare
 v_user uuid:=auth.uid();v_invoice_id uuid;v_branch_state text;v_tenant_state text;v_customer_state text;v_place_state text;v_interstate boolean;
 v_config public.tax_configurations%rowtype;v_cgst_rate numeric(6,3);v_sgst_rate numeric(6,3);v_igst_rate numeric(6,3);
 v_taxable numeric(14,2);v_cgst numeric(14,2);v_sgst numeric(14,2);v_igst numeric(14,2);v_tax numeric(14,2);
 v_line_base numeric(14,2);v_line_cgst numeric(14,2);v_line_sgst numeric(14,2);v_line_igst numeric(14,2);v_line_tax numeric(14,2);
begin
 if v_user is null then raise exception 'Authentication required' using errcode='42501';end if;
 if not private.has_tenant_branch_access(p_tenant_id,p_branch_id,array['owner','manager','cashier','accountant']) then raise exception 'Permission denied' using errcode='42501';end if;
 select state into v_branch_state from public.branches where tenant_id=p_tenant_id and id=p_branch_id;
 if not found then raise exception 'Selected invoice branch does not belong to this shop';end if;
 select state into v_tenant_state from public.tenants where id=p_tenant_id;
 if p_customer_id is not null then
  select state into v_customer_state from public.tenant_customers where tenant_id=p_tenant_id and id=p_customer_id;
  if not found then raise exception 'Customer does not belong to this shop';end if;
 end if;
 v_place_state:=coalesce(nullif(trim(v_customer_state),''),nullif(trim(v_branch_state),''),nullif(trim(v_tenant_state),''));
 if v_place_state is null then raise exception 'Set a state on the branch or shop before issuing an invoice';end if;
 v_interstate:=nullif(lower(trim(v_customer_state)),'') is not null and nullif(lower(trim(v_branch_state)),'') is not null and lower(trim(v_customer_state))<>lower(trim(v_branch_state));
 select * into v_config from public.tax_configurations
 where tenant_id=p_tenant_id and effective_from<=current_date and (effective_until is null or effective_until>=current_date)
 order by effective_from desc,created_at desc limit 1;
 if not found then raise exception 'No effective tax configuration exists for this shop. Add and review a tax profile before issuing an invoice';end if;
 if v_interstate then
   v_cgst_rate:=0;v_sgst_rate:=0;v_igst_rate:=v_config.inter_state_igst_percent;
 else
   v_cgst_rate:=v_config.intra_state_cgst_percent;v_sgst_rate:=v_config.intra_state_sgst_percent;v_igst_rate:=0;
 end if;

 -- The original trusted draft routine performs all item and amount validation and persists the rate snapshot.
 v_invoice_id:=private.create_draft_invoice(p_tenant_id,p_branch_id,p_customer_id,p_description,p_quantity,
   p_weight_grams,p_rate_per_gram,p_making_amount,p_wastage_amount,p_other_charges,p_discount_amount,0);
 select taxable_amount into v_taxable from public.invoices where tenant_id=p_tenant_id and id=v_invoice_id for update;
 v_cgst:=round(v_taxable*v_cgst_rate/100,0);v_sgst:=round(v_taxable*v_sgst_rate/100,0);v_igst:=round(v_taxable*v_igst_rate/100,0);
 v_tax:=v_cgst+v_sgst+v_igst;
 update public.invoices set cgst_amount=v_cgst,sgst_amount=v_sgst,igst_amount=v_igst,total_amount=v_taxable+v_tax,
   tax_snapshot=coalesce(tax_snapshot,'{}'::jsonb)||jsonb_build_object(
     'configuration_id',v_config.id,'configuration_name',v_config.name,'effective_from',v_config.effective_from,
     'place_of_supply_state',v_place_state,'branch_state',v_branch_state,'customer_state',v_customer_state,
     'treatment',case when v_interstate then 'inter_state' else 'intra_state' end,
     'cgst_rate_percent',v_cgst_rate,'sgst_rate_percent',v_sgst_rate,'igst_rate_percent',v_igst_rate,
     'cgst_amount',v_cgst,'sgst_amount',v_sgst,'igst_amount',v_igst,'reviewed_tax_config',v_config.approved_at is not null),
   updated_at=now()
 where tenant_id=p_tenant_id and id=v_invoice_id;
 select greatest(0,round(line_total-tax_amount,2)) into v_line_base
 from public.invoice_lines where tenant_id=p_tenant_id and invoice_id=v_invoice_id order by line_number limit 1;
 v_line_cgst:=round(coalesce(v_line_base,0)*v_cgst_rate/100,0);
 v_line_sgst:=round(coalesce(v_line_base,0)*v_sgst_rate/100,0);
 v_line_igst:=round(coalesce(v_line_base,0)*v_igst_rate/100,0);
 v_line_tax:=v_line_cgst+v_line_sgst+v_line_igst;
 update public.invoice_lines set tax_rate=v_cgst_rate+v_sgst_rate+v_igst_rate,tax_amount=v_line_tax,
   line_total=greatest(0,round(line_total-tax_amount,2))+v_line_tax,
   item_snapshot=coalesce(item_snapshot,'{}'::jsonb)||jsonb_build_object(
     'tax_treatment',case when v_interstate then 'inter_state' else 'intra_state' end,
     'cgst_rate_percent',v_cgst_rate,'sgst_rate_percent',v_sgst_rate,'igst_rate_percent',v_igst_rate)
 where tenant_id=p_tenant_id and invoice_id=v_invoice_id;
 update public.invoices i set subtotal=x.subtotal,discount_amount=x.discount_amount,taxable_amount=x.taxable_amount,
   cgst_amount=x.cgst_amount,sgst_amount=x.sgst_amount,igst_amount=x.igst_amount,
   total_amount=x.taxable_amount+x.cgst_amount+x.sgst_amount+x.igst_amount
 from (select coalesce(sum(greatest(0,line_total-tax_amount)+discount_amount),0) as subtotal,
   coalesce(sum(discount_amount),0) as discount_amount,
   coalesce(sum(greatest(0,line_total-tax_amount)),0) as taxable_amount,
   coalesce(sum(round(greatest(0,line_total-tax_amount)*v_cgst_rate/100,0)),0) as cgst_amount,
   coalesce(sum(round(greatest(0,line_total-tax_amount)*v_sgst_rate/100,0)),0) as sgst_amount,
   coalesce(sum(round(greatest(0,line_total-tax_amount)*v_igst_rate/100,0)),0) as igst_amount
   from public.invoice_lines where tenant_id=p_tenant_id and invoice_id=v_invoice_id) x
 where i.tenant_id=p_tenant_id and i.id=v_invoice_id;
 insert into public.audit_logs(tenant_id,actor_user_id,event_name,entity_type,entity_id,details)
 values(p_tenant_id,v_user,'invoice.tax_treatment_applied','invoice',v_invoice_id::text,
 jsonb_build_object('tax_config_id',v_config.id,'inter_state',v_interstate,'place_of_supply',v_place_state,'cgst',v_cgst,'sgst',v_sgst,'igst',v_igst));
 return v_invoice_id;
end;
$$;
revoke execute on function private.create_draft_invoice_tax_aware(uuid,uuid,uuid,text,numeric,numeric,numeric,numeric,numeric,numeric,numeric) from public,anon;
grant execute on function private.create_draft_invoice_tax_aware(uuid,uuid,uuid,text,numeric,numeric,numeric,numeric,numeric,numeric,numeric) to authenticated;
create or replace function public.create_draft_invoice_tax_aware(p_tenant_id uuid,p_branch_id uuid,p_customer_id uuid,p_description text,p_quantity numeric,p_weight_grams numeric,p_rate_per_gram numeric,p_making_amount numeric,p_wastage_amount numeric,p_other_charges numeric,p_discount_amount numeric)
returns uuid language sql security invoker set search_path=public,private,pg_temp as $$
 select private.create_draft_invoice_tax_aware(p_tenant_id,p_branch_id,p_customer_id,p_description,p_quantity,p_weight_grams,p_rate_per_gram,p_making_amount,p_wastage_amount,p_other_charges,p_discount_amount);
$$;
revoke execute on function public.create_draft_invoice_tax_aware(uuid,uuid,uuid,text,numeric,numeric,numeric,numeric,numeric,numeric,numeric) from public,anon;
grant execute on function public.create_draft_invoice_tax_aware(uuid,uuid,uuid,text,numeric,numeric,numeric,numeric,numeric,numeric,numeric) to authenticated;
commit;
