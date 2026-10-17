-- Gold multi-tenant foundation. Apply to the dedicated Gold Supabase project.
-- Review and test tenant policies using separate accounts before production use.
begin;
create extension if not exists pgcrypto;

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  display_name text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.tenants (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  slug text not null unique,
  legal_name text,
  display_name text not null,
  status text not null default 'trial' check (status in ('trial','active','suspended','cancelled')),
  country_code text not null default 'IN',
  state text, district text, city text, locality text, pincode text,
  timezone text not null default 'Asia/Kolkata',
  default_currency text not null default 'INR' check (default_currency = 'INR'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.branches (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  branch_code text not null, name text not null, address text,
  state text, district text, city text, locality text, pincode text,
  timezone text not null default 'Asia/Kolkata',
  is_default boolean not null default false, is_active boolean not null default true,
  created_at timestamptz not null default now(),
  unique (tenant_id, branch_code), unique (tenant_id, id)
);
create unique index if not exists branches_one_default_per_tenant on public.branches(tenant_id) where is_default;

create table if not exists public.tenant_memberships (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  branch_id uuid,
  role text not null check (role in ('owner','manager','accountant','cashier','scheme_manager','inventory_manager','employee')),
  permissions jsonb not null default '{}'::jsonb,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, user_id),
  foreign key (tenant_id, branch_id) references public.branches(tenant_id, id)
);
create index if not exists tenant_memberships_user_active_idx on public.tenant_memberships(user_id, is_active);
create index if not exists tenant_memberships_tenant_role_idx on public.tenant_memberships(tenant_id, role);

create table if not exists public.tenant_settings (
  tenant_id uuid primary key references public.tenants(id) on delete cascade,
  preferred_language text not null default 'en',
  tax_configuration jsonb not null default '{"gst_percent":3}'::jsonb,
  rate_configuration jsonb not null default '{}'::jsonb,
  receipt_branding jsonb not null default '{}'::jsonb,
  onboarding_completed_at timestamptz,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);

create table if not exists public.tenant_customers (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  branch_id uuid,
  customer_code text not null,
  full_name text not null,
  mobile_e164 text not null,
  email text, address text, state text, district text, city text, pincode text,
  preferred_language text not null default 'en',
  communication_consent jsonb not null default '{}'::jsonb,
  status text not null default 'active' check (status in ('active','inactive','blocked')),
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  unique (tenant_id, customer_code), unique (tenant_id, id),
  foreign key (tenant_id, branch_id) references public.branches(tenant_id, id)
);
create index if not exists tenant_customers_search_idx on public.tenant_customers(tenant_id, mobile_e164);
create index if not exists tenant_customers_name_idx on public.tenant_customers(tenant_id, lower(full_name));

create table if not exists public.customer_auth_links (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  customer_id uuid not null,
  auth_user_id uuid not null references auth.users(id) on delete cascade,
  verified_at timestamptz, created_at timestamptz not null default now(),
  unique (tenant_id, customer_id), unique (tenant_id, auth_user_id),
  foreign key (tenant_id, customer_id) references public.tenant_customers(tenant_id, id) on delete cascade
);

create table if not exists public.metals (
  id smallserial primary key, code text not null unique, name text not null, is_active boolean not null default true
);
create table if not exists public.purity_definitions (
  id smallserial primary key, metal_id smallint not null references public.metals(id),
  code text not null, label text not null,
  fineness integer not null check (fineness between 1 and 1000),
  is_active boolean not null default true,
  unique (metal_id, code), unique (metal_id, id)
);

create table if not exists public.rate_sources (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  name text not null, source_type text not null check (source_type in ('manual','provider','import')),
  provider_name text, is_active boolean not null default true, created_at timestamptz not null default now(),
  unique (tenant_id, id)
);

-- Rate rows are historical snapshots; newer rates do not overwrite old quotations.
create table if not exists public.gold_rates (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  branch_id uuid, metal_id smallint not null references public.metals(id), purity_id smallint not null,
  state text, district text, city text, locality text,
  price_per_gram numeric(14,2) not null check (price_per_gram >= 0),
  currency text not null default 'INR' check (currency = 'INR'),
  source_type text not null check (source_type in ('manual','provider','import','demo')),
  rate_source_id uuid, source_label text,
  status text not null default 'verified' check (status in ('verified','indicative','stale','failed','demo')),
  effective_at timestamptz not null default now(), expires_at timestamptz,
  updated_by uuid references auth.users(id) on delete set null, created_at timestamptz not null default now(),
  foreign key (metal_id, purity_id) references public.purity_definitions(metal_id, id),
  foreign key (tenant_id, branch_id) references public.branches(tenant_id, id),
  foreign key (tenant_id, rate_source_id) references public.rate_sources(tenant_id, id)
);
create index if not exists gold_rates_latest_idx on public.gold_rates(tenant_id, branch_id, metal_id, purity_id, effective_at desc);
create index if not exists gold_rates_location_idx on public.gold_rates(tenant_id, state, city, locality, effective_at desc);

create table if not exists public.scheme_templates (
  id uuid primary key default gen_random_uuid(), tenant_id uuid not null references public.tenants(id) on delete cascade,
  branch_id uuid, name text not null, description text,
  scheme_type text not null check (scheme_type in ('flexible_gold_weight','fixed_monthly','custom')),
  status text not null default 'draft' check (status in ('draft','published','paused','retired')),
  current_version integer not null default 1, created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  unique (tenant_id, id), foreign key (tenant_id, branch_id) references public.branches(tenant_id, id)
);
create table if not exists public.scheme_versions (
  id uuid primary key default gen_random_uuid(), tenant_id uuid not null references public.tenants(id) on delete cascade,
  scheme_id uuid not null, version_no integer not null check (version_no > 0),
  terms jsonb not null, terms_markdown text, reviewed_by uuid references auth.users(id) on delete set null,
  reviewed_at timestamptz, effective_from timestamptz, created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(), unique (scheme_id, version_no), unique (tenant_id, id),
  foreign key (tenant_id, scheme_id) references public.scheme_templates(tenant_id, id) on delete cascade
);

create table if not exists public.scheme_enrolments (
  id uuid primary key default gen_random_uuid(), tenant_id uuid not null references public.tenants(id) on delete cascade,
  branch_id uuid, customer_id uuid not null, scheme_version_id uuid not null, enrolment_code text not null,
  status text not null default 'pending' check (status in ('pending','active','completed','matured','redeemed','cancelled','disputed')),
  start_date date not null default current_date, maturity_date date, agreed_terms jsonb not null,
  terms_accepted_at timestamptz, created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(), unique (tenant_id, enrolment_code), unique (tenant_id, id),
  foreign key (tenant_id, branch_id) references public.branches(tenant_id, id),
  foreign key (tenant_id, customer_id) references public.tenant_customers(tenant_id, id),
  foreign key (tenant_id, scheme_version_id) references public.scheme_versions(tenant_id, id)
);
create index if not exists scheme_enrolments_customer_idx on public.scheme_enrolments(tenant_id, customer_id, status);
create index if not exists scheme_enrolments_maturity_idx on public.scheme_enrolments(tenant_id, maturity_date) where maturity_date is not null;

create table if not exists public.scheme_transactions (
  id uuid primary key default gen_random_uuid(), tenant_id uuid not null references public.tenants(id) on delete cascade,
  branch_id uuid, enrolment_id uuid not null,
  transaction_type text not null check (transaction_type in ('contribution','benefit','refund','reversal','adjustment','redemption')),
  status text not null default 'pending' check (status in ('pending','confirmed','failed','reversed')),
  amount numeric(14,2) not null check (amount >= 0), currency text not null default 'INR' check (currency = 'INR'),
  gold_rate_snapshot numeric(14,2), weight_grams_snapshot numeric(14,6), reference text, idempotency_key text, notes text,
  actor_user_id uuid references auth.users(id) on delete set null, confirmed_at timestamptz, created_at timestamptz not null default now(),
  foreign key (tenant_id, branch_id) references public.branches(tenant_id, id),
  foreign key (tenant_id, enrolment_id) references public.scheme_enrolments(tenant_id, id),
  unique (tenant_id, idempotency_key)
);
create index if not exists scheme_transactions_enrolment_date_idx on public.scheme_transactions(tenant_id, enrolment_id, created_at desc);
create index if not exists scheme_transactions_status_idx on public.scheme_transactions(tenant_id, status, created_at desc);

create table if not exists public.audit_logs (
  id bigint generated always as identity primary key, tenant_id uuid references public.tenants(id) on delete set null,
  actor_user_id uuid references auth.users(id) on delete set null,
  event_name text not null, entity_type text, entity_id text,
  details jsonb not null default '{}'::jsonb, created_at timestamptz not null default now()
);

-- Security-definer helpers read membership/link data without recursive RLS evaluation.
create or replace function public.is_tenant_member(p_tenant_id uuid)
returns boolean language sql stable security definer set search_path = public, pg_temp as $$
  select exists (select 1 from public.tenant_memberships m where m.tenant_id = p_tenant_id and m.user_id = auth.uid() and m.is_active = true);
$$;
create or replace function public.has_tenant_role(p_tenant_id uuid, p_roles text[])
returns boolean language sql stable security definer set search_path = public, pg_temp as $$
  select exists (select 1 from public.tenant_memberships m where m.tenant_id = p_tenant_id and m.user_id = auth.uid() and m.is_active = true and m.role = any (p_roles));
$$;
create or replace function public.is_linked_customer(p_tenant_id uuid, p_customer_id uuid)
returns boolean language sql stable security definer set search_path = public, pg_temp as $$
  select exists (select 1 from public.customer_auth_links l where l.tenant_id = p_tenant_id and l.customer_id = p_customer_id and l.auth_user_id = auth.uid() and l.verified_at is not null);
$$;
grant execute on function public.is_tenant_member(uuid) to authenticated;
grant execute on function public.has_tenant_role(uuid, text[]) to authenticated;
grant execute on function public.is_linked_customer(uuid, uuid) to authenticated;

-- Creates the tenant and its owner scope atomically. Browser input never assigns its own role.
create or replace function public.create_tenant_onboarding(
  p_display_name text, p_slug text, p_state text default 'Tamil Nadu',
  p_city text default null, p_district text default null, p_locality text default null
) returns uuid language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_user_id uuid := auth.uid();
  v_tenant_id uuid;
  v_branch_id uuid;
  v_slug text := lower(trim(p_slug));
begin
  if v_user_id is null then raise exception 'Authentication required' using errcode = '42501'; end if;
  if length(trim(coalesce(p_display_name, ''))) < 2 then raise exception 'Shop display name must contain at least 2 characters'; end if;
  if v_slug !~ '^[a-z0-9]+(-[a-z0-9]+)*$' or length(v_slug) > 60 then raise exception 'Shop slug format is invalid'; end if;
  insert into public.tenants(code, slug, display_name, state, city, district, locality)
    values (upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 8)), v_slug, trim(p_display_name), nullif(trim(p_state), ''), nullif(trim(p_city), ''), nullif(trim(p_district), ''), nullif(trim(p_locality), ''))
    returning id into v_tenant_id;
  insert into public.branches(tenant_id, branch_code, name, state, district, city, locality, is_default)
    values (v_tenant_id, 'MAIN', 'Main Branch', nullif(trim(p_state), ''), nullif(trim(p_district), ''), nullif(trim(p_city), ''), nullif(trim(p_locality), ''), true)
    returning id into v_branch_id;
  insert into public.tenant_memberships(tenant_id, user_id, branch_id, role) values (v_tenant_id, v_user_id, v_branch_id, 'owner');
  insert into public.tenant_settings(tenant_id) values (v_tenant_id);
  insert into public.audit_logs(tenant_id, actor_user_id, event_name, entity_type, entity_id, details)
    values (v_tenant_id, v_user_id, 'tenant.created', 'tenant', v_tenant_id::text, jsonb_build_object('source','owner_onboarding'));
  return v_tenant_id;
end;
$$;
revoke all on function public.create_tenant_onboarding(text,text,text,text,text,text) from public;
grant execute on function public.create_tenant_onboarding(text,text,text,text,text,text) to authenticated;

create or replace function public.handle_new_auth_user()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
begin
  insert into public.profiles(id, display_name) values (new.id, coalesce(new.raw_user_meta_data ->> 'full_name', new.phone, new.email))
  on conflict (id) do nothing;
  return new;
end;
$$;
drop trigger if exists on_auth_user_created_gold on auth.users;
create trigger on_auth_user_created_gold after insert on auth.users for each row execute procedure public.handle_new_auth_user();

alter table public.profiles enable row level security;
alter table public.tenants enable row level security;
alter table public.branches enable row level security;
alter table public.tenant_memberships enable row level security;
alter table public.tenant_settings enable row level security;
alter table public.tenant_customers enable row level security;
alter table public.customer_auth_links enable row level security;
alter table public.metals enable row level security;
alter table public.purity_definitions enable row level security;
alter table public.rate_sources enable row level security;
alter table public.gold_rates enable row level security;
alter table public.scheme_templates enable row level security;
alter table public.scheme_versions enable row level security;
alter table public.scheme_enrolments enable row level security;
alter table public.scheme_transactions enable row level security;
alter table public.audit_logs enable row level security;

create policy "profiles_read_self" on public.profiles for select to authenticated using (id = auth.uid());
create policy "profiles_update_self" on public.profiles for update to authenticated using (id = auth.uid()) with check (id = auth.uid());

create policy "tenants_read_members" on public.tenants for select to authenticated using (public.is_tenant_member(id));
create policy "tenants_update_managers" on public.tenants for update to authenticated using (public.has_tenant_role(id, array['owner','manager'])) with check (public.has_tenant_role(id, array['owner','manager']));

create policy "branches_read_members" on public.branches for select to authenticated using (public.is_tenant_member(tenant_id));
create policy "branches_insert_managers" on public.branches for insert to authenticated with check (public.has_tenant_role(tenant_id, array['owner','manager']));
create policy "branches_update_managers" on public.branches for update to authenticated using (public.has_tenant_role(tenant_id, array['owner','manager'])) with check (public.has_tenant_role(tenant_id, array['owner','manager']));

create policy "memberships_read_self_or_managers" on public.tenant_memberships for select to authenticated using (user_id = auth.uid() or public.has_tenant_role(tenant_id, array['owner','manager']));
create policy "memberships_insert_managers" on public.tenant_memberships for insert to authenticated with check (public.has_tenant_role(tenant_id, array['owner','manager']) and role <> 'owner');
create policy "memberships_update_managers" on public.tenant_memberships for update to authenticated using (public.has_tenant_role(tenant_id, array['owner','manager']) and role <> 'owner') with check (public.has_tenant_role(tenant_id, array['owner','manager']) and role <> 'owner');

create policy "settings_read_members" on public.tenant_settings for select to authenticated using (public.is_tenant_member(tenant_id));
create policy "settings_update_managers" on public.tenant_settings for update to authenticated using (public.has_tenant_role(tenant_id, array['owner','manager'])) with check (public.has_tenant_role(tenant_id, array['owner','manager']));

create policy "customers_staff_or_self_read" on public.tenant_customers for select to authenticated using (public.is_tenant_member(tenant_id) or public.is_linked_customer(tenant_id, id));
create policy "customers_staff_insert" on public.tenant_customers for insert to authenticated with check (public.has_tenant_role(tenant_id, array['owner','manager','accountant','cashier','scheme_manager','employee']));
create policy "customers_staff_update" on public.tenant_customers for update to authenticated using (public.has_tenant_role(tenant_id, array['owner','manager','accountant','cashier','scheme_manager','employee'])) with check (public.has_tenant_role(tenant_id, array['owner','manager','accountant','cashier','scheme_manager','employee']));
create policy "customer_links_read_self_or_staff" on public.customer_auth_links for select to authenticated using (auth_user_id = auth.uid() or public.is_tenant_member(tenant_id));
-- Client-side users cannot self-assert customer identity verification. Link writes require a trusted, verified server-side workflow.

create policy "metals_read_all" on public.metals for select to anon, authenticated using (true);
create policy "purities_read_all" on public.purity_definitions for select to anon, authenticated using (true);

create policy "rate_sources_read_members" on public.rate_sources for select to authenticated using (public.is_tenant_member(tenant_id));
create policy "rate_sources_manage_managers" on public.rate_sources for all to authenticated using (public.has_tenant_role(tenant_id, array['owner','manager'])) with check (public.has_tenant_role(tenant_id, array['owner','manager']));
create policy "rates_read_members" on public.gold_rates for select to authenticated using (public.is_tenant_member(tenant_id));
create policy "rates_insert_managers" on public.gold_rates for insert to authenticated with check (public.has_tenant_role(tenant_id, array['owner','manager']));
create policy "rates_update_managers" on public.gold_rates for update to authenticated using (public.has_tenant_role(tenant_id, array['owner','manager'])) with check (public.has_tenant_role(tenant_id, array['owner','manager']));

create policy "schemes_read_members" on public.scheme_templates for select to authenticated using (public.is_tenant_member(tenant_id));
create policy "schemes_insert_managers" on public.scheme_templates for insert to authenticated with check (public.has_tenant_role(tenant_id, array['owner','manager','scheme_manager']));
create policy "schemes_update_managers" on public.scheme_templates for update to authenticated using (public.has_tenant_role(tenant_id, array['owner','manager','scheme_manager'])) with check (public.has_tenant_role(tenant_id, array['owner','manager','scheme_manager']));
create policy "scheme_versions_read_members" on public.scheme_versions for select to authenticated using (public.is_tenant_member(tenant_id));
create policy "scheme_versions_insert_managers" on public.scheme_versions for insert to authenticated with check (public.has_tenant_role(tenant_id, array['owner','manager','scheme_manager']));

create policy "enrolments_staff_or_customer_read" on public.scheme_enrolments for select to authenticated using (public.is_tenant_member(tenant_id) or public.is_linked_customer(tenant_id, customer_id));
create policy "enrolments_insert_staff" on public.scheme_enrolments for insert to authenticated with check (public.has_tenant_role(tenant_id, array['owner','manager','scheme_manager','cashier','employee']));
create policy "enrolments_update_managers" on public.scheme_enrolments for update to authenticated using (public.has_tenant_role(tenant_id, array['owner','manager','scheme_manager'])) with check (public.has_tenant_role(tenant_id, array['owner','manager','scheme_manager']));

create policy "scheme_transactions_staff_or_customer_read" on public.scheme_transactions for select to authenticated using (
  public.is_tenant_member(tenant_id) or exists (
    select 1 from public.scheme_enrolments e where e.tenant_id = scheme_transactions.tenant_id
      and e.id = scheme_transactions.enrolment_id and public.is_linked_customer(e.tenant_id, e.customer_id)
  )
);
create policy "scheme_transactions_staff_insert" on public.scheme_transactions for insert to authenticated with check (public.has_tenant_role(tenant_id, array['owner','manager','accountant','cashier','scheme_manager']));
-- Deliberately no authenticated UPDATE or DELETE policy on scheme_transactions (append-only ledger).
create policy "audit_logs_read_managers" on public.audit_logs for select to authenticated using (tenant_id is not null and public.has_tenant_role(tenant_id, array['owner','manager']));

-- Tenant owners cannot alter platform-managed lifecycle status or internal codes through the public API.
revoke update on public.tenants from authenticated;
grant update (display_name, legal_name, state, district, city, locality, pincode, timezone) on public.tenants to authenticated;

insert into public.metals(code, name) values ('gold','Gold'), ('silver','Silver'), ('platinum','Platinum') on conflict (code) do nothing;
insert into public.purity_definitions(metal_id, code, label, fineness)
select m.id, p.code, p.label, p.fineness
from public.metals m cross join (values ('24K','24K · 999',999), ('22K','22K · 916',916), ('18K','18K · 750',750)) as p(code,label,fineness)
where m.code = 'gold' on conflict (metal_id, code) do nothing;
commit;
