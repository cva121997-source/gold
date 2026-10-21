begin;
create or replace function public.import_reconciliation_statement_lines(p_tenant_id uuid,p_reconciliation_id uuid,p_lines jsonb)
returns jsonb language plpgsql security definer set search_path=public,private,pg_temp as $$
declare
 v_user uuid:=auth.uid(); v_recon public.reconciliation_records%rowtype; v_line jsonb;
 v_date date; v_reference text; v_description text; v_amount numeric(14,2); v_currency text; v_key text;
 v_status text; v_match_count integer; v_payment_id uuid; v_payment_amount numeric(14,2);
 v_existing_match boolean; v_inserted integer:=0; v_skipped integer:=0; v_sum numeric(14,2); v_unresolved integer:=0;
begin
 if v_user is null then raise exception 'Authentication required' using errcode='42501'; end if;
 if not private.has_tenant_role(p_tenant_id,array['owner','manager','accountant']) then
  raise exception 'Only an owner, manager or accountant can import a provider or bank statement' using errcode='42501';
 end if;
 if jsonb_typeof(p_lines) is distinct from 'array' then raise exception 'Statement lines must be a JSON array'; end if;
 if jsonb_array_length(p_lines)=0 or jsonb_array_length(p_lines)>1000 then raise exception 'Import between 1 and 1,000 statement lines per batch'; end if;
 select * into v_recon from public.reconciliation_records where tenant_id=p_tenant_id and id=p_reconciliation_id for update;
 if not found then raise exception 'Reconciliation period was not found for this shop'; end if;
 if v_recon.status not in ('open','investigating','matched') then raise exception 'Only open, investigating or previously matched periods accept statement imports'; end if;
 if v_recon.branch_id is not null and not private.has_tenant_branch_access(p_tenant_id,v_recon.branch_id,array['owner','manager','accountant']) then
  raise exception 'Reconciliation branch access denied' using errcode='42501';
 end if;
 for v_line in select value from jsonb_array_elements(p_lines) loop
  v_reference:=trim(coalesce(v_line->>'provider_reference',''));
  if v_reference='' or length(v_reference)>200 then raise exception 'Every row requires a provider reference of at most 200 characters'; end if;
  if coalesce(v_line->>'transaction_date','') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' then raise exception 'Every row requires transaction_date in YYYY-MM-DD format'; end if;
  begin v_date:=(v_line->>'transaction_date')::date; exception when others then raise exception 'Statement transaction date is invalid'; end;
  if v_date<v_recon.period_start or v_date>v_recon.period_end then raise exception 'Statement row date % is outside the reconciliation period',v_date; end if;
  begin v_amount:=round((v_line->>'amount')::numeric,2); exception when others then raise exception 'Each row must contain a valid numeric amount'; end;
  if abs(v_amount)>999999999999.99 then raise exception 'Statement amount exceeds the supported limit'; end if;
  v_currency:=upper(coalesce(nullif(trim(v_line->>'currency'),''),'INR'));
  if v_currency !~ '^[A-Z]{3}$' then raise exception 'Currency must be a valid three-letter code'; end if;
  v_description:=left(trim(coalesce(v_line->>'description','')),500);
  v_key:=md5(v_date::text||chr(31)||v_reference||chr(31)||v_amount::text||chr(31)||v_currency||chr(31)||v_description);
  v_status:='unmatched';v_payment_id:=null;v_payment_amount:=null;v_match_count:=0;v_existing_match:=false;
  select count(*) into v_match_count from public.payments p
   where p.tenant_id=p_tenant_id and p.provider='razorpay' and p.provider_payment_ref=v_reference
    and p.status='confirmed' and p.currency=v_currency and (v_recon.branch_id is null or p.branch_id=v_recon.branch_id);
  if v_match_count>1 then v_status:='ambiguous_match';
  elsif v_match_count=1 then
   select p.id,p.amount into v_payment_id,v_payment_amount from public.payments p
    where p.tenant_id=p_tenant_id and p.provider='razorpay' and p.provider_payment_ref=v_reference
     and p.status='confirmed' and p.currency=v_currency and (v_recon.branch_id is null or p.branch_id=v_recon.branch_id) limit 1;
   select exists(select 1 from public.reconciliation_statement_lines x where x.tenant_id=p_tenant_id
    and x.reconciliation_id=p_reconciliation_id and x.matched_payment_id=v_payment_id) into v_existing_match;
   if v_existing_match then v_status:='duplicate_reference';v_payment_id:=null;
   else v_status:=case when abs(v_amount-v_payment_amount)<0.01 then 'matched' else 'amount_mismatch' end; end if;
  end if;
  insert into public.reconciliation_statement_lines(tenant_id,reconciliation_id,statement_line_key,transaction_date,
   provider_reference,description,statement_amount,currency,line_status,matched_payment_id,matched_ledger_amount,difference_amount,created_by)
  values(p_tenant_id,p_reconciliation_id,v_key,v_date,v_reference,nullif(v_description,''),v_amount,v_currency,
   v_status,v_payment_id,v_payment_amount,case when v_payment_id is not null then round(v_amount-v_payment_amount,2) else null end,v_user)
  on conflict(tenant_id,reconciliation_id,statement_line_key) do nothing;
  if found then v_inserted:=v_inserted+1; else v_skipped:=v_skipped+1; end if;
 end loop;
 select coalesce(sum(statement_amount),0),count(*) filter (where line_status<>'matched') into v_sum,v_unresolved from public.reconciliation_statement_lines where tenant_id=p_tenant_id and reconciliation_id=p_reconciliation_id;
 update public.reconciliation_records set actual_amount=v_sum,difference_amount=round(expected_amount-v_sum,2),
  status=case when abs(expected_amount-v_sum)<0.01 and v_unresolved=0 then 'matched' when abs(expected_amount-v_sum)<0.01 then 'investigating' else 'open' end,
  reconciled_by=case when abs(expected_amount-v_sum)<0.01 and v_unresolved=0 then v_user else null end,
  reconciled_at=case when abs(expected_amount-v_sum)<0.01 and v_unresolved=0 then now() else null end,
  notes=case when nullif(trim(coalesce(notes,'')),'') is null then 'Statement CSV imported; review matched and unmatched lines.' else notes end
  where tenant_id=p_tenant_id and id=p_reconciliation_id;
 insert into public.audit_logs(tenant_id,actor_user_id,event_name,entity_type,entity_id,details)
 values(p_tenant_id,v_user,'reconciliation.statement_imported','reconciliation',p_reconciliation_id::text,
  jsonb_build_object('provider',v_recon.provider,'period_start',v_recon.period_start,'period_end',v_recon.period_end,
   'lines_inserted',v_inserted,'duplicate_lines_skipped',v_skipped,'statement_total',v_sum,'difference',round(v_recon.expected_amount-v_sum,2)));
 return jsonb_build_object('inserted',v_inserted,'duplicateLinesSkipped',v_skipped,'statementTotal',v_sum,'difference',round(v_recon.expected_amount-v_sum,2));
end; $$;
revoke all on function public.import_reconciliation_statement_lines(uuid,uuid,jsonb) from public,anon;
grant execute on function public.import_reconciliation_statement_lines(uuid,uuid,jsonb) to authenticated;
commit;