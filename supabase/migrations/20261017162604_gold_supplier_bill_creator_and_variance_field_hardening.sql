
CREATE OR REPLACE FUNCTION private.guard_supplier_bill_identity()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
 IF TG_OP='INSERT' THEN
  IF auth.uid() IS NULL OR NEW.created_by IS DISTINCT FROM auth.uid() THEN RAISE EXCEPTION 'Supplier bill creator must match the authenticated user'; END IF;
  IF NEW.status<>'draft' OR NEW.paid_amount<>0 OR NEW.price_variance_approved_by IS NOT NULL OR NEW.price_variance_approved_at IS NOT NULL OR NEW.price_variance_reason IS NOT NULL OR NEW.posted_by IS NOT NULL OR NEW.posted_at IS NOT NULL OR NEW.voided_by IS NOT NULL OR NEW.voided_at IS NOT NULL THEN
   RAISE EXCEPTION 'New supplier bills must start as unapproved drafts';
  END IF;
  RETURN NEW;
 END IF;
 IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id OR NEW.branch_id IS DISTINCT FROM OLD.branch_id OR NEW.supplier_id IS DISTINCT FROM OLD.supplier_id OR NEW.purchase_order_id IS DISTINCT FROM OLD.purchase_order_id OR NEW.created_by IS DISTINCT FROM OLD.created_by THEN
  RAISE EXCEPTION 'Supplier bill tenant, branch, supplier, purchase-order link and creator are immutable';
 END IF;
 RETURN NEW;
END;$$;
DROP TRIGGER IF EXISTS guard_supplier_bill_identity_before_write ON public.supplier_bills;
CREATE TRIGGER guard_supplier_bill_identity_before_write BEFORE INSERT OR UPDATE ON public.supplier_bills FOR EACH ROW EXECUTE FUNCTION private.guard_supplier_bill_identity();

CREATE OR REPLACE FUNCTION private.guard_supplier_bill_variance_approval_fields()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
 IF TG_OP='INSERT' THEN
  IF NEW.price_variance_approved_by IS NOT NULL OR NEW.price_variance_approved_at IS NOT NULL OR NEW.price_variance_reason IS NOT NULL THEN
   RAISE EXCEPTION 'Price variance approvals must be created through the approval workflow';
  END IF;
  RETURN NEW;
 END IF;
 IF NEW.price_variance_approved_by IS DISTINCT FROM OLD.price_variance_approved_by OR NEW.price_variance_approved_at IS DISTINCT FROM OLD.price_variance_approved_at OR NEW.price_variance_reason IS DISTINCT FROM OLD.price_variance_reason THEN
  IF COALESCE(current_setting('gold.supplier_bill_variance_workflow',true),'')<>'on' THEN RAISE EXCEPTION 'Price variance approval fields are writable only through the audited approval workflow'; END IF;
  IF NEW.price_variance_approved_by IS NOT NULL AND (NEW.price_variance_approved_by IS DISTINCT FROM auth.uid() OR NEW.price_variance_approved_at IS NULL OR length(trim(coalesce(NEW.price_variance_reason,'')))<5) THEN
   RAISE EXCEPTION 'Variance approval must be attributed to the authenticated approver with a reason';
  END IF;
 END IF;
 RETURN NEW;
END;$$;
DROP TRIGGER IF EXISTS guard_supplier_bill_variance_approval_fields_before_write ON public.supplier_bills;
CREATE TRIGGER guard_supplier_bill_variance_approval_fields_before_write BEFORE INSERT OR UPDATE OF price_variance_approved_by,price_variance_approved_at,price_variance_reason ON public.supplier_bills
 FOR EACH ROW EXECUTE FUNCTION private.guard_supplier_bill_variance_approval_fields();

CREATE OR REPLACE FUNCTION private.invalidate_supplier_bill_variance_approval()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
 PERFORM set_config('gold.supplier_bill_variance_workflow','on',true);
 UPDATE public.supplier_bills SET price_variance_approved_by=NULL,price_variance_approved_at=NULL,price_variance_reason=NULL
 WHERE tenant_id=coalesce(NEW.tenant_id,OLD.tenant_id) AND id IN (coalesce(NEW.supplier_bill_id,OLD.supplier_bill_id),coalesce(OLD.supplier_bill_id,NEW.supplier_bill_id)) AND status='draft' AND purchase_order_id IS NOT NULL;
 PERFORM set_config('gold.supplier_bill_variance_workflow','off',true);
 RETURN coalesce(NEW,OLD);
END;$$;

CREATE OR REPLACE FUNCTION public.approve_supplier_bill_price_variance(p_tenant_id uuid,p_bill_id uuid,p_reason text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE v_bill public.supplier_bills%rowtype;v_count integer;v_variance numeric(14,2);
BEGIN
 IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Authentication required';END IF;
 IF length(trim(coalesce(p_reason,'')))<5 OR length(p_reason)>500 THEN RAISE EXCEPTION 'Provide an approval reason between 5 and 500 characters';END IF;
 SELECT * INTO v_bill FROM public.supplier_bills sb WHERE sb.id=p_bill_id AND sb.tenant_id=p_tenant_id FOR UPDATE;
 IF NOT FOUND OR v_bill.status<>'draft' OR v_bill.purchase_order_id IS NULL THEN RAISE EXCEPTION 'Only PO-linked draft bills can be variance-reviewed';END IF;
 IF NOT private.has_tenant_branch_access(p_tenant_id,v_bill.branch_id,ARRAY['owner','manager']::text[]) THEN RAISE EXCEPTION 'Only a shop owner or manager can approve supplier price variances';END IF;
 IF v_bill.created_by=auth.uid() THEN RAISE EXCEPTION 'The bill creator cannot approve their own purchase price variance';END IF;
 SELECT count(*),coalesce(sum(abs(sbl.unit_cost-pol.unit_cost)*sbl.quantity + abs(sbl.tax_rate-pol.tax_rate)*sbl.quantity*pol.unit_cost/100),0)
 INTO v_count,v_variance FROM public.supplier_bill_lines sbl JOIN public.purchase_order_lines pol ON pol.id=sbl.purchase_order_line_id AND pol.tenant_id=sbl.tenant_id
 WHERE sbl.tenant_id=p_tenant_id AND sbl.supplier_bill_id=p_bill_id AND (abs(sbl.unit_cost-pol.unit_cost)>0.01 OR abs(sbl.tax_rate-pol.tax_rate)>0.001);
 IF v_count=0 THEN RAISE EXCEPTION 'No purchase price or tax variance requires approval';END IF;
 PERFORM set_config('gold.supplier_bill_variance_workflow','on',true);
 UPDATE public.supplier_bills SET price_variance_approved_by=auth.uid(),price_variance_approved_at=now(),price_variance_reason=trim(p_reason),updated_at=now() WHERE id=p_bill_id AND tenant_id=p_tenant_id;
 PERFORM set_config('gold.supplier_bill_variance_workflow','off',true);
 INSERT INTO public.audit_logs(tenant_id,actor_user_id,event_name,entity_type,entity_id,details)
 VALUES(p_tenant_id,auth.uid(),'supplier_bill.price_variance_approved','supplier_bill',p_bill_id::text,jsonb_build_object('purchase_order_id',v_bill.purchase_order_id,'invoice_number',v_bill.supplier_invoice_number,'variance_lines',v_count,'estimated_variance',round(v_variance,2),'reason',trim(p_reason),'bill_creator',v_bill.created_by));
 RETURN jsonb_build_object('id',p_bill_id,'approved_by',auth.uid(),'variance_lines',v_count,'estimated_variance',round(v_variance,2));
END;$$;
REVOKE ALL ON FUNCTION public.approve_supplier_bill_price_variance(uuid,uuid,text) FROM public,anon;
GRANT EXECUTE ON FUNCTION public.approve_supplier_bill_price_variance(uuid,uuid,text) TO authenticated;
