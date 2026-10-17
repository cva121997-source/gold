begin;

create or replace function public.update_scheme_draft(
 p_tenant_id uuid,p_scheme_id uuid,p_name text,p_description text,p_scheme_type text,p_terms jsonb
) returns uuid
language plpgsql
security definer
set search_path=public,private,pg_temp
as $$
begin
 return private.update_scheme_draft(p_tenant_id,p_scheme_id,p_name,p_description,p_scheme_type,p_terms);
end;
$$;

create or replace function public.set_scheme_lifecycle(
 p_tenant_id uuid,p_scheme_id uuid,p_action text
) returns text
language plpgsql
security definer
set search_path=public,private,pg_temp
as $$
begin
 return private.set_scheme_lifecycle(p_tenant_id,p_scheme_id,p_action);
end;
$$;

revoke all on function public.update_scheme_draft(uuid,uuid,text,text,text,jsonb) from public,anon;
revoke all on function public.set_scheme_lifecycle(uuid,uuid,text) from public,anon;
grant execute on function public.update_scheme_draft(uuid,uuid,text,text,text,jsonb) to authenticated;
grant execute on function public.set_scheme_lifecycle(uuid,uuid,text) to authenticated;

commit;