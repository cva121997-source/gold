begin;

create sequence if not exists public.credit_note_number_seq;

create table if not exists public.credit_notes (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  branch_id uuid references public.branches(id) on delete set null,
  invoice_id uuid not null references public.invoices(id) on delete restrict,
  customer_id uuid,
  credit_note_number text not null,
  status text not null default 'draft' check (status in ('draft','issued','void')),
  reason text not null check (length(trim(reason)) between 4 and 2000),
  subtotal numeric(14,2) not null default 0 check (subtotal >= 0),
  discount_amount numeric(14,2) not null default 0 check (discount_amount >= 0),
  taxable_amount numeric(14,2) not null default 0 check (taxable_amount >= 0),
  cgst_amount numeric(14,2) not null default 0 check (cgst_amount >= 0),
  sgst_amount numeric(14,2) not null default 0 check (sgst_amount >= 0),
  igst_amount numeric(14,2) not null default 0 check (igst_amount >= 0),
  total_amount numeric(14,2) not null default 0 check (total_amount >= 0),
  currency text not null default 'INR' check (currency='INR'),
  tax_snapshot jsonb not null default '{}'::jsonb,
  rate_snapshot jsonb not null default '{}'::jsonb,
  customer_snapshot jsonb not null default '{}'::jsonb,
  created_by uuid references auth.users(id) on delete set null,
  approved_by uuid references auth.users(id) on delete set null,
  issued_at timestamptz,
  voided_at timestamptz,
  void_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, id),
  unique (tenant_id, credit_note_number)
);
create index if not exists credit_notes_invoice_history_idx on public.credit_notes(tenant_id, invoice_id, created_at desc);
create index if not exists credit_notes_status_idx on public.credit_notes(tenant_id, status, created_at desc);

create table if not exists public.credit_note_lines (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  credit_note_id uuid not null,
  invoice_line_id uuid not null,
  description text not null,
  quantity numeric(12,3) not null check (quantity > 0),
  gross_weight_grams numeric(12,3) not null default 0 check (gross_weight_grams >= 0),
  net_metal_weight_grams numeric(12,3) not null default 0 check (net_metal_weight_grams >= 0),
  subtotal_amount numeric(14,2) not null default 0 check (subtotal_amount >= 0),
  discount_amount numeric(14,2) not null default 0 check (discount_amount >= 0),
  taxable_amount numeric(14,2) not null default 0 check (taxable_amount >= 0),
  cgst_amount numeric(14,2) not null default 0 check (cgst_amount >= 0),
  sgst_amount numeric(14,2) not null default 0 check (sgst_amount >= 0),
  igst_amount numeric(14,2) not null default 0 check (igst_amount >= 0),
  tax_amount numeric(14,2) not null default 0 check (tax_amount >= 0),
  line_total numeric(14,2) not null default 0 check (line_total >= 0),
  item_snapshot jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  foreign key (tenant_id, credit_note_id) references public.credit_notes(tenant_id, id) on delete restrict,
  unique (credit_note_id, invoice_line_id)
);
create index if not exists credit_note_lines_invoice_line_idx on public.credit_note_lines(tenant_id, invoice_line_id);

alter table public.credit_notes enable row level security;
alter table public.credit_note_lines enable row level security;

drop policy if exists credit_notes_staff_read on public.credit_notes;
create policy credit_notes_staff_read on public.credit_notes for select to authenticated
  using (private.has_tenant_branch_access(tenant_id, branch_id, array['owner','manager','accountant','cashier']));
drop policy if exists credit_note_lines_staff_read on public.credit_note_lines;
create policy credit_note_lines_staff_read on public.credit_note_lines for select to authenticated
  using (exists (select 1 from public.credit_notes n where n.tenant_id=credit_note_lines.tenant_id
    and n.id=credit_note_lines.credit_note_id
    and private.has_tenant_branch_access(n.tenant_id,n.branch_id,array['owner','manager','accountant','cashier'])));
revoke insert, update, delete on public.credit_notes from anon, authenticated;
revoke insert, update, delete on public.credit_note_lines from anon, authenticated;
grant select on public.credit_notes, public.credit_note_lines to authenticated;
grant all on public.credit_notes, public.credit_note_lines to service_role;

create or replace function public.create_credit_note_draft(
  p_tenant_id uuid,
  p_invoice_id uuid,
  p_reason text,
  p_lines jsonb
) returns uuid
language plpgsql security definer
set search_path=public,private,pg_temp
as $$
declare
  v_user uuid:=auth.uid();
  v_invoice public.invoices%rowtype;
  v_credit_id uuid;
  v_credit_number text;
  v_request record;
  v_line public.invoice_lines%rowtype;
  v_already numeric;
  v_ratio numeric;
  v_taxable_line numeric(14,2);
  v_discount_line numeric(14,2);
  v_cgst_rate numeric(8,4);
  v_sgst_rate numeric(8,4);
  v_igst_rate numeric(8,4);
  v_cgst_line numeric(14,2);
  v_sgst_line numeric(14,2);
  v_igst_line numeric(14,2);
  v_tax_line numeric(14,2);
  v_total_line numeric(14,2);
  v_subtotal numeric(14,2):=0;
  v_discount numeric(14,2):=0;
  v_taxable numeric(14,2):=0;
  v_cgst numeric(14,2):=0;
  v_sgst numeric(14,2):=0;
  v_igst numeric(14,2):=0;
  v_count integer:=0;
begin
  if v_user is null then raise exception 'Authentication required' using errcode='42501'; end if;
  if not private.has_tenant_role(p_tenant_id,array['owner','manager','accountant','cashier']) then
    raise exception 'Permission denied' using errcode='42501';
  end if;
  if length(trim(coalesce(p_reason,'')))<4 then raise exception 'Enter a credit note reason of at least four characters'; end if;
  if jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines)<1 or jsonb_array_length(p_lines)>50 then
    raise exception 'Choose between one and 50 invoice lines to return';
  end if;
  if exists (select 1 from jsonb_to_recordset(p_lines) as x(invoice_line_id uuid, quantity numeric)
    where x.invoice_line_id is null or x.quantity is null or x.quantity<=0) then
    raise exception 'Each return line needs an invoice line ID and a positive quantity';
  end if;
  if exists (select 1 from jsonb_to_recordset(p_lines) as x(invoice_line_id uuid, quantity numeric)
    group by x.invoice_line_id having count(*)>1) then
    raise exception 'Choose each invoice line only once per credit note';
  end if;

  select * into v_invoice from public.invoices
    where tenant_id=p_tenant_id and id=p_invoice_id and status in ('issued','partially_paid','paid','credited')
    for update;
  if not found then raise exception 'A completed invoice for this shop was not found'; end if;
  if not private.has_tenant_branch_access(p_tenant_id,v_invoice.branch_id,array['owner','manager','accountant','cashier']) then
    raise exception 'Branch access denied' using errcode='42501';
  end if;

  v_credit_number:='CN-'||to_char(now() at time zone 'Asia/Kolkata','YYYYMMDD')||'-'||lpad(nextval('public.credit_note_number_seq')::text,8,'0');
  insert into public.credit_notes(
    tenant_id,branch_id,invoice_id,customer_id,credit_note_number,status,reason,
    tax_snapshot,rate_snapshot,customer_snapshot,created_by
  ) values (
    p_tenant_id,v_invoice.branch_id,v_invoice.id,v_invoice.customer_id,v_credit_number,'draft',trim(p_reason),
    v_invoice.tax_snapshot,v_invoice.rate_snapshot,v_invoice.customer_snapshot,v_user
  ) returning id into v_credit_id;

  for v_request in
    select x.invoice_line_id,x.quantity
    from jsonb_to_recordset(p_lines) as x(invoice_line_id uuid, quantity numeric)
  loop
    select * into v_line from public.invoice_lines il
      where il.tenant_id=p_tenant_id and il.invoice_id=p_invoice_id and il.id=v_request.invoice_line_id
      for update;
    if not found then raise exception 'A return line does not belong to the selected invoice'; end if;
    if v_line.quantity<=0 then raise exception 'This invoice line does not have a returnable quantity'; end if;

    select coalesce(sum(cnl.quantity),0) into v_already
      from public.credit_note_lines cnl join public.credit_notes cn
        on cn.tenant_id=cnl.tenant_id and cn.id=cnl.credit_note_id
      where cn.tenant_id=p_tenant_id and cn.invoice_id=p_invoice_id
        and cnl.invoice_line_id=v_line.id and cn.status in ('draft','issued');
    if v_request.quantity > v_line.quantity-v_already then
      raise exception 'Return quantity exceeds the remaining quantity for invoice line %',v_line.line_number;
    end if;

    v_ratio:=v_request.quantity/v_line.quantity;
    v_taxable_line:=round(greatest(0,v_line.line_total-v_line.tax_amount)*v_ratio,2);
    v_discount_line:=round(v_line.discount_amount*v_ratio,2);
    v_cgst_rate:=coalesce(nullif(v_line.item_snapshot->>'cgst_rate_percent','')::numeric,
      nullif(v_invoice.tax_snapshot->>'cgst_rate_percent','')::numeric,0);
    v_sgst_rate:=coalesce(nullif(v_line.item_snapshot->>'sgst_rate_percent','')::numeric,
      nullif(v_invoice.tax_snapshot->>'sgst_rate_percent','')::numeric,0);
    v_igst_rate:=coalesce(nullif(v_line.item_snapshot->>'igst_rate_percent','')::numeric,
      nullif(v_invoice.tax_snapshot->>'igst_rate_percent','')::numeric,0);
    v_cgst_line:=round(v_taxable_line*v_cgst_rate/100,0);
    v_sgst_line:=round(v_taxable_line*v_sgst_rate/100,0);
    v_igst_line:=round(v_taxable_line*v_igst_rate/100,0);
    v_tax_line:=v_cgst_line+v_sgst_line+v_igst_line;
    v_total_line:=v_taxable_line+v_tax_line;

    insert into public.credit_note_lines(
      tenant_id,credit_note_id,invoice_line_id,description,quantity,gross_weight_grams,net_metal_weight_grams,
      subtotal_amount,discount_amount,taxable_amount,cgst_amount,sgst_amount,igst_amount,tax_amount,line_total,item_snapshot
    ) values (
      p_tenant_id,v_credit_id,v_line.id,v_line.description,v_request.quantity,
      round(v_line.gross_weight_grams*v_ratio,3),round(v_line.net_metal_weight_grams*v_ratio,3),
      v_taxable_line+v_discount_line,v_discount_line,v_taxable_line,v_cgst_line,v_sgst_line,v_igst_line,v_tax_line,v_total_line,
      coalesce(v_line.item_snapshot,'{}'::jsonb)||jsonb_build_object(
        'original_line_id',v_line.id,'original_quantity',v_line.quantity,'original_line_total',v_line.line_total,
        'original_tax_amount',v_line.tax_amount,'original_discount_amount',v_line.discount_amount,
        'purity_label',v_line.purity_label,'rate_per_gram',v_line.rate_per_gram,
        'returned_quantity',v_request.quantity,'allocation_ratio',v_ratio)
    );

    v_count:=v_count+1;
    v_subtotal:=v_subtotal+v_taxable_line+v_discount_line;
    v_discount:=v_discount+v_discount_line;
    v_taxable:=v_taxable+v_taxable_line;
    v_cgst:=v_cgst+v_cgst_line; v_sgst:=v_sgst+v_sgst_line; v_igst:=v_igst+v_igst_line;
  end loop;

  if v_count=0 or v_taxable+v_cgst+v_sgst+v_igst<=0 then raise exception 'Credit note total must be greater than zero'; end if;
  update public.credit_notes set subtotal=v_subtotal,discount_amount=v_discount,taxable_amount=v_taxable,
    cgst_amount=v_cgst,sgst_amount=v_sgst,igst_amount=v_igst,total_amount=v_taxable+v_cgst+v_sgst+v_igst,
    updated_at=now()
    where tenant_id=p_tenant_id and id=v_credit_id;

  insert into public.audit_logs(tenant_id,actor_user_id,event_name,entity_type,entity_id,details)
  values(p_tenant_id,v_user,'credit_note.draft_created','credit_note',v_credit_id::text,
    jsonb_build_object('invoice_id',p_invoice_id,'credit_note_number',v_credit_number,
      'total_amount',v_taxable+v_cgst+v_sgst+v_igst,'line_count',v_count,'reason',trim(p_reason)));
  return v_credit_id;
end;
$$;

create or replace function public.issue_credit_note(p_tenant_id uuid,p_credit_note_id uuid) returns uuid
language plpgsql security definer
set search_path=public,private,pg_temp
as $$
declare
  v_user uuid:=auth.uid();
  v_note public.credit_notes%rowtype;
begin
  if v_user is null then raise exception 'Authentication required' using errcode='42501'; end if;
  if not private.has_tenant_role(p_tenant_id,array['owner','manager','accountant']) then
    raise exception 'Permission denied' using errcode='42501';
  end if;
  select * into v_note from public.credit_notes
    where tenant_id=p_tenant_id and id=p_credit_note_id for update;
  if not found or v_note.status<>'draft' then raise exception 'Only a draft credit note can be issued'; end if;
  if not private.has_tenant_branch_access(p_tenant_id,v_note.branch_id,array['owner','manager','accountant']) then
    raise exception 'Branch access denied' using errcode='42501';
  end if;
  if v_note.total_amount<=0 or not exists (select 1 from public.credit_note_lines where tenant_id=p_tenant_id and credit_note_id=v_note.id) then
    raise exception 'Credit note must contain valid lines and a positive total';
  end if;
  update public.credit_notes set status='issued',approved_by=v_user,issued_at=now(),updated_at=now()
    where tenant_id=p_tenant_id and id=p_credit_note_id;
  insert into public.audit_logs(tenant_id,actor_user_id,event_name,entity_type,entity_id,details)
  values(p_tenant_id,v_user,'credit_note.issued','credit_note',p_credit_note_id::text,
    jsonb_build_object('invoice_id',v_note.invoice_id,'credit_note_number',v_note.credit_note_number,'total_amount',v_note.total_amount));
  return p_credit_note_id;
end;
$$;

create or replace function public.void_draft_credit_note(p_tenant_id uuid,p_credit_note_id uuid,p_reason text) returns uuid
language plpgsql security definer
set search_path=public,private,pg_temp
as $$
declare
  v_user uuid:=auth.uid();
  v_note public.credit_notes%rowtype;
begin
  if v_user is null then raise exception 'Authentication required' using errcode='42501'; end if;
  if not private.has_tenant_role(p_tenant_id,array['owner','manager']) then
    raise exception 'Permission denied' using errcode='42501';
  end if;
  if length(trim(coalesce(p_reason,'')))<4 then raise exception 'Enter a void reason of at least four characters'; end if;
  select * into v_note from public.credit_notes where tenant_id=p_tenant_id and id=p_credit_note_id for update;
  if not found or v_note.status<>'draft' then raise exception 'Only a draft credit note can be voided'; end if;
  update public.credit_notes set status='void',voided_at=now(),void_reason=trim(p_reason),updated_at=now()
    where tenant_id=p_tenant_id and id=p_credit_note_id;
  insert into public.audit_logs(tenant_id,actor_user_id,event_name,entity_type,entity_id,details)
  values(p_tenant_id,v_user,'credit_note.voided','credit_note',p_credit_note_id::text,
    jsonb_build_object('invoice_id',v_note.invoice_id,'credit_note_number',v_note.credit_note_number,'reason',trim(p_reason)));
  return p_credit_note_id;
end;
$$;

revoke all on function public.create_credit_note_draft(uuid,uuid,text,jsonb) from public,anon;
revoke all on function public.issue_credit_note(uuid,uuid) from public,anon;
revoke all on function public.void_draft_credit_note(uuid,uuid,text) from public,anon;
grant execute on function public.create_credit_note_draft(uuid,uuid,text,jsonb) to authenticated;
grant execute on function public.issue_credit_note(uuid,uuid) to authenticated;
grant execute on function public.void_draft_credit_note(uuid,uuid,text) to authenticated;

commit;