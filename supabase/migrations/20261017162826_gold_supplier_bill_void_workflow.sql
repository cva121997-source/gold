
CREATE OR REPLACE FUNCTION public.void_supplier_bill(p_tenant_id uuid,p_bill_id uuid,p_reason text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE v_bill public.supplier_bills%rowtype;v_previous_status text;
BEGIN
 IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Authentication required';END IF;
 IF length(trim(coalesce(p_reason,'')))<5 OR length(p_reason)>500 THEN RAISE EXCEPTION 'Provide a void reason between 5 and 500 characters';END IF;
 SELECT * INTO v_bill FROM public.supplier_bills sb WHERE sb.id=p_bill_id AND sb.tenant_id=p_tenant_id FOR UPDATE;
 IF NOT FOUND OR v_bill.status NOT IN('draft','posted') THEN RAISE EXCEPTION 'Only draft or unpaid posted bills can be voided';END IF;
 IF NOT private.has_tenant_branch_access(p_tenant_id,v_bill.branch_id,ARRAY['owner','manager','accountant']::text[]) THEN RAISE EXCEPTION 'Accounts-payable access denied';END IF;
 IF v_bill.status='posted' AND NOT private.has_tenant_branch_access(p_tenant_id,v_bill.branch_id,ARRAY['owner','manager']::text[]) THEN RAISE EXCEPTION 'Only an owner or manager can void a posted supplier bill';END IF;
 IF v_bill.paid_amount<>0 OR EXISTS(SELECT 1 FROM public.supplier_bill_payments sp WHERE sp.tenant_id=p_tenant_id AND sp.supplier_bill_id=p_bill_id AND sp.status='confirmed') THEN
  RAISE EXCEPTION 'Reverse supplier payment entries first; a paid or partially paid bill cannot be voided';
 END IF;
 v_previous_status:=v_bill.status;
 PERFORM set_config('gold.supplier_bill_workflow','on',true);
 UPDATE public.supplier_bills SET status='void',voided_by=auth.uid(),voided_at=now(),updated_at=now() WHERE id=p_bill_id AND tenant_id=p_tenant_id;
 PERFORM set_config('gold.supplier_bill_workflow','off',true);
 INSERT INTO public.audit_logs(tenant_id,actor_user_id,event_name,entity_type,entity_id,details)
 VALUES(p_tenant_id,auth.uid(),'supplier_bill.voided','supplier_bill',p_bill_id::text,
 jsonb_build_object('supplier_invoice_number',v_bill.supplier_invoice_number,'previous_status',v_previous_status,'reason',trim(p_reason),'total_amount',v_bill.total_amount));
 RETURN jsonb_build_object('id',p_bill_id,'status','void','previous_status',v_previous_status);
END;$$;
REVOKE ALL ON FUNCTION public.void_supplier_bill(uuid,uuid,text) FROM public,anon;
GRANT EXECUTE ON FUNCTION public.void_supplier_bill(uuid,uuid,text) TO authenticated;
