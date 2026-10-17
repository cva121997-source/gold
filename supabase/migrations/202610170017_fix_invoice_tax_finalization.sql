-- Preserve the approved tax split when issuing an invoice.
begin;

create or replace function private.finalize_invoice(p_tenant_id uuid,p_invoice_id uuid)
returns void language plpgsql security definer set search_path=public,private,pg_temp as $$
declare
 v_user uuid:=auth.uid();
 v_branch uuid;
 v_status text;
 v_lines integer;
 v_subtotal numeric(14,2);
 v_discount numeric(14,2);
 v_tax numeric(14,2);
 v_cgst numeric(14,2);
 v_sgst numeric(14,2);
 v_igst numeric(14,2);
begin
 if v_user is null then raise exception 'Authentication required' using errcode='42501'; end if;

 select branch_id,status into v_branch,v_status
 from public.invoices where tenant_id=p_tenant_id and id=p_invoice_id for update;
 if not found then raise exception 'Invoice not found'; end if;
 if v_status<>'draft' then raise exception 'Only draft invoices can be issued'; end if;
 if not private.has_tenant_branch_access(p_tenant_id,v_branch,array['owner','manager','cashier','accountant']) then
   raise exception 'Permission denied' using errcode='42501';
 end if;

 select count(*),
        coalesce(sum(greatest(0,round(line_total-tax_amount,2))),0),
        coalesce(sum(discount_amount),0),
        coalesce(sum(tax_amount),0),
        coalesce(sum(round(greatest(0,line_total-tax_amount) * coalesce(nullif(item_snapshot->>'cgst_rate_percent','')::numeric,0)/100,0)),0),
        coalesce(sum(round(greatest(0,line_total-tax_amount) * coalesce(nullif(item_snapshot->>'sgst_rate_percent','')::numeric,0)/100,0)),0),
        coalesce(sum(round(greatest(0,line_total-tax_amount) * coalesce(nullif(item_snapshot->>'igst_rate_percent','')::numeric,0)/100,0)),0)
 into v_lines,v_subtotal,v_discount,v_tax,v_cgst,v_sgst,v_igst
 from public.invoice_lines
 where tenant_id=p_tenant_id and invoice_id=p_invoice_id;

 if v_lines=0 then raise exception 'Add at least one invoice line before issuing'; end if;

 -- Backward compatibility for older drafts created before a split tax snapshot was saved.
 if coalesce(v_cgst,0)+coalesce(v_sgst,0)+coalesce(v_igst,0)=0 and coalesce(v_tax,0)>0 then
   v_igst:=v_tax;
 end if;

 update public.invoices
 set status='issued',
     subtotal=v_subtotal+v_discount,
     discount_amount=v_discount,
     taxable_amount=v_subtotal,
     cgst_amount=coalesce(v_cgst,0),
     sgst_amount=coalesce(v_sgst,0),
     igst_amount=coalesce(v_igst,0),
     total_amount=v_subtotal+coalesce(v_tax,0),
     issued_at=now(),
     updated_at=now()
 where tenant_id=p_tenant_id and id=p_invoice_id;

 insert into public.audit_logs(tenant_id,actor_user_id,event_name,entity_type,entity_id,details)
 values(p_tenant_id,v_user,'invoice.issued','invoice',p_invoice_id::text,
   jsonb_build_object('subtotal',v_subtotal+v_discount,'discount',v_discount,'taxable_amount',v_subtotal,
     'cgst_amount',v_cgst,'sgst_amount',v_sgst,'igst_amount',v_igst,'total_amount',v_subtotal+coalesce(v_tax,0)));

end;
$$;

revoke execute on function private.finalize_invoice(uuid,uuid) from public,anon;
grant execute on function private.finalize_invoice(uuid,uuid) to authenticated;
create or replace function public.finalize_invoice(p_tenant_id uuid,p_invoice_id uuid)
returns void language plpgsql security invoker set search_path=public,private,pg_temp as $$
begin
 perform private.finalize_invoice(p_tenant_id,p_invoice_id);
end;
$$;
revoke execute on function public.finalize_invoice(uuid,uuid) from public,anon;
grant execute on function public.finalize_invoice(uuid,uuid) to authenticated;

commit;
