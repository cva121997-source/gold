begin;

-- The legacy constraint excludes states used by the approved transfer workflow.
-- Keep the newer, complete workflow constraint and remove only the obsolete one.
alter table public.stock_transfers
  drop constraint if exists stock_transfers_status_check;

do $verify$
begin
  if not exists (
    select 1
    from pg_constraint
    where conrelid = 'public.stock_transfers'::regclass
      and conname = 'stock_transfers_status_workflow_check'
      and convalidated
      and pg_get_constraintdef(oid) like '%pending_approval%'
      and pg_get_constraintdef(oid) like '%approved%'
      and pg_get_constraintdef(oid) like '%in_transit%'
  ) then
    raise exception 'Expected validated stock-transfer workflow status constraint was not found';
  end if;
end
$verify$;

commit;
