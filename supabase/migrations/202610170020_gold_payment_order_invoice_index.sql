begin;
create index if not exists payment_orders_tenant_invoice_idx
  on public.payment_orders(tenant_id,invoice_id);
commit;