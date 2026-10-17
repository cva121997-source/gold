CREATE OR REPLACE FUNCTION public.record_supplier_bill_payment(p_tenant_id uuid,p_bill_id uuid,p_amount numeric,p_payment_method text,p_payment_reference text,p_payment_date date,p_idempotency_key text)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE v_bill public.supplier_bills%rowtype;v_old public.supplier_bill_payments%rowtype;v_id uuid;v_number text;v_balance numeric(14,2);
BEGIN
 IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Authentication required';END IF;
 IF p_amount IS NULL OR p_amount<=0 THEN RAISE EXCEPTION 'Payment amount must be greater than zero';END IF;
 IF p_payment_method NOT IN('cash','bank_transfer','upi','cheque','neft','rtgs','other') THEN RAISE EXCEPTION 'Choose a supported supplier payment method';END IF;
 IF p_idempotency_key IS NULL OR length(trim(p_idempotency_key))<8 OR length(p_idempotency_key)>160 THEN RAISE EXCEPTION 'Payment idempotency key is required';END IF;
 IF p_payment_reference IS NOT NULL AND length(p_payment_reference)>160 THEN RAISE EXCEPTION 'Payment reference may be 160 characters or fewer';END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(p_tenant_id::text||':'||p_idempotency_key,0));
 SELECT * INTO v_bill FROM public.supplier_bills WHERE id=p_bill_id AND tenant_id=p_tenant_id FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Supplier bill not found';END IF;
 IF NOT private.has_tenant_branch_access(p_tenant_id,v_bill.branch_id,ARRAY['owner','manager','accountant']::text[]) THEN RAISE EXCEPTION 'Accounts-payable access denied';END IF;
 SELECT * INTO v_old FROM public.supplier_bill_payments WHERE tenant_id=p_tenant_id AND idempotency_key=p_idempotency_key;
 IF FOUND THEN
  IF v_old.supplier_bill_id<>p_bill_id OR v_old.amount<>p_amount OR v_old.payment_method<>p_payment_method OR coalesce(v_old.payment_reference,'')<>coalesce(nullif(trim(coalesce(p_payment_reference,'')),''),'') OR v_old.payment_date<>coalesce(p_payment_date,current_date) THEN
   RAISE EXCEPTION 'Idempotency key was already used for a different supplier payment';
  END IF;
  RETURN v_old.id;
 END IF;
 IF v_bill.status NOT IN('posted','partially_paid') THEN RAISE EXCEPTION 'Only posted supplier bills with an outstanding balance can be paid';END IF;
 v_balance:=v_bill.total_amount-v_bill.paid_amount;
 IF p_amount>v_balance THEN RAISE EXCEPTION 'Payment exceeds current balance of %',v_balance;END IF;
 v_number:='SP-'||to_char(now() AT TIME ZONE 'Asia/Kolkata','YYYYMMDD')||'-'||upper(substr(replace(gen_random_uuid()::text,'-',''),1,6));
 INSERT INTO public.supplier_bill_payments(tenant_id,supplier_bill_id,payment_number,amount,payment_method,payment_reference,payment_date,idempotency_key,status,created_by)
 VALUES(p_tenant_id,p_bill_id,v_number,p_amount,p_payment_method,nullif(trim(coalesce(p_payment_reference,'')),''),coalesce(p_payment_date,current_date),p_idempotency_key,'confirmed',auth.uid()) RETURNING id INTO v_id;
 PERFORM set_config('gold.supplier_bill_workflow','on',true);
 UPDATE public.supplier_bills SET paid_amount=paid_amount+p_amount,status=CASE WHEN paid_amount+p_amount>=total_amount THEN 'paid' ELSE 'partially_paid' END,updated_at=now() WHERE id=p_bill_id AND tenant_id=p_tenant_id;
 PERFORM set_config('gold.supplier_bill_workflow','off',true);
 INSERT INTO public.audit_logs(tenant_id,actor_user_id,event_name,entity_type,entity_id,details)
 VALUES(p_tenant_id,auth.uid(),'supplier_bill.payment_recorded','supplier_bill',p_bill_id::text,jsonb_build_object('payment_id',v_id,'payment_number',v_number,'amount',p_amount,'method',p_payment_method,'reference',p_payment_reference));
 RETURN v_id;
END;$$;
REVOKE ALL ON FUNCTION public.record_supplier_bill_payment(uuid,uuid,numeric,text,text,date,text) FROM public,anon;
GRANT EXECUTE ON FUNCTION public.record_supplier_bill_payment(uuid,uuid,numeric,text,text,date,text) TO authenticated;
