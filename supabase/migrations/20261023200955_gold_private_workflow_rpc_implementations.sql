begin;

-- Keep the RPC names consumed by the app, but move privileged function bodies
-- out of the API-exposed public schema. Public wrappers below run as invoker;
-- the private implementations continue to enforce the signed-in user's role.
do $migration$
declare
  v record;
  v_call_args text;
begin
  for v in
    select p.oid,
           p.proname,
           pg_get_function_identity_arguments(p.oid) as identity_args,
           pg_get_function_arguments(p.oid) as full_args,
           pg_get_function_result(p.oid) as result_type,
           p.pronargs,
           p.proretset,
           p.proargtypes
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname = any (array[
        'add_stock_transfer_item',
        'approve_supplier_bill_price_variance',
        'begin_razorpay_gateway_refund',
        'cancel_stock_transfer',
        'complete_manual_refund',
        'create_credit_note_draft',
        'create_draft_invoice_for_inventory_item',
        'create_inventory_stocktake',
        'create_stock_transfer',
        'dispatch_stock_transfer',
        'finalize_inventory_stocktake',
        'import_reconciliation_statement_lines',
        'issue_credit_note',
        'mark_inventory_stocktake_item',
        'post_supplier_bill',
        'receive_purchase_order',
        'receive_stock_transfer',
        'record_credit_note_stock_return',
        'record_customer_consent',
        'record_supplier_bill_payment',
        'request_refund',
        'resolve_inventory_stocktake_discrepancy',
        'revalue_inventory_item',
        'reverse_supplier_bill_payment',
        'review_provider_gold_rate',
        'review_refund_request',
        'review_stock_transfer',
        'set_scheme_lifecycle',
        'submit_purchase_order',
        'submit_stock_transfer',
        'update_scheme_draft',
        'void_draft_credit_note',
        'void_supplier_bill'
      ])
      and p.prosecdef
      and has_function_privilege('authenticated', p.oid, 'EXECUTE')
    order by p.proname
  loop
    -- These two public functions are already safe wrappers over private
    -- implementations, so only change their wrapper security mode below.
    if v.proname in ('set_scheme_lifecycle', 'update_scheme_draft') then
      continue;
    end if;

    if v.proretset then
      raise exception 'Unexpected set-returning workflow RPC: %', v.proname;
    end if;

    if exists (
      select 1
      from pg_proc private_proc
      join pg_namespace private_ns on private_ns.oid = private_proc.pronamespace
      where private_ns.nspname = 'private'
        and private_proc.proname = v.proname
        and private_proc.proargtypes = v.proargtypes
    ) then
      raise exception 'Private implementation already exists for %', v.proname;
    end if;

    select string_agg('$' || arg_position::text, ', ' order by arg_position)
      into v_call_args
      from generate_series(1, v.pronargs) as arg_position;

    execute format(
      'alter function public.%I(%s) set schema private',
      v.proname,
      v.identity_args
    );

    execute format(
      'create function public.%I(%s) returns %s
       language sql security invoker
       set search_path to public, private, pg_temp
       as $wrapper$ select private.%I(%s) $wrapper$',
      v.proname,
      v.full_args,
      v.result_type,
      v.proname,
      v_call_args
    );

    execute format(
      'revoke all on function public.%I(%s) from public, anon',
      v.proname,
      v.identity_args
    );
    execute format(
      'grant execute on function public.%I(%s) to authenticated, service_role',
      v.proname,
      v.identity_args
    );
  end loop;
end;
$migration$;

-- Preserve the scheme RPCs' signatures and authorization logic while making
-- the API-exposed wrappers SECURITY INVOKER.
create or replace function public.set_scheme_lifecycle(
  p_tenant_id uuid, p_scheme_id uuid, p_action text
) returns text
language sql
security invoker
set search_path to public, private, pg_temp
as $wrapper$ select private.set_scheme_lifecycle($1, $2, $3) $wrapper$;

create or replace function public.update_scheme_draft(
  p_tenant_id uuid, p_scheme_id uuid, p_name text, p_description text,
  p_scheme_type text, p_terms jsonb
) returns uuid
language sql
security invoker
set search_path to public, private, pg_temp
as $wrapper$ select private.update_scheme_draft($1, $2, $3, $4, $5, $6) $wrapper$;

-- Invoker wrappers execute under the caller's role, so the private schema
-- implementations they call need explicit EXECUTE grants and schema usage.
grant usage on schema private to authenticated, service_role;
grant execute on function private.set_scheme_lifecycle(uuid, uuid, text) to authenticated, service_role;
grant execute on function private.update_scheme_draft(uuid, uuid, text, text, text, jsonb) to authenticated, service_role;

revoke all on function public.set_scheme_lifecycle(uuid, uuid, text) from public, anon;
grant execute on function public.set_scheme_lifecycle(uuid, uuid, text) to authenticated, service_role;
revoke all on function public.update_scheme_draft(uuid, uuid, text, text, text, jsonb) from public, anon;
grant execute on function public.update_scheme_draft(uuid, uuid, text, text, text, jsonb) to authenticated, service_role;

notify pgrst, 'reload schema';
commit;
