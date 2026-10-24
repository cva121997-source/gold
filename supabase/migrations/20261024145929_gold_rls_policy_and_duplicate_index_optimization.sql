begin;

-- Replace the two INSERT policies' per-row auth.uid() calls with init-plan
-- expressions. Authorization behavior remains exactly the same.
drop policy if exists customer_notes_staff_insert on public.customer_notes;
create policy customer_notes_staff_insert
on public.customer_notes for insert to authenticated
with check (
  created_by = (select auth.uid())
  and private.has_tenant_branch_access(
    tenant_id, branch_id,
    array['owner','manager','accountant','cashier','scheme_manager','employee']::text[]
  )
);

drop policy if exists customer_interactions_staff_insert on public.customer_interactions;
create policy customer_interactions_staff_insert
on public.customer_interactions for insert to authenticated
with check (
  created_by = (select auth.uid())
  and private.has_tenant_branch_access(
    tenant_id, branch_id,
    array['owner','manager','accountant','cashier','scheme_manager','employee']::text[]
  )
);

-- Consolidate SELECT policy overlap without broadening write permissions:
-- preserve the OR of existing SELECT and ALL predicates for reads, and split
-- each ALL policy into INSERT/UPDATE/DELETE policies with the same predicates.
do $policy_optimization$
declare
  v_table record;
  v_all_policy record;
  v_names text[];
  v_select_predicate text;
  v_policy_count integer;
  v_all_count integer;
  v_name text;
begin
  for v_table in
    select unnest(array[
      'customer_orders','feature_entitlements','inventory_items',
      'product_categories','products','profiles','rate_sources',
      'reconciliation_records','repair_jobs','staff_invitations',
      'suppliers','system_integrations','tax_configurations'
    ]) as table_name
  loop
    select count(*) into v_policy_count
    from pg_policies
    where schemaname='public' and tablename=v_table.table_name
      and cmd in ('ALL','SELECT');

    if v_policy_count < 2 then
      raise exception 'Expected overlapping SELECT/ALL policies on public.%', v_table.table_name;
    end if;

    if exists (
      select 1 from pg_policies
      where schemaname='public' and tablename=v_table.table_name
        and cmd in ('ALL','SELECT')
        and (roles <> '{authenticated}' or permissive <> 'PERMISSIVE')
    ) then
      raise exception 'Unexpected policy role/type on public.%', v_table.table_name;
    end if;

    select array_agg(policyname order by policyname) into v_names
    from pg_policies
    where schemaname='public' and tablename=v_table.table_name
      and cmd in ('ALL','SELECT');

    select count(*) into v_all_count
    from pg_policies
    where schemaname='public' and tablename=v_table.table_name
      and cmd='ALL';

    if v_all_count > 1 then
      raise exception 'Expected at most one ALL policy on public.%', v_table.table_name;
    end if;

    if v_all_count=1 then
      select policyname,qual,with_check into v_all_policy
      from pg_policies
      where schemaname='public' and tablename=v_table.table_name
        and cmd='ALL';
      if v_all_policy.policyname is null then
        raise exception 'Could not inspect ALL policy on public.%', v_table.table_name;
      end if;
    end if;

    select string_agg(predicate, ' OR ' order by predicate) into v_select_predicate
    from (
      select distinct '(' || coalesce(qual,'true') || ')' as predicate
      from pg_policies
      where schemaname='public' and tablename=v_table.table_name
        and cmd in ('ALL','SELECT')
    ) predicates;

    if v_select_predicate is null then
      raise exception 'Could not build SELECT predicate for public.%', v_table.table_name;
    end if;

    foreach v_name in array v_names loop
      execute format('drop policy %I on public.%I',v_name,v_table.table_name);
    end loop;

    execute format(
      'create policy perf_select_optimized on public.%I for select to authenticated using (%s)',
      v_table.table_name, v_select_predicate
    );

    if v_all_count=1 then
      execute format(
        'create policy perf_insert_optimized on public.%I for insert to authenticated with check (%s)',
        v_table.table_name, coalesce(v_all_policy.with_check,v_all_policy.qual,'true')
      );
      execute format(
        'create policy perf_update_optimized on public.%I for update to authenticated using (%s) with check (%s)',
        v_table.table_name,
        coalesce(v_all_policy.qual,'true'),
        coalesce(v_all_policy.with_check,v_all_policy.qual,'true')
      );
      execute format(
        'create policy perf_delete_optimized on public.%I for delete to authenticated using (%s)',
        v_table.table_name, coalesce(v_all_policy.qual,'true')
      );
    end if;
  end loop;
end;
$policy_optimization$;

-- Remove only redundant standalone indexes. The underlying UNIQUE constraints
-- (and their constraint-backed indexes) remain intact.
drop index if exists public.inventory_items_tenant_id_unique_idx;
drop index if exists public.inventory_items_tenant_item_code_uidx;
drop index if exists public.suppliers_tenant_id_unique_idx;

notify pgrst, 'reload schema';
commit;
