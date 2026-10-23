begin;

create or replace function public.claim_notification_batch(p_limit integer default 25)
returns setof public.notifications
language sql
security definer
set search_path=public,private,pg_temp
as $$
  with recovered as (
    update public.notifications n
    set status='failed',
        failure_reason='Delivery worker stopped before recording a result; item recovered by the queue watchdog.',
        next_retry_at=case when n.attempt_count<n.max_attempts then now() else null end
    where n.status='processing'
      and n.last_attempt_at < now()-interval '10 minutes'
    returning n.id
  ),
  selected as (
    select n.id
    from public.notifications n
    where n.status in ('queued','failed')
      and n.attempt_count<n.max_attempts
      and coalesce(n.scheduled_at,n.created_at)<=now()
      and (n.next_retry_at is null or n.next_retry_at<=now())
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

commit;