begin;

create or replace function private.get_public_rate_board_for_date(p_shop_slug text,p_rate_date date)
returns table(
 shop_name text, shop_slug text, branch_name text, state text, district text, city text, locality text,
 metal_code text, metal_name text, purity_code text, purity_label text, price_per_gram numeric,
 source_label text, rate_status text, effective_at timestamptz, is_stale boolean
)
language plpgsql stable security definer set search_path=public,private,pg_temp
as $$
begin
  if nullif(trim(coalesce(p_shop_slug,'')),'') is null then
    raise exception 'Shop slug is required';
  end if;
  if p_rate_date is null or p_rate_date > (now() at time zone 'Asia/Kolkata')::date then
    raise exception 'Rate date must be today or an earlier date in India time';
  end if;

  return query
  with public_rates as (
    select distinct on (
      r.tenant_id,coalesce(r.branch_id,'00000000-0000-0000-0000-000000000000'::uuid),
      r.metal_id,r.purity_id,coalesce(r.state,''),coalesce(r.district,''),coalesce(r.city,''),coalesce(r.locality,'')
    ) r.*,b.name as branch_display,t.display_name as tenant_display,t.slug as tenant_slug,
      t.state as tenant_state,t.district as tenant_district,t.city as tenant_city,t.locality as tenant_locality,t.timezone as tenant_timezone
    from public.gold_rates r
    join public.tenants t on t.id=r.tenant_id
    left join public.branches b on b.tenant_id=r.tenant_id and b.id=r.branch_id
    where lower(t.slug)=lower(trim(p_shop_slug))
      and t.status in ('active','trial')
      and r.is_public=true
      and (r.effective_at at time zone coalesce(nullif(t.timezone,''),'Asia/Kolkata'))::date <= p_rate_date
      and r.status in ('verified','indicative','stale','demo')
    order by r.tenant_id,coalesce(r.branch_id,'00000000-0000-0000-0000-000000000000'::uuid),
      r.metal_id,r.purity_id,coalesce(r.state,''),coalesce(r.district,''),coalesce(r.city,''),coalesce(r.locality,''),
      r.effective_at desc,r.created_at desc
  )
  select pr.tenant_display,pr.tenant_slug,pr.branch_display,
    coalesce(pr.state,pr.tenant_state),coalesce(pr.district,pr.tenant_district),
    coalesce(pr.city,pr.tenant_city),coalesce(pr.locality,pr.tenant_locality),
    m.code,m.name,p.code,p.label,pr.price_per_gram,pr.source_label,pr.status,pr.effective_at,
    (pr.status<>'verified' or pr.effective_at<now()-interval '36 hours'
      or (pr.expires_at is not null and pr.expires_at<=now()))
  from public_rates pr
  join public.metals m on m.id=pr.metal_id
  join public.purity_definitions p on p.id=pr.purity_id and p.metal_id=pr.metal_id
  order by coalesce(pr.state,pr.tenant_state),coalesce(pr.city,pr.tenant_city),coalesce(pr.locality,pr.tenant_locality),
    m.name,p.fineness desc,pr.effective_at desc;
end;
$$;

revoke execute on function private.get_public_rate_board_for_date(text,date) from public,anon,authenticated;
grant execute on function private.get_public_rate_board_for_date(text,date) to anon,authenticated;
create or replace function public.get_public_rate_board_for_date(p_shop_slug text,p_rate_date date)
returns table(
 shop_name text, shop_slug text, branch_name text, state text, district text, city text, locality text,
 metal_code text, metal_name text, purity_code text, purity_label text, price_per_gram numeric,
 source_label text, rate_status text, effective_at timestamptz, is_stale boolean
)
language sql stable security invoker set search_path=public,private,pg_temp
as $$ select * from private.get_public_rate_board_for_date(p_shop_slug,p_rate_date); $$;
revoke execute on function public.get_public_rate_board_for_date(text,date) from public;
grant execute on function public.get_public_rate_board_for_date(text,date) to anon,authenticated;

commit;