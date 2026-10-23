begin;
alter table public.invoice_lines
  add column if not exists item_snapshot_updated_at timestamptz;
update public.invoice_lines
  set item_snapshot_updated_at=now()
  where item_snapshot_updated_at is null and inventory_item_id is not null;
commit;