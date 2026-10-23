begin;

create or replace function public.claim_notification_batch(p_limit integer default 25)
returns setof public.notifications
language sql
security definer
set search_path=public,private,pg_temp
as $$
  with selected as (
    select n.id
    from public.notifications n
    where n.status in ('queued','failed')
      and n.attempt_count < n.max_attempts
      and coalesce(n.scheduled_at,n.created_at) <= now()
      and (n.next_retry_at is null or n.next_retry_at <= now())
    order by coalesce(n.scheduled_at,n.created_at),n.created_at
    for update skip locked
    limit least(greatest(coalesce(p_limit,25),1),100)
  ),
  claimed as (
    update public.notifications n
    set status='processing',
        attempt_count=n.attempt_count+1,
        last_attempt_at=now(),
        next_retry_at=null,
        failure_reason=null
    from selected s
    where n.id=s.id
    returning n.*
  )
  select * from claimed;
$$;

revoke all on function public.claim_notification_batch(integer) from public,anon,authenticated;
grant execute on function public.claim_notification_batch(integer) to service_role;

create index if not exists notifications_scheduled_claim_idx
  on public.notifications(status,scheduled_at,created_at)
  where status in ('queued','failed');

commit;