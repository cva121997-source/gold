begin;

alter table public.invoice_lines
  add column if not exists inventory_item_id uuid references public.inventory_items(id) on delete restrict;
create index if not exists invoice_lines_inventory_item_idx
  on public.invoice_lines(tenant_id,inventory_item_id) where inventory_item_id is not null;

create or replace function public.create_draft_invoice_for_inventory_item(
  p_tenant_id uuid,
  p_branch_id uuid,
  p_customer_id uuid,
  p_inventory_item_id uuid,
  p_other_charges numeric default 0,
  p_discount_amount numeric default 0
) returns uuid
language plpgsql security definer
set search_path=public,private,pg_temp
as $$
declare
  v_user uuid:=auth.uid();
  v_item public.inventory_items%rowtype;
  v_product public.products%rowtype;
  v_rate public.gold_rates%rowtype;
  v_invoice_id uuid;
  v_line_id uuid;
  v_metal_value numeric(14,2);
  v_making numeric(14,2);
  v_wastage numeric(14,2);
  v_other numeric(14,2):=coalesce(p_other_charges,0);
  v_discount numeric(14,2):=coalesce(p_discount_amount,0);
begin
  if v_user is null then raise exception 'Authentication required' using errcode='42501'; end if;
  if not private.has_tenant_branch_access(p_tenant_id,p_branch_id,array['owner','manager','cashier','accountant']) then
    raise exception 'Permission denied' using errcode='42501';
  end if;
  if p_customer_id is null then raise exception 'Choose a customer to record the sold-gold history'; end if;
  if v_other<0 or v_discount<0 then raise exception 'Other charges and discounts cannot be negative'; end if;

  select * into v_item from public.inventory_items
    where tenant_id=p_tenant_id and id=p_inventory_item_id for update;
  if not found then raise exception 'Stock item was not found in this shop'; end if;
  if v_item.status<>'in_stock' then raise exception 'Only an available in-stock item can be sold'; end if;
  if v_item.branch_id is distinct from p_branch_id then raise exception 'Stock item is not assigned to the selected sale branch'; end if;

  if exists (
    select 1 from public.invoice_lines il join public.invoices i
      on i.tenant_id=il.tenant_id and i.id=il.invoice_id
    where il.tenant_id=p_tenant_id and il.inventory_item_id=p_inventory_item_id and i.status='draft'
  ) then raise exception 'This stock item is already attached to another draft invoice'; end if;

  select * into v_product from public.products
    where tenant_id=p_tenant_id and id=v_item.product_id and is_active for update;
  if not found then raise exception 'Active catalogue product for this stock item was not found'; end if;
  if v_product.metal_id is null or v_product.purity_id is null or v_product.net_metal_weight_grams<=0
    or v_product.gross_weight_grams<=0 then
    raise exception 'Stock product needs valid metal, purity, gross weight and net metal weight before sale';
  end if;
  perform 1 from public.tenant_customers
    where tenant_id=p_tenant_id and id=p_customer_id and status='active';
  if not found then raise exception 'Choose an active customer belonging to this shop'; end if;

  select * into v_rate from public.gold_rates
    where tenant_id=p_tenant_id
      and metal_id=v_product.metal_id and purity_id=v_product.purity_id
      and status='verified' and effective_at<=now()
      and effective_at>=now()-interval '36 hours'
      and (expires_at is null or expires_at>now())
      and (branch_id=p_branch_id or branch_id is null)
    order by case when branch_id=p_branch_id then 1 else 0 end desc,effective_at desc,created_at desc
    limit 1 for share;
  if not found or v_rate.price_per_gram<=0 then
    raise exception 'No fresh verified rate exists for this item purity and branch. Ask a manager to enter or verify today’s rate first';
  end if;

  v_metal_value:=round(v_product.net_metal_weight_grams*v_rate.price_per_gram,2);
  v_making:=case v_product.making_charge_mode
    when 'percent' then round(v_metal_value*v_product.making_charge_value/100,2)
    when 'per_gram' then round(v_product.net_metal_weight_grams*v_product.making_charge_value,2)
    else round(v_product.making_charge_value,2)
  end;
  v_wastage:=round(v_metal_value*v_product.wastage_percent/100,2);

  v_invoice_id:=private.create_draft_invoice_tax_aware(
    p_tenant_id,p_branch_id,p_customer_id,
    v_product.name||' · Item '||v_item.item_code,1,v_product.net_metal_weight_grams,
    v_rate.price_per_gram,v_making,v_wastage,v_other,v_discount
  );

  select id into v_line_id from public.invoice_lines
    where tenant_id=p_tenant_id and invoice_id=v_invoice_id and line_number=1 for update;
  if v_line_id is null then raise exception 'Invoice line could not be created for the stock item'; end if;

  update public.invoice_lines set
    inventory_item_id=p_inventory_item_id,
    gross_weight_grams=v_product.gross_weight_grams,
    net_metal_weight_grams=v_product.net_metal_weight_grams,
    item_snapshot=coalesce(item_snapshot,'{}'::jsonb)||jsonb_build_object(
      'tracked_inventory',true,'inventory_item_id',p_inventory_item_id,'item_code',v_item.item_code,
      'product_id',v_product.id,'product_code',v_product.product_code,'barcode',v_product.barcode,
      'huid',v_product.huid,'metal_id',v_product.metal_id,'purity_id',v_product.purity_id,
      'gross_weight_grams',v_product.gross_weight_grams,'net_metal_weight_grams',v_product.net_metal_weight_grams,
      'stone_weight_grams',v_product.stone_weight_grams,'rate_source','fresh_verified_shop_rate',
      'gold_rate_id',v_rate.id,'gold_rate_effective_at',v_rate.effective_at,
      'making_charge_mode',v_product.making_charge_mode,'making_charge_value',v_product.making_charge_value,
      'wastage_percent',v_product.wastage_percent),
    item_snapshot_updated_at=now()
  where tenant_id=p_tenant_id and id=v_line_id;

  insert into public.audit_logs(tenant_id,actor_user_id,event_name,entity_type,entity_id,details)
  values(p_tenant_id,v_user,'invoice.inventory_item_linked','invoice',v_invoice_id::text,
    jsonb_build_object('inventory_item_id',p_inventory_item_id,'item_code',v_item.item_code,
      'product_id',v_product.id,'customer_id',p_customer_id,'gold_rate_id',v_rate.id,'rate_per_gram',v_rate.price_per_gram));
  return v_invoice_id;
end;
$$;

create or replace function private.process_inventory_sale_on_invoice_issue()
returns trigger
language plpgsql security definer
set search_path=public,private,pg_temp
as $$
declare
  v_line record;
  v_item public.inventory_items%rowtype;
  v_actor uuid:=auth.uid();
begin
  if old.status<>'draft' or new.status<>'issued' then return new; end if;

  for v_line in
    select il.id as invoice_line_id,il.inventory_item_id,il.quantity,il.description,il.item_snapshot
    from public.invoice_lines il
    where il.tenant_id=new.tenant_id and il.invoice_id=new.id and il.inventory_item_id is not null
    for update
  loop
    select * into v_item from public.inventory_items
      where tenant_id=new.tenant_id and id=v_line.inventory_item_id for update;
    if not found then raise exception 'Linked inventory item no longer exists'; end if;
    if v_item.status<>'in_stock' then raise exception 'Linked inventory item is no longer available; invoice issue has been cancelled'; end if;
    if v_item.branch_id is distinct from new.branch_id then raise exception 'Linked item branch does not match invoice branch'; end if;
    if v_line.quantity<>1 then raise exception 'A tracked jewellery stock item must be sold as one piece'; end if;

    update public.inventory_items set status='sold',updated_at=now()
      where tenant_id=new.tenant_id and id=v_item.id;
    insert into public.inventory_movements(
      tenant_id,branch_id,inventory_item_id,product_id,movement_type,quantity,
      from_branch_id,to_branch_id,reference,reason,actor_user_id
    ) values (
      new.tenant_id,v_item.branch_id,v_item.id,v_item.product_id,'sale',1,
      v_item.branch_id,null,new.invoice_number,'Sold on invoice '||new.invoice_number,v_actor
    );
    insert into public.audit_logs(tenant_id,actor_user_id,event_name,entity_type,entity_id,details)
    values(new.tenant_id,v_actor,'inventory.item_sold','inventory_item',v_item.id::text,
      jsonb_build_object('invoice_id',new.id,'invoice_number',new.invoice_number,
        'invoice_line_id',v_line.invoice_line_id,'item_code',v_item.item_code,
        'customer_id',new.customer_id,'line_snapshot',v_line.item_snapshot));
  end loop;
  return new;
end;
$$;

drop trigger if exists invoice_issue_marks_tracked_stock_sold on public.invoices;
create trigger invoice_issue_marks_tracked_stock_sold
after update of status on public.invoices
for each row when (old.status='draft' and new.status='issued')
execute function private.process_inventory_sale_on_invoice_issue();

create or replace function private.validate_tracked_item_credit_note_line()
returns trigger
language plpgsql security definer
set search_path=public,private,pg_temp
as $$
declare
  v_invoice_line public.invoice_lines%rowtype;
  v_item public.inventory_items%rowtype;
begin
  select * into v_invoice_line from public.invoice_lines
    where tenant_id=new.tenant_id and id=new.invoice_line_id for share;
  if not found then raise exception 'Original invoice line could not be found'; end if;

  if v_invoice_line.inventory_item_id is not null then
    if new.quantity<>v_invoice_line.quantity then
      raise exception 'A tracked jewellery piece must be returned as a whole item, not a fractional quantity';
    end if;
    select * into v_item from public.inventory_items
      where tenant_id=new.tenant_id and id=v_invoice_line.inventory_item_id for update;
    if not found or v_item.status<>'sold' then
      raise exception 'A tracked inventory item must still be sold before it can be returned';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists credit_note_lines_validate_tracked_item on public.credit_note_lines;
create trigger credit_note_lines_validate_tracked_item
before insert on public.credit_note_lines
for each row execute function private.validate_tracked_item_credit_note_line();

create or replace function private.process_inventory_return_on_credit_note_issue()
returns trigger
language plpgsql security definer
set search_path=public,private,pg_temp
as $$
declare
  v_line record;
  v_item public.inventory_items%rowtype;
  v_actor uuid:=auth.uid();
begin
  if old.status<>'draft' or new.status<>'issued' then return new; end if;
  for v_line in
    select il.id as invoice_line_id,il.inventory_item_id,cnl.quantity,cnl.item_snapshot
    from public.credit_note_lines cnl
    join public.invoice_lines il on il.tenant_id=cnl.tenant_id and il.id=cnl.invoice_line_id
    where cnl.tenant_id=new.tenant_id and cnl.credit_note_id=new.id and il.inventory_item_id is not null
    for update of cnl,il
  loop
    select * into v_item from public.inventory_items where tenant_id=new.tenant_id and id=v_line.inventory_item_id for update;
    if not found or v_item.status<>'sold' then raise exception 'Returned stock item is no longer marked sold'; end if;
    if v_line.quantity<>1 then raise exception 'A tracked stock return must return exactly one item'; end if;
    update public.inventory_items set status='in_stock',branch_id=new.branch_id,updated_at=now()
      where tenant_id=new.tenant_id and id=v_item.id;
    insert into public.inventory_movements(
      tenant_id,branch_id,inventory_item_id,product_id,movement_type,quantity,
      from_branch_id,to_branch_id,reference,reason,actor_user_id
    ) values (
      new.tenant_id,new.branch_id,v_item.id,v_item.product_id,'return',1,
      v_item.branch_id,new.branch_id,new.credit_note_number,'Returned on credit note '||new.credit_note_number,v_actor
    );
    insert into public.audit_logs(tenant_id,actor_user_id,event_name,entity_type,entity_id,details)
    values(new.tenant_id,v_actor,'inventory.item_returned','inventory_item',v_item.id::text,
      jsonb_build_object('credit_note_id',new.id,'credit_note_number',new.credit_note_number,
        'invoice_id',new.invoice_id,'invoice_line_id',v_line.invoice_line_id,'item_code',v_item.item_code));
  end loop;
  return new;
end;
$$;

drop trigger if exists credit_note_issue_restock_tracked_items on public.credit_notes;
create trigger credit_note_issue_restock_tracked_items
after update of status on public.credit_notes
for each row when (old.status='draft' and new.status='issued')
execute function private.process_inventory_return_on_credit_note_issue();

revoke all on function public.create_draft_invoice_for_inventory_item(uuid,uuid,uuid,uuid,numeric,numeric) from public,anon;
grant execute on function public.create_draft_invoice_for_inventory_item(uuid,uuid,uuid,uuid,numeric,numeric) to authenticated;
revoke all on function private.process_inventory_sale_on_invoice_issue() from public,anon,authenticated;
revoke all on function private.validate_tracked_item_credit_note_line() from public,anon,authenticated;
revoke all on function private.process_inventory_return_on_credit_note_issue() from public,anon,authenticated;

commit;