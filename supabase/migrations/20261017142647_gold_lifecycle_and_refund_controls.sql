begin;

-- Extra CRM history. Notes/interactions are append-only and never exposed to customer accounts.
create table if not exists public.customer_notes (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  branch_id uuid references public.branches(id) on delete set null,
  customer_id uuid not null,
  note text not null check (length(trim(note)) between 1 and 5000),
  note_type text not null default 'general' check (note_type in ('general','service','scheme','complaint','kyc_review')),
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  foreign key (tenant_id, customer_id) references public.tenant_customers(tenant_id, id) on delete cascade
);
create index if not exists customer_notes_customer_history_idx on public.customer_notes(tenant_id, customer_id, created_at desc);
alter table public.customer_notes enable row level security;
drop policy if exists customer_notes_staff_read on public.customer_notes;
create policy customer_notes_staff_read on public.customer_notes for select to authenticated
  using (private.has_tenant_branch_access(tenant_id, branch_id, array['owner','manager','accountant','cashier','scheme_manager','employee']));
drop policy if exists customer_notes_staff_insert on public.customer_notes;
create policy customer_notes_staff_insert on public.customer_notes for insert to authenticated
  with check (created_by = auth.uid() and private.has_tenant_branch_access(tenant_id, branch_id, array['owner','manager','accountant','cashier','scheme_manager','employee']));
revoke update, delete on public.customer_notes from anon, authenticated;
grant select, insert on public.customer_notes to authenticated;

create table if not exists public.customer_interactions (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  branch_id uuid references public.branches(id) on delete set null,
  customer_id uuid not null,
  interaction_type text not null check (interaction_type in ('call','visit','complaint','scheme_help','payment_followup','other')),
  summary text not null check (length(trim(summary)) between 1 and 2000),
  follow_up_at timestamptz,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  foreign key (tenant_id, customer_id) references public.tenant_customers(tenant_id, id) on delete cascade
);
create index if not exists customer_interactions_followup_idx on public.customer_interactions(tenant_id, follow_up_at) where follow_up_at is not null;
create index if not exists customer_interactions_history_idx on public.customer_interactions(tenant_id, customer_id, created_at desc);
alter table public.customer_interactions enable row level security;
drop policy if exists customer_interactions_staff_read on public.customer_interactions;
create policy customer_interactions_staff_read on public.customer_interactions for select to authenticated
  using (private.has_tenant_branch_access(tenant_id, branch_id, array['owner','manager','accountant','cashier','scheme_manager','employee']));
drop policy if exists customer_interactions_staff_insert on public.customer_interactions;
create policy customer_interactions_staff_insert on public.customer_interactions for insert to authenticated
  with check (created_by = auth.uid() and private.has_tenant_branch_access(tenant_id, branch_id, array['owner','manager','accountant','cashier','scheme_manager','employee']));
revoke update, delete on public.customer_interactions from anon, authenticated;
grant select, insert on public.customer_interactions to authenticated;

-- Runtime permission evaluation uses a trusted active membership, never client metadata.
create or replace function private.has_tenant_permission(p_tenant_id uuid, p_branch_id uuid, p_permission text)
returns boolean
language sql stable security definer
set search_path=public,private,pg_temp
as $$
  select exists (
    select 1
    from public.tenant_memberships m
    where m.tenant_id=p_tenant_id
      and m.user_id=auth.uid()
      and m.is_active
      and (m.branch_id is null or m.branch_id is not distinct from p_branch_id)
      and case
        when m.role='owner' then true
        when m.permissions ? p_permission then m.permissions->p_permission = 'true'::jsonb
        else case p_permission
          when 'dashboard.read' then m.role in ('manager','accountant','cashier','scheme_manager','inventory_manager','employee')
          when 'customers.read' then m.role in ('manager','accountant','cashier','scheme_manager','employee')
          when 'customers.write' then m.role in ('manager','cashier','scheme_manager','employee')
          when 'rates.read' then m.role in ('manager','accountant','cashier','scheme_manager','inventory_manager','employee')
          when 'rates.write' then m.role in ('manager')
          when 'schemes.read' then m.role in ('manager','accountant','cashier','scheme_manager','employee')
          when 'schemes.write' then m.role in ('manager','scheme_manager')
          when 'collections.read' then m.role in ('manager','accountant','cashier','scheme_manager')
          when 'collections.write' then m.role in ('manager','accountant','cashier')
          when 'inventory.read' then m.role in ('manager','cashier','inventory_manager','employee')
          when 'inventory.write' then m.role in ('manager','inventory_manager')
          when 'reports.read' then m.role in ('manager','accountant')
          when 'employees.manage' then m.role='manager'
          when 'settings.manage' then m.role='manager'
          else false
        end
      end
  );
$$;
revoke all on function private.has_tenant_permission(uuid,uuid,text) from public, anon;
grant execute on function private.has_tenant_permission(uuid,uuid,text) to authenticated;

-- Provider attempts are observable, while credentials are deliberately not stored in these records.
create table if not exists public.rate_provider_runs (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  rate_source_id uuid references public.rate_sources(id) on delete set null,
  provider_name text not null,
  status text not null check (status in ('started','succeeded','partial','failed')),
  rates_imported integer not null default 0 check (rates_imported >= 0),
  started_at timestamptz not null default now(),
  completed_at timestamptz,
  safe_error text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index if not exists rate_provider_runs_history_idx on public.rate_provider_runs(tenant_id, started_at desc);
alter table public.rate_provider_runs enable row level security;
drop policy if exists rate_provider_runs_owner_read on public.rate_provider_runs;
create policy rate_provider_runs_owner_read on public.rate_provider_runs for select to authenticated
  using (private.has_tenant_role(tenant_id, array['owner','manager']));
drop policy if exists rate_provider_runs_service_write on public.rate_provider_runs;
create policy rate_provider_runs_service_write on public.rate_provider_runs for all to service_role using (true) with check (true);
revoke insert, update, delete on public.rate_provider_runs from anon, authenticated;
grant select on public.rate_provider_runs to authenticated;

-- Retry metadata for a real delivery worker. A queued notification is not described as delivered.
alter table public.notifications add column if not exists attempt_count integer not null default 0 check (attempt_count >= 0);
alter table public.notifications add column if not exists max_attempts integer not null default 5 check (max_attempts between 1 and 20);
alter table public.notifications add column if not exists last_attempt_at timestamptz;
alter table public.notifications add column if not exists next_retry_at timestamptz;
alter table public.notifications add column if not exists provider_configuration_snapshot jsonb not null default '{}'::jsonb;
create index if not exists notifications_retry_queue_idx on public.notifications(status, next_retry_at, scheduled_at)
  where status in ('queued','failed');

-- Refunds are a reviewable ledger. Approval never claims that the external provider actually paid it.
alter table public.refunds add column if not exists updated_at timestamptz not null default now();
alter table public.refunds add column if not exists decline_reason text;
alter table public.refunds add column if not exists external_reference text;
create index if not exists refunds_payment_history_idx on public.refunds(tenant_id, payment_id, created_at desc);
create index if not exists refunds_queue_idx on public.refunds(tenant_id, status, created_at desc);
drop policy if exists refunds_staff_read on public.refunds;
create policy refunds_staff_read on public.refunds for select to authenticated
  using (private.has_tenant_role(tenant_id, array['owner','manager','accountant']));
revoke insert, update, delete on public.refunds from anon, authenticated;
grant select on public.refunds to authenticated;

create or replace function public.request_refund(
  p_tenant_id uuid, p_payment_id uuid, p_amount numeric, p_reason text
) returns uuid
language plpgsql security definer
set search_path=public,private,pg_temp
as $$
declare
  v_user uuid:=auth.uid();
  v_payment public.payments%rowtype;
  v_reserved numeric(14,2);
  v_refund_id uuid;
begin
  if v_user is null then raise exception 'Authentication required' using errcode='42501'; end if;
  if not private.has_tenant_role(p_tenant_id,array['owner','manager','accountant']) then
    raise exception 'Permission denied' using errcode='42501';
  end if;
  if p_amount is null or p_amount<=0 or length(trim(coalesce(p_reason,'')))<4 then
    raise exception 'Enter a positive refund amount and a reason of at least four characters';
  end if;
  select * into v_payment from public.payments
    where tenant_id=p_tenant_id and id=p_payment_id and status='confirmed' for update;
  if not found then raise exception 'Confirmed payment not found for this shop'; end if;
  select coalesce(sum(amount),0) into v_reserved from public.refunds
    where tenant_id=p_tenant_id and payment_id=p_payment_id and status not in ('rejected','failed');
  if round(p_amount,2)>round(v_payment.amount-v_reserved,2) then
    raise exception 'Refund exceeds the remaining refundable payment balance';
  end if;
  insert into public.refunds(tenant_id,payment_id,amount,reason,status,requested_by)
    values(p_tenant_id,p_payment_id,round(p_amount,2),trim(p_reason),'requested',v_user)
    returning id into v_refund_id;
  insert into public.audit_logs(tenant_id,actor_user_id,event_name,entity_type,entity_id,details)
    values(p_tenant_id,v_user,'refund.requested','refund',v_refund_id::text,
      jsonb_build_object('payment_id',p_payment_id,'amount',round(p_amount,2),'reason',trim(p_reason)));
  return v_refund_id;
end;
$$;

create or replace function public.review_refund_request(
  p_tenant_id uuid, p_refund_id uuid, p_action text, p_reason text default null
) returns uuid
language plpgsql security definer
set search_path=public,private,pg_temp
as $$
declare
  v_user uuid:=auth.uid();
  v_refund public.refunds%rowtype;
begin
  if v_user is null then raise exception 'Authentication required' using errcode='42501'; end if;
  if not private.has_tenant_role(p_tenant_id,array['owner','manager','accountant']) then
    raise exception 'Permission denied' using errcode='42501';
  end if;
  if p_action not in ('approve','reject') then raise exception 'Action must be approve or reject'; end if;
  select * into v_refund from public.refunds where tenant_id=p_tenant_id and id=p_refund_id for update;
  if not found or v_refund.status<>'requested' then raise exception 'Only a requested refund can be reviewed'; end if;
  update public.refunds set status=case when p_action='approve' then 'approved' else 'rejected' end,
    approved_by=v_user, decline_reason=case when p_action='reject' then nullif(trim(coalesce(p_reason,'')),'') else null end,
    updated_at=now()
    where tenant_id=p_tenant_id and id=p_refund_id;
  insert into public.audit_logs(tenant_id,actor_user_id,event_name,entity_type,entity_id,details)
    values(p_tenant_id,v_user,'refund.reviewed','refund',p_refund_id::text,
      jsonb_build_object('action',p_action,'reason',p_reason,'amount',v_refund.amount));
  return p_refund_id;
end;
$$;

create or replace function public.complete_manual_refund(
  p_tenant_id uuid, p_refund_id uuid, p_reference text
) returns uuid
language plpgsql security definer
set search_path=public,private,pg_temp
as $$
declare
  v_user uuid:=auth.uid();
  v_refund public.refunds%rowtype;
  v_payment public.payments%rowtype;
begin
  if v_user is null then raise exception 'Authentication required' using errcode='42501'; end if;
  if not private.has_tenant_role(p_tenant_id,array['owner','manager','accountant']) then
    raise exception 'Permission denied' using errcode='42501';
  end if;
  if length(trim(coalesce(p_reference,'')))<3 then raise exception 'A payout reference is required'; end if;
  select * into v_refund from public.refunds where tenant_id=p_tenant_id and id=p_refund_id for update;
  if not found or v_refund.status<>'approved' then raise exception 'Only an approved refund can be completed'; end if;
  select * into v_payment from public.payments where tenant_id=p_tenant_id and id=v_refund.payment_id for update;
  if not found then raise exception 'Original payment not found'; end if;
  if lower(coalesce(v_payment.provider,''))='razorpay' or lower(v_payment.payment_method) in ('razorpay','card','gateway') then
    raise exception 'Gateway refunds must be completed through a verified provider refund workflow';
  end if;
  update public.refunds set status='completed',external_reference=trim(p_reference),provider_ref=trim(p_reference),
    completed_at=now(),updated_at=now() where tenant_id=p_tenant_id and id=p_refund_id;
  insert into public.financial_adjustments(tenant_id,payment_id,adjustment_type,amount,reason,approved_by,approved_at,created_by)
    values(p_tenant_id,v_payment.id,'refund',v_refund.amount,'Refund payout: '||trim(p_reference),v_user,now(),v_user);
  insert into public.audit_logs(tenant_id,actor_user_id,event_name,entity_type,entity_id,details)
    values(p_tenant_id,v_user,'refund.manual_completed','refund',p_refund_id::text,
      jsonb_build_object('payment_id',v_payment.id,'amount',v_refund.amount,'reference',trim(p_reference)));
  return p_refund_id;
end;
$$;

revoke all on function public.request_refund(uuid,uuid,numeric,text) from public,anon;
revoke all on function public.review_refund_request(uuid,uuid,text,text) from public,anon;
revoke all on function public.complete_manual_refund(uuid,uuid,text) from public,anon;
grant execute on function public.request_refund(uuid,uuid,numeric,text) to authenticated;
grant execute on function public.review_refund_request(uuid,uuid,text,text) to authenticated;
grant execute on function public.complete_manual_refund(uuid,uuid,text) to authenticated;

-- Platform-only operational audit trail, separate from tenant-visible audit records.
create table if not exists public.platform_audit_logs (
  id bigint generated always as identity primary key,
  actor_user_id uuid references auth.users(id) on delete set null,
  event_name text not null,
  entity_type text,
  entity_id text,
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index if not exists platform_audit_history_idx on public.platform_audit_logs(created_at desc);
alter table public.platform_audit_logs enable row level security;
drop policy if exists platform_audit_service_only on public.platform_audit_logs;
create policy platform_audit_service_only on public.platform_audit_logs for all to service_role using (true) with check (true);
revoke all on public.platform_audit_logs from public,anon,authenticated;
grant all on public.platform_audit_logs to service_role;

commit;