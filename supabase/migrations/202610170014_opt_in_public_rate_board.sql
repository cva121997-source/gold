-- Opt-in public rate board. No shop's rates are exposed unless the shop marks each rate public.
begin;

alter table public.gold_rates add column if not exists is_public boolean not null default false;
create index if not exists gold_rates_public_latest_idx
 on public.gold_rates(tenant_id,is_public,effective_at desc) where is_public;

create or replace function private.get_public_rate_board(p_shop_slug text)
returns table(
 shop_name text, shop_slug text, branch_name text, state text, district text, city text, locality text,
 metal_code text, metal_name text, purity_code text, purity_label text, price_per_gram numeric,
 source_label text, rate_status text, effective_at timestamptz, is_stale boolean
)
language sql stable security definer set search_path=public,private,pg_temp as $$
 with public_rates as (
   select distinct on (
      r.tenant_id,coalesce(r.branch_id,'00000000-0000-0000-0000-000000000000'::uuid),
      r.metal_id,r.purity_id,coalesce(r.state,''),coalesce(r.district,''),coalesce(r.city,''),coalesce(r.locality,'')
   )
     r.*,b.name as branch_display
   from public.gold_rates r
   left join public.branches b on b.tenant_id=r.tenant_id and b.id=r.branch_id
   where r.is_public=true and r.effective_at<=now()
     and r.status in ('verified','indicative','stale','demo')
   order by r.tenant_id,coalesce(r.branch_id,'00000000-0000-0000-0000-000000000000'::uuid),
     r.metal_id,r.purity_id,coalesce(r.state,''),coalesce(r.district,''),coalesce(r.city,''),coalesce(r.locality,''),
     r.effective_at desc,r.created_at desc
 )
 select t.display_name,t.slug,pr.branch_display,
   coalesce(pr.state,t.state),coalesce(pr.district,t.district),coalesce(pr.city,t.city),coalesce(pr.locality,t.locality),
   m.code,m.name,p.code,p.label,pr.price_per_gram,pr.source_label,pr.status,pr.effective_at,
   (pr.status<>'verified' or pr.effective_at<now()-interval '36 hours' or (pr.expires_at is not null and pr.expires_at<=now()))
 from public_rates pr
 join public.tenants t on t.id=pr.tenant_id
 join public.metals m on m.id=pr.metal_id
 join public.purity_definitions p on p.id=pr.purity_id and p.metal_id=pr.metal_id
 where lower(t.slug)=lower(trim(p_shop_slug)) and t.status in ('active','trial')
 order by coalesce(pr.state,t.state),coalesce(pr.city,t.city),coalesce(pr.locality,t.locality),m.name,p.fineness desc,pr.effective_at desc;
$$;
revoke execute on function private.get_public_rate_board(text) from public,anon,authenticated;
grant execute on function private.get_public_rate_board(text) to anon,authenticated;
grant usage on schema private to anon,authenticated;

create or replace function public.get_public_rate_board(p_shop_slug text)
returns table(
 shop_name text, shop_slug text, branch_name text, state text, district text, city text, locality text,
 metal_code text, metal_name text, purity_code text, purity_label text, price_per_gram numeric,
 source_label text, rate_status text, effective_at timestamptz, is_stale boolean
)
language sql stable security invoker set search_path=public,private,pg_temp
as $$ select * from private.get_public_rate_board(p_shop_slug); $$;
revoke execute on function public.get_public_rate_board(text) from public;
grant execute on function public.get_public_rate_board(text) to anon,authenticated;

commit;
