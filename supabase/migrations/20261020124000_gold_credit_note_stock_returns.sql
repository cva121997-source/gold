begin;

create table if not exists public.credit_note_inventory_returns (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete restrict,
  credit_note_id uuid not null references public.credit_notes(id) on delete restrict,
  credit_note_line_id uuid not null references public.credit_note_lines(id) on delete restrict,
  invoice_id uuid not null references public.invoices(id) on delete restrict,
  invoice_line_id uuid not null references public.invoice_lines(id) on delete restrict,
  inventory_item_id uuid not null references public.inventory_items(id) on delete restrict,
  branch_id uuid not null references public.branches(id) on delete restrict,
  disposition text not null check (disposition in ('restock','repair')),
  reason text not null check (length(trim(reason)) between 5 and 500),
  idempotency_key text not null check (length(trim(idempotency_key)) between 8 and 160),
  recorded_by uuid not null references auth.users(id) on delete restrict,
  created_at timestamptz not null default now(),
  unique (tenant_id, inventory_item_id),
  unique (tenant_id, idempotency_key)
);

create index if not exists credit_note_inventory_returns_note_idx
  on public.credit_note_inventory_returns(tenant_id, credit_note_id, created_at desc);
create index if not exists credit_note_inventory_returns_branch_idx
  on public.credit_note_inventory_returns(tenant_id, branch_id, created_at desc);

alter table public.credit_note_inventory_returns enable row level security;
drop policy if exists credit_note_inventory_returns_branch_read on public.credit_note_inventory_returns;
create policy credit_note_inventory_returns_branch_read on public.credit_note_inventory_returns
  for select to authenticated
  using (private.has_tenant_branch_access(
    tenant_id, branch_id, array['owner','manager','accountant','cashier','inventory_manager']
  ));
revoke all on public.credit_note_inventory_returns from public, anon;
revoke insert, update, delete on public.credit_note_inventory_returns from authenticated;
grant select on public.credit_note_inventory_returns to authenticated;
grant all on public.credit_note_inventory_returns to service_role;

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
  v_reference text;
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
  if v_note_line.quantity<1 then raise exception 'The credited quantity does not include a whole tracked inventory piece'; end if;

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
    where r.tenant_id=p_tenant_id and r.inventory_item_id=p_inventory_item_id for update;
  if found then raise exception 'This tracked piece already has a recorded physical return'; end if;
  if v_item.status<>'sold' then
    raise exception 'Only a tracked item still marked sold can be received as a customer return';
  end if;

  v_new_status:=case when p_disposition='restock' then 'in_stock' else 'repair' end;
  v_reference:=v_note.credit_note_number;
  update public.inventory_items set status=v_new_status,updated_at=now()
    where tenant_id=p_tenant_id and id=v_item.id;
  insert into public.inventory_movements(
    tenant_id,branch_id,inventory_item_id,product_id,movement_type,quantity,from_branch_id,to_branch_id,reference,reason,actor_user_id
  ) values (
    p_tenant_id,v_item.branch_id,v_item.id,v_item.product_id,'return',1,v_item.branch_id,v_item.branch_id,
    v_reference,'Customer return inspection ('||p_disposition||'): '||trim(p_reason),v_user
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

comment on table public.credit_note_inventory_returns is
  'Audited linkage between an issued credit note and physical receipt of a tracked returned piece. Financial refund is a separate workflow.';

commit;