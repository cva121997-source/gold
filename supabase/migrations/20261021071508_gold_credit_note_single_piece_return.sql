begin;

-- This migration was applied to the connected Gold Supabase project as
-- gold_credit_note_single_piece_return. Keep its source committed so a fresh
-- database also receives the exact-one-tracked-piece credit-note guard.
create or replace function public.record_credit_note_stock_return(
  p_tenant_id uuid,
  p_credit_note_id uuid,
  p_credit_note_line_id uuid,
  p_inventory_item_id uuid,
  p_disposition text,
  p_reason text,
  p_idempotency_key text
) returns uuid
language plpgsql
security definer
set search_path=public,private,pg_temp
as $$
declare
  v_user uuid := auth.uid();
  v_note public.credit_notes%rowtype;
  v_note_line public.credit_note_lines%rowtype;
  v_invoice_line public.invoice_lines%rowtype;
  v_item public.inventory_items%rowtype;
  v_return public.credit_note_inventory_returns%rowtype;
  v_return_id uuid;
  v_new_status text;
begin
  if v_user is null then raise exception 'Authentication required' using errcode='42501'; end if;
  if p_disposition not in ('restock','repair') then raise exception 'Choose restock or repair disposition'; end if;
  if length(trim(coalesce(p_reason,'')))<5 or length(trim(p_reason))>500 then
    raise exception 'Enter a return inspection reason between 5 and 500 characters';
  end if;
  if p_idempotency_key is null or length(trim(p_idempotency_key))<8 or length(p_idempotency_key)>160 then
    raise exception 'A valid idempotency key is required';
  end if;
  if not private.has_tenant_role(p_tenant_id,array['owner','manager','inventory_manager']) then
    raise exception 'Only an owner, manager or inventory manager can process returned stock' using errcode='42501';
  end if;

  select * into v_note from public.credit_notes n
    where n.tenant_id=p_tenant_id and n.id=p_credit_note_id for update;
  if not found or v_note.status<>'issued' then
    raise exception 'Only an issued credit note can be used to receive a physical stock return';
  end if;
  if v_note.branch_id is null or not private.has_tenant_branch_access(
    p_tenant_id,v_note.branch_id,array['owner','manager','inventory_manager']
  ) then raise exception 'Access to the credit note branch is required' using errcode='42501'; end if;

  select * into v_note_line from public.credit_note_lines cl
    where cl.id=p_credit_note_line_id and cl.tenant_id=p_tenant_id and cl.credit_note_id=v_note.id for update;
  if not found then raise exception 'The return line does not belong to this issued credit note'; end if;
  if v_note_line.quantity<>1 then raise exception 'This physical return workflow requires a credit quantity of exactly one tracked piece'; end if;

  select * into v_invoice_line from public.invoice_lines il
    where il.id=v_note_line.invoice_line_id and il.tenant_id=p_tenant_id and il.invoice_id=v_note.invoice_id for update;
  if not found or v_invoice_line.inventory_item_id is distinct from p_inventory_item_id then
    raise exception 'The selected stock item is not the tracked piece on the original invoice line';
  end if;

  select * into v_item from public.inventory_items ii
    where ii.id=p_inventory_item_id and ii.tenant_id=p_tenant_id for update;
  if not found then raise exception 'Tracked inventory item was not found in this shop'; end if;
  if v_item.branch_id is null or v_item.branch_id is distinct from v_note.branch_id then
    raise exception 'The tracked piece must be returned to the branch that issued the original invoice';
  end if;
  if not private.has_tenant_branch_access(p_tenant_id,v_item.branch_id,array['owner','manager','inventory_manager']) then
    raise exception 'Inventory branch access denied' using errcode='42501';
  end if;

  select * into v_return from public.credit_note_inventory_returns r
    where r.tenant_id=p_tenant_id and r.idempotency_key=trim(p_idempotency_key);
  if found then
    if v_return.credit_note_id=p_credit_note_id and v_return.credit_note_line_id=p_credit_note_line_id
      and v_return.inventory_item_id=p_inventory_item_id and v_return.disposition=p_disposition
      and v_return.reason=trim(p_reason) then
      return v_return.id;
    end if;
    raise exception 'This idempotency key was already used for a different stock return';
  end if;

  select * into v_return from public.credit_note_inventory_returns r
    where r.tenant_id=p_tenant_id and r.invoice_id=v_note.invoice_id
      and r.invoice_line_id=v_invoice_line.id and r.inventory_item_id=p_inventory_item_id for update;
  if found then raise exception 'This tracked piece has already been returned for this invoice line'; end if;
  if v_item.status<>'sold' then
    raise exception 'Only a tracked item still marked sold can be received as a customer return';
  end if;

  v_new_status:=case when p_disposition='restock' then 'in_stock' else 'repair' end;
  update public.inventory_items set status=v_new_status,updated_at=now()
    where tenant_id=p_tenant_id and id=v_item.id;
  insert into public.inventory_movements(
    tenant_id,branch_id,inventory_item_id,product_id,movement_type,quantity,from_branch_id,to_branch_id,reference,reason,actor_user_id
  ) values (
    p_tenant_id,v_item.branch_id,v_item.id,v_item.product_id,'return',1,v_item.branch_id,v_item.branch_id,
    v_note.credit_note_number,'Customer return inspection ('||p_disposition||'): '||trim(p_reason),v_user
  );

  insert into public.credit_note_inventory_returns(
    tenant_id,credit_note_id,credit_note_line_id,invoice_id,invoice_line_id,inventory_item_id,branch_id,
    disposition,reason,idempotency_key,recorded_by
  ) values (
    p_tenant_id,v_note.id,v_note_line.id,v_note.invoice_id,v_invoice_line.id,v_item.id,v_item.branch_id,
    p_disposition,trim(p_reason),trim(p_idempotency_key),v_user
  ) returning id into v_return_id;

  insert into public.audit_logs(tenant_id,actor_user_id,event_name,entity_type,entity_id,details)
  values(p_tenant_id,v_user,'inventory.customer_return_recorded','inventory_item',v_item.id::text,
    jsonb_build_object(
      'credit_note_id',v_note.id,'credit_note_number',v_note.credit_note_number,
      'credit_note_line_id',v_note_line.id,'invoice_id',v_note.invoice_id,'invoice_line_id',v_invoice_line.id,
      'inventory_item_id',v_item.id,'item_code',v_item.item_code,'branch_id',v_item.branch_id,
      'disposition',p_disposition,'resulting_status',v_new_status,'reason',trim(p_reason)
    ));
  return v_return_id;
end;
$$;

revoke all on function public.record_credit_note_stock_return(uuid,uuid,uuid,uuid,text,text,text) from public,anon;
grant execute on function public.record_credit_note_stock_return(uuid,uuid,uuid,uuid,text,text,text) to authenticated;

commit;
