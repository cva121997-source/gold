-- Gold retail operations and SaaS modules.
-- Additive migration: all new tenant tables have RLS and tenant-scoped access policies.
begin;

create table if not exists public.subscription_plans (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  name text not null,
  description text,
  monthly_price_inr numeric(14,2) not null default 0 check (monthly_price_inr >= 0),
  annual_price_inr numeric(14,2) not null default 0 check (annual_price_inr >= 0),
  trial_days integer not null default 0 check (trial_days >= 0),
  entitlements jsonb not null default '{}'::jsonb,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
insert into public.subscription_plans(code,name,description,monthly_price_inr,annual_price_inr,trial_days,entitlements)
values
 ('starter','Starter','Single shop, local rate board, calculator and basic schemes',0,0,14,'{"branches":1,"staff":2,"customers":500,"rates":true,"schemes":true}'::jsonb),
 ('growth','Growth','Multi-employee shop operations, collections and reports',0,0,14,'{"branches":3,"staff":10,"customers":5000,"collections":true,"notifications":true,"reports":true}'::jsonb),
 ('professional','Professional','Retail inventory, POS and analytics',0,0,14,'{"branches":5,"staff":25,"inventory":true,"pos":true,"analytics":true}'::jsonb),
 ('enterprise','Enterprise','Multi-branch and granular operational controls',0,0,30,'{"branches":null,"staff":null,"inventory":true,"pos":true,"advanced_permissions":true}'::jsonb)
on conflict (code) do nothing;

create table if not exists public.tenant_subscriptions (
 id uuid primary key default gen_random_uuid(),
 tenant_id uuid not null references public.tenants(id) on delete cascade,
 plan_id uuid references public.subscription_plans(id),
 status text not null default 'trial' check (status in ('trial','active','past_due','cancelled','suspended')),
 trial_ends_at timestamptz,
 current_period_start timestamptz,
 current_period_end timestamptz,
 cancel_at_period_end boolean not null default false,
 provider text,
 provider_customer_ref text,
 provider_subscription_ref text,
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now(),
 unique (tenant_id)
);
create table if not exists public.feature_entitlements (
 id uuid primary key default gen_random_uuid(),
 tenant_id uuid not null references public.tenants(id) on delete cascade,
 feature_key text not null,
 enabled boolean not null default false,
 limit_value integer,
 configuration jsonb not null default '{}'::jsonb,
 updated_by uuid references auth.users(id) on delete set null,
 updated_at timestamptz not null default now(),
 unique (tenant_id, feature_key)
);

create table if not exists public.customer_consents (
 id uuid primary key default gen_random_uuid(),
 tenant_id uuid not null references public.tenants(id) on delete cascade,
 customer_id uuid not null,
 consent_type text not null check (consent_type in ('privacy_notice','scheme_terms','sms','whatsapp','email','promotional','data_processing')),
 consented boolean not null,
 terms_version text,
 source text not null default 'staff_entry',
 captured_by uuid references auth.users(id) on delete set null,
 captured_at timestamptz not null default now(),
 withdrawn_at timestamptz,
 metadata jsonb not null default '{}'::jsonb,
 foreign key (tenant_id,customer_id) references public.tenant_customers(tenant_id,id) on delete cascade
);
create index if not exists customer_consents_latest_idx on public.customer_consents(tenant_id,customer_id,consent_type,captured_at desc);

create table if not exists public.tax_configurations (
 id uuid primary key default gen_random_uuid(),
 tenant_id uuid not null references public.tenants(id) on delete cascade,
 name text not null,
 effective_from date not null default current_date,
 effective_until date,
 intra_state_cgst_percent numeric(6,3) not null default 1.5 check (intra_state_cgst_percent between 0 and 100),
 intra_state_sgst_percent numeric(6,3) not null default 1.5 check (intra_state_sgst_percent between 0 and 100),
 inter_state_igst_percent numeric(6,3) not null default 3 check (inter_state_igst_percent between 0 and 100),
 rules jsonb not null default '{}'::jsonb,
 approved_by uuid references auth.users(id) on delete set null,
 approved_at timestamptz,
 created_at timestamptz not null default now(),
 unique (tenant_id,id),
 check (effective_until is null or effective_until >= effective_from)
);
create table if not exists public.calculator_quotes (
 id uuid primary key default gen_random_uuid(),
 tenant_id uuid not null references public.tenants(id) on delete cascade,
 branch_id uuid,
 quote_code text not null,
 customer_id uuid,
 metal_id smallint references public.metals(id),
 purity_id smallint,
 gold_rate_snapshot numeric(14,2) not null check (gold_rate_snapshot >= 0),
 weight_grams numeric(14,6) not null check (weight_grams >= 0),
 gold_value numeric(14,2) not null,
 making_charge_mode text not null check (making_charge_mode in ('percent','fixed','per_gram')),
 making_charge_input numeric(14,4) not null default 0,
 making_value numeric(14,2) not null default 0,
 wastage_value numeric(14,2) not null default 0,
 other_charges numeric(14,2) not null default 0,
 discount numeric(14,2) not null default 0,
 taxable_subtotal numeric(14,2) not null,
 tax_amount numeric(14,2) not null default 0,
 total_amount numeric(14,2) not null,
 currency text not null default 'INR',
 rate_source_snapshot jsonb not null default '{}'::jsonb,
 calculation_snapshot jsonb not null default '{}'::jsonb,
 expires_at timestamptz,
 created_by uuid references auth.users(id) on delete set null,
 created_at timestamptz not null default now(),
 unique (tenant_id,quote_code),
 foreign key (tenant_id,branch_id) references public.branches(tenant_id,id),
 foreign key (tenant_id,customer_id) references public.tenant_customers(tenant_id,id),
 foreign key (metal_id,purity_id) references public.purity_definitions(metal_id,id)
);
create index if not exists calculator_quotes_tenant_created_idx on public.calculator_quotes(tenant_id,created_at desc);

create table if not exists public.scheme_installments (
 id uuid primary key default gen_random_uuid(),
 tenant_id uuid not null references public.tenants(id) on delete cascade,
 branch_id uuid,
 enrolment_id uuid not null,
 installment_no integer not null check (installment_no > 0),
 due_date date not null,
 amount_due numeric(14,2) not null check (amount_due >= 0),
 amount_paid numeric(14,2) not null default 0 check (amount_paid >= 0),
 status text not null default 'upcoming' check (status in ('upcoming','due','partial','paid','overdue','waived','cancelled')),
 paid_at timestamptz,
 notes text,
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now(),
 unique (tenant_id,enrolment_id,installment_no),
 foreign key (tenant_id,branch_id) references public.branches(tenant_id,id),
 foreign key (tenant_id,enrolment_id) references public.scheme_enrolments(tenant_id,id),
 check (amount_paid <= amount_due)
);
create index if not exists scheme_installments_due_idx on public.scheme_installments(tenant_id,due_date,status);

create table if not exists public.scheme_benefits (
 id uuid primary key default gen_random_uuid(),
 tenant_id uuid not null references public.tenants(id) on delete cascade,
 enrolment_id uuid not null,
 benefit_type text not null check (benefit_type in ('gold_weight_bonus','purchase_credit','making_discount','custom')),
 status text not null default 'pending' check (status in ('pending','eligible','approved','redeemed','forfeited','cancelled')),
 amount_value numeric(14,2),
 weight_grams numeric(14,6),
 rules_snapshot jsonb not null default '{}'::jsonb,
 eligible_at timestamptz,
 approved_by uuid references auth.users(id) on delete set null,
 approved_at timestamptz,
 created_at timestamptz not null default now(),
 unique (tenant_id,id),
 foreign key (tenant_id,enrolment_id) references public.scheme_enrolments(tenant_id,id)
);
create table if not exists public.scheme_redemptions (
 id uuid primary key default gen_random_uuid(),
 tenant_id uuid not null references public.tenants(id) on delete cascade,
 branch_id uuid,
 enrolment_id uuid not null,
 benefit_id uuid,
 redemption_code text not null,
 status text not null default 'requested' check (status in ('requested','approved','completed','rejected','cancelled')),
 value_inr numeric(14,2) not null default 0 check (value_inr >= 0),
 weight_grams numeric(14,6) not null default 0 check (weight_grams >= 0),
 approved_by uuid references auth.users(id) on delete set null,
 approved_at timestamptz,
 completed_at timestamptz,
 notes text,
 created_at timestamptz not null default now(),
 unique (tenant_id,redemption_code),
 foreign key (tenant_id,branch_id) references public.branches(tenant_id,id),
 foreign key (tenant_id,enrolment_id) references public.scheme_enrolments(tenant_id,id),
 foreign key (tenant_id,benefit_id) references public.scheme_benefits(tenant_id,id)
);

create table if not exists public.sales (
 id uuid primary key default gen_random_uuid(),
 tenant_id uuid not null references public.tenants(id) on delete cascade,
 branch_id uuid,
 customer_id uuid,
 sale_number text not null,
 status text not null default 'draft' check (status in ('draft','completed','void','returned')),
 subtotal numeric(14,2) not null default 0,
 discount_amount numeric(14,2) not null default 0,
 tax_amount numeric(14,2) not null default 0,
 total_amount numeric(14,2) not null default 0,
 currency text not null default 'INR',
 rate_snapshot jsonb not null default '{}'::jsonb,
 tax_snapshot jsonb not null default '{}'::jsonb,
 created_by uuid references auth.users(id) on delete set null,
 completed_at timestamptz,
 created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
 unique (tenant_id,sale_number), unique (tenant_id,id),
 foreign key (tenant_id,branch_id) references public.branches(tenant_id,id),
 foreign key (tenant_id,customer_id) references public.tenant_customers(tenant_id,id)
);

create table if not exists public.invoices (
 id uuid primary key default gen_random_uuid(),
 tenant_id uuid not null references public.tenants(id) on delete cascade,
 branch_id uuid,
 sale_id uuid,
 customer_id uuid,
 invoice_number text not null,
 status text not null default 'draft' check (status in ('draft','issued','partially_paid','paid','void','credited')),
 invoice_date date not null default current_date,
 due_date date,
 subtotal numeric(14,2) not null default 0,
 discount_amount numeric(14,2) not null default 0,
 taxable_amount numeric(14,2) not null default 0,
 cgst_amount numeric(14,2) not null default 0,
 sgst_amount numeric(14,2) not null default 0,
 igst_amount numeric(14,2) not null default 0,
 total_amount numeric(14,2) not null default 0,
 amount_paid numeric(14,2) not null default 0,
 tax_snapshot jsonb not null default '{}'::jsonb,
 rate_snapshot jsonb not null default '{}'::jsonb,
 customer_snapshot jsonb not null default '{}'::jsonb,
 issued_at timestamptz,
 created_by uuid references auth.users(id) on delete set null,
 created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
 unique (tenant_id,invoice_number), unique (tenant_id,id),
 foreign key (tenant_id,branch_id) references public.branches(tenant_id,id),
 foreign key (tenant_id,sale_id) references public.sales(tenant_id,id),
 foreign key (tenant_id,customer_id) references public.tenant_customers(tenant_id,id),
 check (amount_paid <= total_amount)
);

create table if not exists public.payment_orders (
 id uuid primary key default gen_random_uuid(),
 tenant_id uuid not null references public.tenants(id) on delete cascade,
 branch_id uuid,
 customer_id uuid,
 enrolment_id uuid,
 order_code text not null,
 provider text,
 provider_order_ref text,
 amount numeric(14,2) not null check (amount > 0),
 currency text not null default 'INR',
 purpose text not null check (purpose in ('scheme_contribution','invoice','order_advance','other')),
 status text not null default 'created' check (status in ('created','pending','paid','failed','cancelled','expired')),
 idempotency_key text not null,
 metadata jsonb not null default '{}'::jsonb,
 expires_at timestamptz,
 created_by uuid references auth.users(id) on delete set null,
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now(),
 unique (tenant_id,order_code), unique (tenant_id,idempotency_key), unique (tenant_id,id), unique (provider,provider_order_ref),
 foreign key (tenant_id,branch_id) references public.branches(tenant_id,id),
 foreign key (tenant_id,customer_id) references public.tenant_customers(tenant_id,id),
 foreign key (tenant_id,enrolment_id) references public.scheme_enrolments(tenant_id,id)
);
create table if not exists public.payments (
 id uuid primary key default gen_random_uuid(),
 tenant_id uuid not null references public.tenants(id) on delete cascade,
 branch_id uuid,
 customer_id uuid,
 enrolment_id uuid,
 invoice_id uuid,
 payment_order_id uuid,
 payment_method text not null check (payment_method in ('cash','upi','card','bank_transfer','gateway','cheque','mixed','other')),
 status text not null default 'pending' check (status in ('pending','confirmed','failed','refunded','reversed')),
 amount numeric(14,2) not null check (amount > 0),
 currency text not null default 'INR',
 reference text,
 provider text,
 provider_payment_ref text,
 idempotency_key text not null,
 confirmation_source text not null check (confirmation_source in ('staff','provider_webhook','system')),
 confirmed_by uuid references auth.users(id) on delete set null,
 confirmed_at timestamptz,
 metadata jsonb not null default '{}'::jsonb,
 created_at timestamptz not null default now(),
 unique (tenant_id,idempotency_key), unique (tenant_id,id), unique (provider,provider_payment_ref),
 foreign key (tenant_id,branch_id) references public.branches(tenant_id,id),
 foreign key (tenant_id,customer_id) references public.tenant_customers(tenant_id,id),
 foreign key (tenant_id,enrolment_id) references public.scheme_enrolments(tenant_id,id),
 foreign key (tenant_id,invoice_id) references public.invoices(tenant_id,id) deferrable initially deferred,
 foreign key (tenant_id,payment_order_id) references public.payment_orders(tenant_id,id)
);
create index if not exists payments_tenant_created_idx on public.payments(tenant_id,created_at desc);
create index if not exists payments_tenant_status_idx on public.payments(tenant_id,status,created_at desc);

create table if not exists public.payment_webhook_events (
 id uuid primary key default gen_random_uuid(),
 provider text not null,
 provider_event_id text not null,
 event_type text not null,
 payload_hash text,
 safe_payload jsonb not null default '{}'::jsonb,
 signature_verified boolean not null default false,
 processed_at timestamptz,
 processing_error text,
 received_at timestamptz not null default now(),
 unique (provider,provider_event_id)
);
create table if not exists public.refunds (
 id uuid primary key default gen_random_uuid(),
 tenant_id uuid not null references public.tenants(id) on delete cascade,
 payment_id uuid not null,
 amount numeric(14,2) not null check (amount > 0),
 reason text not null,
 status text not null default 'requested' check (status in ('requested','approved','processing','completed','failed','rejected')),
 provider_ref text,
 requested_by uuid references auth.users(id) on delete set null,
 approved_by uuid references auth.users(id) on delete set null,
 completed_at timestamptz,
 created_at timestamptz not null default now(),
 foreign key (tenant_id,payment_id) references public.payments(tenant_id,id)
);
create table if not exists public.receipts (
 id uuid primary key default gen_random_uuid(),
 tenant_id uuid not null references public.tenants(id) on delete cascade,
 branch_id uuid,
 payment_id uuid,
 enrolment_id uuid,
 invoice_id uuid,
 receipt_number text not null,
 receipt_type text not null check (receipt_type in ('payment','refund','scheme_enrolment','sale','adjustment')),
 snapshot jsonb not null,
 issued_at timestamptz not null default now(),
 issued_by uuid references auth.users(id) on delete set null,
 unique (tenant_id,receipt_number),
 foreign key (tenant_id,branch_id) references public.branches(tenant_id,id),
 foreign key (tenant_id,payment_id) references public.payments(tenant_id,id),
 foreign key (tenant_id,enrolment_id) references public.scheme_enrolments(tenant_id,id)
);
create table if not exists public.financial_adjustments (
 id uuid primary key default gen_random_uuid(),
 tenant_id uuid not null references public.tenants(id) on delete cascade,
 payment_id uuid,
 enrolment_id uuid,
 adjustment_type text not null check (adjustment_type in ('credit','debit','reversal','write_off','correction')),
 amount numeric(14,2) not null check (amount >= 0),
 reason text not null,
 approved_by uuid references auth.users(id) on delete set null,
 approved_at timestamptz,
 created_by uuid references auth.users(id) on delete set null,
 created_at timestamptz not null default now(),
 foreign key (tenant_id,payment_id) references public.payments(tenant_id,id),
 foreign key (tenant_id,enrolment_id) references public.scheme_enrolments(tenant_id,id)
);
create table if not exists public.reconciliation_records (
 id uuid primary key default gen_random_uuid(),
 tenant_id uuid not null references public.tenants(id) on delete cascade,
 branch_id uuid,
 provider text,
 period_start date not null,
 period_end date not null,
 expected_amount numeric(14,2) not null default 0,
 actual_amount numeric(14,2) not null default 0,
 difference_amount numeric(14,2) generated always as (actual_amount - expected_amount) stored,
 status text not null default 'open' check (status in ('open','matched','investigating','resolved')),
 notes text,
 reconciled_by uuid references auth.users(id) on delete set null,
 reconciled_at timestamptz,
 created_at timestamptz not null default now(),
 foreign key (tenant_id,branch_id) references public.branches(tenant_id,id),
 check (period_end >= period_start)
);

create table if not exists public.product_categories (
 id uuid primary key default gen_random_uuid(),
 tenant_id uuid not null references public.tenants(id) on delete cascade,
 name text not null, description text, is_active boolean not null default true,
 created_at timestamptz not null default now(), unique (tenant_id,name), unique (tenant_id,id)
);
create table if not exists public.suppliers (
 id uuid primary key default gen_random_uuid(),
 tenant_id uuid not null references public.tenants(id) on delete cascade,
 supplier_code text not null, name text not null, mobile text, email text, address text,
 gstin text, notes text, is_active boolean not null default true, created_at timestamptz not null default now(),
 unique (tenant_id,supplier_code), unique (tenant_id,id)
);
create table if not exists public.products (
 id uuid primary key default gen_random_uuid(),
 tenant_id uuid not null references public.tenants(id) on delete cascade,
 category_id uuid,
 product_code text not null, barcode text, name text not null, description text,
 metal_id smallint references public.metals(id), purity_id smallint,
 gross_weight_grams numeric(14,6) not null default 0 check (gross_weight_grams >= 0),
 net_metal_weight_grams numeric(14,6) not null default 0 check (net_metal_weight_grams >= 0),
 stone_weight_grams numeric(14,6) not null default 0 check (stone_weight_grams >= 0),
 making_charge_mode text not null default 'fixed' check (making_charge_mode in ('percent','fixed','per_gram')),
 making_charge_value numeric(14,4) not null default 0,
 wastage_percent numeric(8,4) not null default 0,
 purchase_cost numeric(14,2),
 base_selling_price numeric(14,2),
 huid text,
 hallmark_details jsonb not null default '{}'::jsonb,
 attributes jsonb not null default '{}'::jsonb,
 is_active boolean not null default true,
 created_by uuid references auth.users(id) on delete set null,
 created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
 unique (tenant_id,product_code), unique (tenant_id,id),
 foreign key (tenant_id,category_id) references public.product_categories(tenant_id,id),
 foreign key (metal_id,purity_id) references public.purity_definitions(metal_id,id),
 check (gross_weight_grams >= net_metal_weight_grams)
);
create unique index if not exists products_tenant_barcode_uq on public.products(tenant_id,barcode) where barcode is not null;
create table if not exists public.inventory_items (
 id uuid primary key default gen_random_uuid(),
 tenant_id uuid not null references public.tenants(id) on delete cascade,
 branch_id uuid,
 product_id uuid not null,
 item_code text not null,
 serial_number text,
 status text not null default 'in_stock' check (status in ('in_stock','reserved','sold','repair','transferred','written_off')),
 location_label text,
 acquired_at timestamptz not null default now(),
 purchase_cost numeric(14,2),
 current_valuation numeric(14,2),
 notes text,
 created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
 unique (tenant_id,item_code), unique (tenant_id,id),
 foreign key (tenant_id,branch_id) references public.branches(tenant_id,id),
 foreign key (tenant_id,product_id) references public.products(tenant_id,id)
);
create index if not exists inventory_items_branch_status_idx on public.inventory_items(tenant_id,branch_id,status);
create table if not exists public.inventory_movements (
 id uuid primary key default gen_random_uuid(),
 tenant_id uuid not null references public.tenants(id) on delete cascade,
 branch_id uuid,
 inventory_item_id uuid,
 product_id uuid,
 movement_type text not null check (movement_type in ('purchase','sale','return','transfer_out','transfer_in','adjustment','repair_out','repair_in','exchange')),
 quantity numeric(14,3) not null default 1 check (quantity > 0),
 from_branch_id uuid,
 to_branch_id uuid,
 reference text,
 reason text,
 actor_user_id uuid references auth.users(id) on delete set null,
 created_at timestamptz not null default now(),
 foreign key (tenant_id,branch_id) references public.branches(tenant_id,id),
 foreign key (tenant_id,inventory_item_id) references public.inventory_items(tenant_id,id),
 foreign key (tenant_id,product_id) references public.products(tenant_id,id),
 foreign key (tenant_id,from_branch_id) references public.branches(tenant_id,id),
 foreign key (tenant_id,to_branch_id) references public.branches(tenant_id,id)
);
create index if not exists inventory_movements_item_idx on public.inventory_movements(tenant_id,inventory_item_id,created_at desc);

create table if not exists public.sale_items (
 id uuid primary key default gen_random_uuid(),
 tenant_id uuid not null references public.tenants(id) on delete cascade,
 sale_id uuid not null,
 product_id uuid,
 inventory_item_id uuid,
 item_snapshot jsonb not null,
 quantity numeric(14,3) not null default 1 check (quantity > 0),
 net_metal_weight_grams numeric(14,6) not null default 0,
 unit_price numeric(14,2) not null check (unit_price >= 0),
 making_charge numeric(14,2) not null default 0,
 wastage_charge numeric(14,2) not null default 0,
 other_charges numeric(14,2) not null default 0,
 discount_amount numeric(14,2) not null default 0,
 tax_amount numeric(14,2) not null default 0,
 line_total numeric(14,2) not null check (line_total >= 0),
 created_at timestamptz not null default now(),
 foreign key (tenant_id,sale_id) references public.sales(tenant_id,id),
 foreign key (tenant_id,product_id) references public.products(tenant_id,id),
 foreign key (tenant_id,inventory_item_id) references public.inventory_items(tenant_id,id)
);

create table if not exists public.invoice_lines (
 id uuid primary key default gen_random_uuid(),
 tenant_id uuid not null references public.tenants(id) on delete cascade,
 invoice_id uuid not null,
 line_number integer not null,
 description text not null,
 quantity numeric(14,3) not null default 1,
 gross_weight_grams numeric(14,6) not null default 0,
 net_metal_weight_grams numeric(14,6) not null default 0,
 purity_label text,
 rate_per_gram numeric(14,2),
 making_amount numeric(14,2) not null default 0,
 wastage_amount numeric(14,2) not null default 0,
 other_charges numeric(14,2) not null default 0,
 discount_amount numeric(14,2) not null default 0,
 tax_rate numeric(8,4) not null default 0,
 tax_amount numeric(14,2) not null default 0,
 line_total numeric(14,2) not null check (line_total >= 0),
 item_snapshot jsonb not null default '{}'::jsonb,
 unique (tenant_id,invoice_id,line_number),
 foreign key (tenant_id,invoice_id) references public.invoices(tenant_id,id)
);

create table if not exists public.stock_transfers (
 id uuid primary key default gen_random_uuid(),
 tenant_id uuid not null references public.tenants(id) on delete cascade,
 transfer_code text not null,
 from_branch_id uuid not null,
 to_branch_id uuid not null,
 status text not null default 'draft' check (status in ('draft','dispatched','received','cancelled')),
 notes text,
 created_by uuid references auth.users(id) on delete set null,
 dispatched_at timestamptz,
 received_at timestamptz,
 received_by uuid references auth.users(id) on delete set null,
 created_at timestamptz not null default now(),
 unique (tenant_id,transfer_code), unique (tenant_id,id),
 foreign key (tenant_id,from_branch_id) references public.branches(tenant_id,id),
 foreign key (tenant_id,to_branch_id) references public.branches(tenant_id,id),
 check (from_branch_id <> to_branch_id)
);
create table if not exists public.stock_transfer_items (
 id uuid primary key default gen_random_uuid(),
 tenant_id uuid not null references public.tenants(id) on delete cascade,
 transfer_id uuid not null,
 inventory_item_id uuid not null,
 notes text,
 unique (tenant_id,transfer_id,inventory_item_id),
 foreign key (tenant_id,transfer_id) references public.stock_transfers(tenant_id,id),
 foreign key (tenant_id,inventory_item_id) references public.inventory_items(tenant_id,id)
);

create table if not exists public.old_gold_valuations (
 id uuid primary key default gen_random_uuid(),
 tenant_id uuid not null references public.tenants(id) on delete cascade,
 branch_id uuid,
 customer_id uuid,
 valuation_number text not null,
 metal_id smallint references public.metals(id),
 purity_id smallint,
 estimated_weight_grams numeric(14,6) not null check (estimated_weight_grams >= 0),
 net_weight_grams numeric(14,6) not null check (net_weight_grams >= 0),
 rate_per_gram numeric(14,2) not null check (rate_per_gram >= 0),
 deduction_percent numeric(8,4) not null default 0,
 stone_deduction_inr numeric(14,2) not null default 0,
 testing_notes text,
 estimated_value numeric(14,2) not null check (estimated_value >= 0),
 final_value numeric(14,2),
 status text not null default 'estimate' check (status in ('estimate','approved','rejected','exchanged')),
 rate_snapshot jsonb not null default '{}'::jsonb,
 approved_by uuid references auth.users(id) on delete set null,
 approved_at timestamptz,
 created_by uuid references auth.users(id) on delete set null,
 created_at timestamptz not null default now(),
 unique (tenant_id,valuation_number),
 foreign key (tenant_id,branch_id) references public.branches(tenant_id,id),
 foreign key (tenant_id,customer_id) references public.tenant_customers(tenant_id,id),
 foreign key (metal_id,purity_id) references public.purity_definitions(metal_id,id),
 check (net_weight_grams <= estimated_weight_grams)
);

create table if not exists public.customer_orders (
 id uuid primary key default gen_random_uuid(),
 tenant_id uuid not null references public.tenants(id) on delete cascade,
 branch_id uuid,
 customer_id uuid,
 order_number text not null,
 order_type text not null check (order_type in ('custom_jewellery','advance_booking','repair','other')),
 status text not null default 'enquiry' check (status in ('enquiry','quoted','confirmed','in_progress','ready','delivered','cancelled')),
 description text not null,
 estimated_amount numeric(14,2) not null default 0,
 deposit_amount numeric(14,2) not null default 0,
 balance_amount numeric(14,2) not null default 0,
 expected_delivery date,
 customer_item_intake jsonb not null default '{}'::jsonb,
 assigned_to uuid references auth.users(id) on delete set null,
 created_by uuid references auth.users(id) on delete set null,
 created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
 unique (tenant_id,order_number), unique (tenant_id,id),
 foreign key (tenant_id,branch_id) references public.branches(tenant_id,id),
 foreign key (tenant_id,customer_id) references public.tenant_customers(tenant_id,id)
);
create table if not exists public.repair_jobs (
 id uuid primary key default gen_random_uuid(),
 tenant_id uuid not null references public.tenants(id) on delete cascade,
 branch_id uuid,
 customer_id uuid,
 order_id uuid,
 job_number text not null,
 description text not null,
 intake_condition text,
 customer_item_snapshot jsonb not null default '{}'::jsonb,
 estimated_cost numeric(14,2) not null default 0,
 final_cost numeric(14,2),
 status text not null default 'received' check (status in ('received','assessed','approved','repairing','ready','returned','cancelled')),
 promised_date date,
 assigned_to uuid references auth.users(id) on delete set null,
 intake_receipt_snapshot jsonb not null default '{}'::jsonb,
 created_by uuid references auth.users(id) on delete set null,
 created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
 unique (tenant_id,job_number), unique (tenant_id,id),
 foreign key (tenant_id,branch_id) references public.branches(tenant_id,id),
 foreign key (tenant_id,customer_id) references public.tenant_customers(tenant_id,id),
 foreign key (tenant_id,order_id) references public.customer_orders(tenant_id,id)
);

create table if not exists public.notification_templates (
 id uuid primary key default gen_random_uuid(),
 tenant_id uuid references public.tenants(id) on delete cascade,
 template_key text not null,
 channel text not null check (channel in ('sms','whatsapp','email','in_app')),
 language_code text not null default 'en',
 subject text,
 body text not null,
 provider_template_ref text,
 is_active boolean not null default true,
 created_at timestamptz not null default now(),
 unique (tenant_id,template_key,channel,language_code)
);
create table if not exists public.notifications (
 id uuid primary key default gen_random_uuid(),
 tenant_id uuid not null references public.tenants(id) on delete cascade,
 customer_id uuid,
 recipient_user_id uuid references auth.users(id) on delete set null,
 channel text not null check (channel in ('sms','whatsapp','email','in_app')),
 notification_type text not null,
 status text not null default 'queued' check (status in ('queued','processing','sent','delivered','failed','cancelled')),
 destination_snapshot text,
 template_key text,
 language_code text not null default 'en',
 safe_payload jsonb not null default '{}'::jsonb,
 provider_message_ref text,
 failure_reason text,
 scheduled_at timestamptz,
 sent_at timestamptz,
 delivered_at timestamptz,
 created_at timestamptz not null default now(),
 foreign key (tenant_id,customer_id) references public.tenant_customers(tenant_id,id)
);
create index if not exists notifications_queue_idx on public.notifications(status,scheduled_at) where status in ('queued','failed');
create table if not exists public.notification_delivery_events (
 id uuid primary key default gen_random_uuid(),
 notification_id uuid not null references public.notifications(id) on delete cascade,
 event_type text not null,
 provider_event_ref text,
 details jsonb not null default '{}'::jsonb,
 created_at timestamptz not null default now(),
 unique (provider_event_ref)
);
create table if not exists public.system_integrations (
 id uuid primary key default gen_random_uuid(),
 tenant_id uuid references public.tenants(id) on delete cascade,
 provider_key text not null,
 display_name text not null,
 status text not null default 'not_configured' check (status in ('not_configured','configured','connected','degraded','disabled')),
 credential_secret_ref text,
 settings jsonb not null default '{}'::jsonb,
 last_success_at timestamptz,
 last_failure_at timestamptz,
 last_failure_summary text,
 updated_by uuid references auth.users(id) on delete set null,
 updated_at timestamptz not null default now(),
 unique (tenant_id,provider_key)
);
create table if not exists public.support_tickets (
 id uuid primary key default gen_random_uuid(),
 tenant_id uuid references public.tenants(id) on delete set null,
 created_by uuid references auth.users(id) on delete set null,
 subject text not null,
 description text not null,
 category text not null default 'general',
 priority text not null default 'normal' check (priority in ('low','normal','high','urgent')),
 status text not null default 'open' check (status in ('open','in_progress','waiting','resolved','closed')),
 assigned_to uuid references auth.users(id) on delete set null,
 internal_notes text,
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now()
);
create table if not exists public.staff_invitations (
 id uuid primary key default gen_random_uuid(),
 tenant_id uuid not null references public.tenants(id) on delete cascade,
 branch_id uuid,
 invitee_mobile text,
 invitee_email text,
 role text not null check (role in ('manager','accountant','cashier','scheme_manager','inventory_manager','employee')),
 permissions jsonb not null default '{}'::jsonb,
 token_hash text not null unique,
 expires_at timestamptz not null,
 accepted_by uuid references auth.users(id) on delete set null,
 accepted_at timestamptz,
 revoked_at timestamptz,
 created_by uuid references auth.users(id) on delete set null,
 created_at timestamptz not null default now(),
 foreign key (tenant_id,branch_id) references public.branches(tenant_id,id),
 check (invitee_mobile is not null or invitee_email is not null)
);
create table if not exists public.platform_admins (
 user_id uuid primary key references auth.users(id) on delete cascade,
 admin_role text not null default 'platform_support' check (admin_role in ('platform_owner','platform_admin','platform_support')),
 created_at timestamptz not null default now(),
 created_by uuid references auth.users(id) on delete set null
);
create table if not exists public.platform_settings (
 setting_key text primary key,
 setting_value jsonb not null default '{}'::jsonb,
 updated_by uuid references auth.users(id) on delete set null,
 updated_at timestamptz not null default now()
);
create table if not exists public.feature_flags (
 flag_key text primary key,
 enabled boolean not null default false,
 configuration jsonb not null default '{}'::jsonb,
 updated_by uuid references auth.users(id) on delete set null,
 updated_at timestamptz not null default now()
);

-- Shared reference table read access.
alter table public.subscription_plans enable row level security;
create policy "active_subscription_plans_read" on public.subscription_plans for select to anon,authenticated using (is_active = true);
grant select on public.subscription_plans to anon,authenticated;

-- Tenant ownership links and branch constraints are checked in database policies.
create or replace function public.has_tenant_branch_access(p_tenant_id uuid, p_branch_id uuid, p_roles text[] default null)
returns boolean
language sql stable security definer set search_path = public, pg_temp
as $$
  select exists (
    select 1 from public.tenant_memberships m
    where m.tenant_id = p_tenant_id and m.user_id = auth.uid() and m.is_active
      and (p_roles is null or m.role = any(p_roles))
      and (p_branch_id is null or m.role in ('owner','manager') or m.branch_id = p_branch_id)
  );
$$;
grant execute on function public.has_tenant_branch_access(uuid,uuid,text[]) to authenticated;

-- Apply RLS and a safe baseline grant for tenant tables.
do $$
declare t text;
begin
  foreach t in array array[
    'tenant_subscriptions','feature_entitlements','customer_consents','tax_configurations','calculator_quotes',
    'scheme_installments','scheme_benefits','scheme_redemptions','payment_orders','payments','payment_webhook_events',
    'refunds','receipts','financial_adjustments','reconciliation_records','product_categories','suppliers','products',
    'inventory_items','inventory_movements','sales','sale_items','invoices','invoice_lines','stock_transfers','stock_transfer_items',
    'old_gold_valuations','customer_orders','repair_jobs','notification_templates','notifications','notification_delivery_events',
    'system_integrations','support_tickets','staff_invitations','platform_admins','platform_settings','feature_flags'
  ] loop
    execute format('alter table public.%I enable row level security',t);
  end loop;
end $$;

-- Operational configuration and tenant-scoped select policies.
create policy "subscriptions_owner_read" on public.tenant_subscriptions for select to authenticated using (public.has_tenant_role(tenant_id,array['owner','manager']));
create policy "entitlements_members_read" on public.feature_entitlements for select to authenticated using (public.is_tenant_member(tenant_id));
create policy "entitlements_owner_manage" on public.feature_entitlements for all to authenticated using (public.has_tenant_role(tenant_id,array['owner'])) with check (public.has_tenant_role(tenant_id,array['owner']));
create policy "consents_staff_or_customer_read" on public.customer_consents for select to authenticated using (public.is_tenant_member(tenant_id) or public.is_linked_customer(tenant_id,customer_id));
create policy "consents_staff_insert" on public.customer_consents for insert to authenticated with check (public.has_tenant_role(tenant_id,array['owner','manager','cashier','scheme_manager','employee']));
create policy "tax_config_members_read" on public.tax_configurations for select to authenticated using (public.is_tenant_member(tenant_id));
create policy "tax_config_owner_manage" on public.tax_configurations for all to authenticated using (public.has_tenant_role(tenant_id,array['owner'])) with check (public.has_tenant_role(tenant_id,array['owner']));
create policy "quotes_staff_read" on public.calculator_quotes for select to authenticated using (public.has_tenant_branch_access(tenant_id,branch_id,null));
create policy "quotes_staff_insert" on public.calculator_quotes for insert to authenticated with check (public.has_tenant_branch_access(tenant_id,branch_id,array['owner','manager','cashier','employee']));

create policy "installments_staff_customer_read" on public.scheme_installments for select to authenticated using (
 public.is_tenant_member(tenant_id) or exists(select 1 from public.scheme_enrolments e where e.tenant_id=scheme_installments.tenant_id and e.id=scheme_installments.enrolment_id and public.is_linked_customer(e.tenant_id,e.customer_id))
);
create policy "installments_managers_insert" on public.scheme_installments for insert to authenticated with check (public.has_tenant_role(tenant_id,array['owner','manager','scheme_manager']));
create policy "installments_managers_update" on public.scheme_installments for update to authenticated using (public.has_tenant_role(tenant_id,array['owner','manager','scheme_manager'])) with check (public.has_tenant_role(tenant_id,array['owner','manager','scheme_manager']));
create policy "benefits_staff_customer_read" on public.scheme_benefits for select to authenticated using (
 public.is_tenant_member(tenant_id) or exists(select 1 from public.scheme_enrolments e where e.tenant_id=scheme_benefits.tenant_id and e.id=scheme_benefits.enrolment_id and public.is_linked_customer(e.tenant_id,e.customer_id))
);
create policy "benefits_managers_insert" on public.scheme_benefits for insert to authenticated with check (public.has_tenant_role(tenant_id,array['owner','manager','scheme_manager']));
create policy "benefits_owner_update" on public.scheme_benefits for update to authenticated using (public.has_tenant_role(tenant_id,array['owner'])) with check (public.has_tenant_role(tenant_id,array['owner']));
create policy "redemptions_staff_customer_read" on public.scheme_redemptions for select to authenticated using (
 public.is_tenant_member(tenant_id) or exists(select 1 from public.scheme_enrolments e where e.tenant_id=scheme_redemptions.tenant_id and e.id=scheme_redemptions.enrolment_id and public.is_linked_customer(e.tenant_id,e.customer_id))
);
create policy "redemptions_staff_insert" on public.scheme_redemptions for insert to authenticated with check (public.has_tenant_role(tenant_id,array['owner','manager','scheme_manager','cashier']));
create policy "redemptions_owner_update" on public.scheme_redemptions for update to authenticated using (public.has_tenant_role(tenant_id,array['owner','manager'])) with check (public.has_tenant_role(tenant_id,array['owner','manager']));

-- Payment and ledger read access. Browser clients cannot insert or alter gateway-verified payments directly.
create policy "payment_orders_staff_or_customer_read" on public.payment_orders for select to authenticated using (
 public.is_tenant_member(tenant_id) or (customer_id is not null and public.is_linked_customer(tenant_id,customer_id))
);
create policy "payments_staff_or_customer_read" on public.payments for select to authenticated using (
 public.is_tenant_member(tenant_id) or (customer_id is not null and public.is_linked_customer(tenant_id,customer_id))
);
create policy "refunds_staff_read" on public.refunds for select to authenticated using (public.is_tenant_member(tenant_id));
create policy "receipts_staff_or_customer_read" on public.receipts for select to authenticated using (
 public.is_tenant_member(tenant_id) or (enrolment_id is not null and exists(select 1 from public.scheme_enrolments e where e.tenant_id=receipts.tenant_id and e.id=receipts.enrolment_id and public.is_linked_customer(e.tenant_id,e.customer_id)))
);
create policy "financial_adjustments_owner_read" on public.financial_adjustments for select to authenticated using (public.has_tenant_role(tenant_id,array['owner','manager','accountant']));
create policy "reconciliation_owner_read" on public.reconciliation_records for select to authenticated using (public.has_tenant_role(tenant_id,array['owner','manager','accountant']));
create policy "reconciliation_owner_manage" on public.reconciliation_records for all to authenticated using (public.has_tenant_role(tenant_id,array['owner','manager','accountant'])) with check (public.has_tenant_role(tenant_id,array['owner','manager','accountant']));

-- Product master data and inventory workflows.
create policy "categories_members_read" on public.product_categories for select to authenticated using (public.is_tenant_member(tenant_id));
create policy "categories_managers_manage" on public.product_categories for all to authenticated using (public.has_tenant_role(tenant_id,array['owner','manager','inventory_manager'])) with check (public.has_tenant_role(tenant_id,array['owner','manager','inventory_manager']));
create policy "suppliers_inventory_read" on public.suppliers for select to authenticated using (public.has_tenant_role(tenant_id,array['owner','manager','accountant','inventory_manager']));
create policy "suppliers_inventory_manage" on public.suppliers for all to authenticated using (public.has_tenant_role(tenant_id,array['owner','manager','inventory_manager'])) with check (public.has_tenant_role(tenant_id,array['owner','manager','inventory_manager']));
create policy "products_members_read" on public.products for select to authenticated using (public.is_tenant_member(tenant_id));
create policy "products_inventory_manage" on public.products for all to authenticated using (public.has_tenant_role(tenant_id,array['owner','manager','inventory_manager'])) with check (public.has_tenant_role(tenant_id,array['owner','manager','inventory_manager']));
create policy "inventory_branch_read" on public.inventory_items for select to authenticated using (public.has_tenant_branch_access(tenant_id,branch_id,null));
create policy "inventory_branch_manage" on public.inventory_items for all to authenticated using (public.has_tenant_branch_access(tenant_id,branch_id,array['owner','manager','inventory_manager'])) with check (public.has_tenant_branch_access(tenant_id,branch_id,array['owner','manager','inventory_manager']));
create policy "movement_branch_read" on public.inventory_movements for select to authenticated using (public.has_tenant_branch_access(tenant_id,branch_id,null));
create policy "movement_inventory_insert" on public.inventory_movements for insert to authenticated with check (public.has_tenant_branch_access(tenant_id,branch_id,array['owner','manager','inventory_manager']));
create policy "sales_branch_read" on public.sales for select to authenticated using (public.has_tenant_branch_access(tenant_id,branch_id,null));
create policy "sales_staff_insert" on public.sales for insert to authenticated with check (public.has_tenant_branch_access(tenant_id,branch_id,array['owner','manager','cashier']));
create policy "sales_managers_update" on public.sales for update to authenticated using (public.has_tenant_branch_access(tenant_id,branch_id,array['owner','manager','cashier'])) with check (public.has_tenant_branch_access(tenant_id,branch_id,array['owner','manager','cashier']));
create policy "sale_items_read" on public.sale_items for select to authenticated using (public.is_tenant_member(tenant_id));
create policy "sale_items_staff_insert" on public.sale_items for insert to authenticated with check (public.has_tenant_role(tenant_id,array['owner','manager','cashier']));
create policy "invoices_staff_read" on public.invoices for select to authenticated using (public.has_tenant_branch_access(tenant_id,branch_id,null));
create policy "invoices_staff_insert" on public.invoices for insert to authenticated with check (public.has_tenant_branch_access(tenant_id,branch_id,array['owner','manager','cashier','accountant']));
create policy "invoices_managers_update" on public.invoices for update to authenticated using (public.has_tenant_role(tenant_id,array['owner','manager','accountant'])) with check (public.has_tenant_role(tenant_id,array['owner','manager','accountant']));
create policy "invoice_lines_staff_read" on public.invoice_lines for select to authenticated using (public.is_tenant_member(tenant_id));
create policy "invoice_lines_staff_insert" on public.invoice_lines for insert to authenticated with check (public.has_tenant_role(tenant_id,array['owner','manager','cashier','accountant']));
create policy "transfers_managers_read" on public.stock_transfers for select to authenticated using (public.has_tenant_branch_access(tenant_id,from_branch_id,null) or public.has_tenant_branch_access(tenant_id,to_branch_id,null));
create policy "transfers_managers_manage" on public.stock_transfers for all to authenticated using (public.has_tenant_role(tenant_id,array['owner','manager','inventory_manager'])) with check (public.has_tenant_role(tenant_id,array['owner','manager','inventory_manager']));
create policy "transfer_items_read" on public.stock_transfer_items for select to authenticated using (public.is_tenant_member(tenant_id));
create policy "transfer_items_manage" on public.stock_transfer_items for all to authenticated using (public.has_tenant_role(tenant_id,array['owner','manager','inventory_manager'])) with check (public.has_tenant_role(tenant_id,array['owner','manager','inventory_manager']));
create policy "old_gold_staff_read" on public.old_gold_valuations for select to authenticated using (public.has_tenant_branch_access(tenant_id,branch_id,null));
create policy "old_gold_staff_insert" on public.old_gold_valuations for insert to authenticated with check (public.has_tenant_branch_access(tenant_id,branch_id,array['owner','manager','cashier','employee']));
create policy "old_gold_owner_update" on public.old_gold_valuations for update to authenticated using (public.has_tenant_role(tenant_id,array['owner','manager'])) with check (public.has_tenant_role(tenant_id,array['owner','manager']));
create policy "orders_branch_read" on public.customer_orders for select to authenticated using (public.has_tenant_branch_access(tenant_id,branch_id,null));
create policy "orders_staff_manage" on public.customer_orders for all to authenticated using (public.has_tenant_branch_access(tenant_id,branch_id,array['owner','manager','cashier','employee'])) with check (public.has_tenant_branch_access(tenant_id,branch_id,array['owner','manager','cashier','employee']));
create policy "repairs_branch_read" on public.repair_jobs for select to authenticated using (public.has_tenant_branch_access(tenant_id,branch_id,null));
create policy "repairs_staff_manage" on public.repair_jobs for all to authenticated using (public.has_tenant_branch_access(tenant_id,branch_id,array['owner','manager','employee'])) with check (public.has_tenant_branch_access(tenant_id,branch_id,array['owner','manager','employee']));

-- Communications status is readable by authorised staff; provider webhooks are service-side only.
create policy "templates_owner_manage" on public.notification_templates for all to authenticated using (tenant_id is not null and public.has_tenant_role(tenant_id,array['owner','manager'])) with check (tenant_id is not null and public.has_tenant_role(tenant_id,array['owner','manager']));
create policy "notifications_staff_or_customer_read" on public.notifications for select to authenticated using (public.is_tenant_member(tenant_id) or recipient_user_id = auth.uid() or (customer_id is not null and public.is_linked_customer(tenant_id,customer_id)));
create policy "notifications_staff_enqueue" on public.notifications for insert to authenticated with check (public.has_tenant_role(tenant_id,array['owner','manager','scheme_manager','cashier']));
create policy "delivery_events_read" on public.notification_delivery_events for select to authenticated using (exists(select 1 from public.notifications n where n.id=notification_id and public.is_tenant_member(n.tenant_id)));
create policy "integrations_owner_read" on public.system_integrations for select to authenticated using (tenant_id is not null and public.has_tenant_role(tenant_id,array['owner','manager']));
create policy "integrations_owner_manage" on public.system_integrations for all to authenticated using (tenant_id is not null and public.has_tenant_role(tenant_id,array['owner'])) with check (tenant_id is not null and public.has_tenant_role(tenant_id,array['owner']));
create policy "support_request_read" on public.support_tickets for select to authenticated using (created_by = auth.uid() or (tenant_id is not null and public.has_tenant_role(tenant_id,array['owner','manager'])));
create policy "support_request_create" on public.support_tickets for insert to authenticated with check (created_by = auth.uid());
create policy "staff_invitation_read" on public.staff_invitations for select to authenticated using (public.has_tenant_role(tenant_id,array['owner','manager']));
create policy "staff_invitation_manage" on public.staff_invitations for all to authenticated using (public.has_tenant_role(tenant_id,array['owner','manager'])) with check (public.has_tenant_role(tenant_id,array['owner','manager']));

-- Platform-only administrative tables intentionally have no client-facing policies.
revoke all on public.platform_admins, public.platform_settings, public.feature_flags, public.payment_webhook_events, public.notification_delivery_events from anon,authenticated;
grant select,insert,update,delete on public.tenant_subscriptions,public.feature_entitlements,public.customer_consents,public.tax_configurations,
 public.calculator_quotes,public.scheme_installments,public.scheme_benefits,public.scheme_redemptions,
 public.payment_orders,public.refunds,public.receipts,public.financial_adjustments,public.reconciliation_records,
 public.product_categories,public.suppliers,public.products,public.inventory_items,public.inventory_movements,
 public.sales,public.sale_items,public.invoices,public.invoice_lines,public.stock_transfers,public.stock_transfer_items,
 public.old_gold_valuations,public.customer_orders,public.repair_jobs,public.notification_templates,public.notifications,
 public.system_integrations,public.support_tickets,public.staff_invitations to authenticated;
grant select on public.payments to authenticated;

-- Payments can only be recorded via this authenticated, role-checked RPC. It is for staff-collected methods,
-- not a substitute for provider signature verification on card/UPI gateways.
create or replace function public.record_manual_payment(
 p_tenant_id uuid,p_branch_id uuid,p_customer_id uuid,p_enrolment_id uuid,
 p_amount numeric,p_method text,p_reference text,p_idempotency_key text,p_notes text default null
)
returns uuid
language plpgsql security definer set search_path = public, pg_temp
as $$
declare v_user uuid := auth.uid(); v_payment_id uuid;
begin
 if v_user is null then raise exception 'Authentication required' using errcode='42501'; end if;
 if not public.has_tenant_branch_access(p_tenant_id,p_branch_id,array['owner','manager','accountant','cashier']) then
   raise exception 'Permission denied' using errcode='42501';
 end if;
 if p_amount is null or p_amount <= 0 then raise exception 'Payment amount must be positive'; end if;
 if p_method not in ('cash','upi','bank_transfer','cheque','other') then raise exception 'Only staff-collected methods are allowed through this RPC'; end if;
 if nullif(trim(p_idempotency_key),'') is null then raise exception 'Idempotency key is required'; end if;
 select id into v_payment_id from public.payments where tenant_id=p_tenant_id and idempotency_key=p_idempotency_key;
 if v_payment_id is not null then return v_payment_id; end if;
 if p_enrolment_id is not null and not exists(select 1 from public.scheme_enrolments e where e.tenant_id=p_tenant_id and e.id=p_enrolment_id and e.status in ('active','pending')) then
  raise exception 'Scheme enrolment not found or inactive';
 end if;
 insert into public.payments(tenant_id,branch_id,customer_id,enrolment_id,payment_method,status,amount,reference,idempotency_key,confirmation_source,confirmed_by,confirmed_at,metadata)
 values(p_tenant_id,p_branch_id,p_customer_id,p_enrolment_id,p_method,'confirmed',p_amount,nullif(trim(p_reference),''),p_idempotency_key,'staff',v_user,now(),jsonb_build_object('notes',p_notes))
 returning id into v_payment_id;
 if p_enrolment_id is not null then
   insert into public.scheme_transactions(tenant_id,branch_id,enrolment_id,transaction_type,status,amount,reference,idempotency_key,notes,actor_user_id,confirmed_at)
   values(p_tenant_id,p_branch_id,p_enrolment_id,'contribution','confirmed',p_amount,coalesce(nullif(trim(p_reference),''),v_payment_id::text),'payment:'||p_idempotency_key,p_notes,v_user,now());
 end if;
 insert into public.audit_logs(tenant_id,actor_user_id,event_name,entity_type,entity_id,details)
 values(p_tenant_id,v_user,'payment.manual_confirmed','payment',v_payment_id::text,jsonb_build_object('amount',p_amount,'method',p_method,'enrolment_id',p_enrolment_id));
 return v_payment_id;
end;
$$;
revoke all on function public.record_manual_payment(uuid,uuid,uuid,uuid,numeric,text,text,text,text) from public,anon;
grant execute on function public.record_manual_payment(uuid,uuid,uuid,uuid,numeric,text,text,text,text) to authenticated;

-- Strengthen core ledger boundaries: client inserts cannot directly forge confirmed scheme transactions.
drop policy if exists scheme_transactions_staff_insert on public.scheme_transactions;
revoke insert,update,delete on public.scheme_transactions from public,anon,authenticated;
grant select on public.scheme_transactions to authenticated;

-- Enrolments are created with accepted terms snapshots; initial insert remains role-gated.
create policy "scheme_enrolments_staff_insert_v2" on public.scheme_enrolments for insert to authenticated
with check (public.has_tenant_role(tenant_id,array['owner','manager','scheme_manager','cashier','employee']));

-- Indices for common report and lookup paths.
create index if not exists audit_logs_tenant_created_idx on public.audit_logs(tenant_id,created_at desc);
create index if not exists payments_customer_created_idx on public.payments(tenant_id,customer_id,created_at desc);
create index if not exists notifications_tenant_created_idx on public.notifications(tenant_id,created_at desc);
create index if not exists sales_tenant_created_idx on public.sales(tenant_id,created_at desc);
create index if not exists invoices_tenant_status_idx on public.invoices(tenant_id,status,invoice_date desc);
create index if not exists old_gold_tenant_created_idx on public.old_gold_valuations(tenant_id,created_at desc);

commit;
