-- Scheme draft creation and owner-reviewed publication.
-- Business terms are versioned. Client roles cannot bypass the publish RPC by updating status directly.
begin;

create or replace function public.create_scheme_draft(
  p_tenant_id uuid,
  p_name text,
  p_description text,
  p_scheme_type text,
  p_terms jsonb
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_user_id uuid := auth.uid();
  v_scheme_id uuid;
begin
  if v_user_id is null then raise exception 'Authentication required' using errcode = '42501'; end if;
  if not public.has_tenant_role(p_tenant_id, array['owner','manager','scheme_manager']) then
    raise exception 'Permission denied' using errcode = '42501';
  end if;
  if length(trim(coalesce(p_name, ''))) < 2 then raise exception 'Scheme name is required'; end if;
  if p_scheme_type not in ('flexible_gold_weight','fixed_monthly','custom') then raise exception 'Unsupported scheme type'; end if;
  if p_terms is null or jsonb_typeof(p_terms) <> 'object' then raise exception 'Scheme terms must be a JSON object'; end if;

  insert into public.scheme_templates(tenant_id, name, description, scheme_type, status, current_version, created_by)
    values (p_tenant_id, trim(p_name), nullif(trim(p_description), ''), p_scheme_type, 'draft', 1, v_user_id)
    returning id into v_scheme_id;
  insert into public.scheme_versions(tenant_id, scheme_id, version_no, terms, terms_markdown, created_by)
    values (p_tenant_id, v_scheme_id, 1, p_terms || jsonb_build_object('requires_owner_review', true, 'customer_terms_approved', false), coalesce(p_description, 'Draft terms require owner review.'), v_user_id);
  insert into public.audit_logs(tenant_id, actor_user_id, event_name, entity_type, entity_id, details)
    values (p_tenant_id, v_user_id, 'scheme.draft_created', 'scheme', v_scheme_id::text, jsonb_build_object('scheme_type', p_scheme_type, 'version', 1));
  return v_scheme_id;
end;
$$;
revoke all on function public.create_scheme_draft(uuid,text,text,text,jsonb) from public;
grant execute on function public.create_scheme_draft(uuid,text,text,text,jsonb) to authenticated;

create or replace function public.publish_scheme_draft(
  p_tenant_id uuid,
  p_scheme_id uuid,
  p_owner_approved boolean
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_user_id uuid := auth.uid();
  v_version integer;
begin
  if v_user_id is null then raise exception 'Authentication required' using errcode = '42501'; end if;
  if p_owner_approved is not true then raise exception 'Owner approval is required'; end if;
  if not public.has_tenant_role(p_tenant_id, array['owner']) then
    raise exception 'Only the shop owner can publish a scheme' using errcode = '42501';
  end if;

  select current_version into v_version
    from public.scheme_templates
    where tenant_id = p_tenant_id and id = p_scheme_id and status = 'draft'
    for update;
  if not found then raise exception 'Draft scheme not found or it is no longer a draft'; end if;

  update public.scheme_versions
    set reviewed_by = v_user_id, reviewed_at = now(), effective_from = now()
    where tenant_id = p_tenant_id and scheme_id = p_scheme_id and version_no = v_version;
  if not found then raise exception 'Scheme terms version not found'; end if;

  update public.scheme_templates set status = 'published', updated_at = now()
    where tenant_id = p_tenant_id and id = p_scheme_id;
  insert into public.audit_logs(tenant_id, actor_user_id, event_name, entity_type, entity_id, details)
    values (p_tenant_id, v_user_id, 'scheme.published', 'scheme', p_scheme_id::text, jsonb_build_object('version', v_version, 'owner_approved', true));
end;
$$;
revoke all on function public.publish_scheme_draft(uuid,uuid,boolean) from public;
grant execute on function public.publish_scheme_draft(uuid,uuid,boolean) to authenticated;

-- Writes to these tables must go through the functions above, preventing direct status changes.
revoke insert, update, delete on public.scheme_templates from public, anon, authenticated;
revoke insert, update, delete on public.scheme_versions from public, anon, authenticated;
grant select on public.scheme_templates to authenticated;
grant select on public.scheme_versions to authenticated;

-- Every new tenant starts with two draft templates. They cannot be used until reviewed and published.
create or replace function public.seed_gold_default_schemes()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_flexible_id uuid;
  v_monthly_id uuid;
  v_actor uuid := auth.uid();
begin
  insert into public.scheme_templates(tenant_id, name, description, scheme_type, status, current_version, created_by)
    values (new.id, 'Flexible Gold-Weight Savings', 'Draft template: flexible contributions valued using the rate and rules saved for each confirmed contribution.', 'flexible_gold_weight', 'draft', 1, v_actor)
    returning id into v_flexible_id;
  insert into public.scheme_versions(tenant_id, scheme_id, version_no, terms, terms_markdown, created_by)
    values (new.id, v_flexible_id, 1,
      jsonb_build_object('payment_frequency','flexible','tenure_months',null,'metal','gold','purity_code','22K','minimum_contribution_inr',null,'maximum_contribution_inr',null,'valuation_method','price_per_gram_at_confirmed_contribution','benefit_type','none','requires_owner_review',true,'customer_terms_approved',false),
      'Draft only. Configure contribution limits, valuation, cancellation and redemption rules. Owner review and applicable legal/tax review are required before publication.',
      v_actor);

  insert into public.scheme_templates(tenant_id, name, description, scheme_type, status, current_version, created_by)
    values (new.id, '11-Month Jewellery Savings Scheme', 'Draft template: monthly contributions with a configurable maturity benefit.', 'fixed_monthly', 'draft', 1, v_actor)
    returning id into v_monthly_id;
  insert into public.scheme_versions(tenant_id, scheme_id, version_no, terms, terms_markdown, created_by)
    values (new.id, v_monthly_id, 1,
      jsonb_build_object('payment_frequency','monthly','tenure_months',11,'monthly_instalment_inr',null,'benefit_type','jewellery_purchase_credit','benefit_equivalent_monthly_instalments',1,'metal','gold','purity_code','22K','requires_owner_review',true,'customer_terms_approved',false),
      'Draft only. Configure instalment amount, due dates, missed-payment rules, eligibility and exact benefit conditions. Owner review and applicable legal/tax review are required before publication.',
      v_actor);
  return new;
end;
$$;

drop trigger if exists on_tenant_created_gold_default_schemes on public.tenants;
create trigger on_tenant_created_gold_default_schemes
after insert on public.tenants
for each row execute procedure public.seed_gold_default_schemes();

commit;
