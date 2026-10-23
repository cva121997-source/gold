
CREATE OR REPLACE FUNCTION private.guard_supplier_bill_identity()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
 IF TG_OP='INSERT' THEN
  IF auth.uid() IS NULL OR NEW.created_by IS DISTINCT FROM auth.uid() THEN RAISE EXCEPTION 'Supplier bill creator must match the authenticated user'; END IF;
  IF NEW.status<>'draft' OR NEW.paid_amount<>0 OR NEW.price_variance_approved_by IS NOT NULL OR NEW.price_variance_approved_at IS NOT NULL OR NEW.price_variance_reason IS NOT NULL OR NEW.posted_by IS NOT NULL OR NEW.posted_at IS NOT NULL OR NEW.voided_by IS NOT NULL OR NEW.voided_at IS NOT NULL THEN RAISE EXCEPTION 'New supplier bills must start as unapproved drafts'; END IF;
  RETURN NEW;
 END IF;
 IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id OR NEW.branch_id IS DISTINCT FROM OLD.branch_id OR NEW.supplier_id IS DISTINCT FROM OLD.supplier_id
  OR NEW.purchase_order_id IS DISTINCT FROM OLD.purchase_order_id OR NEW.created_by IS DISTINCT FROM OLD.created_by THEN
  RAISE EXCEPTION 'Supplier bill tenant, branch, supplier, purchase-order link and creator are immutable';
 END IF;
 IF (NEW.posted_by IS DISTINCT FROM OLD.posted_by OR NEW.posted_at IS DISTINCT FROM OLD.posted_at
  OR NEW.voided_by IS DISTINCT FROM OLD.voided_by OR NEW.voided_at IS DISTINCT FROM OLD.voided_at)
  AND COALESCE(current_setting('gold.supplier_bill_workflow',true),'')<>'on' THEN
  RAISE EXCEPTION 'Posting and void audit fields are writable only through the audited supplier bill workflow';
 END IF;
 RETURN NEW;
END;$$;
DROP TRIGGER IF EXISTS guard_supplier_bill_identity_before_write ON public.supplier_bills;
CREATE TRIGGER guard_supplier_bill_identity_before_write BEFORE INSERT OR UPDATE ON public.supplier_bills FOR EACH ROW EXECUTE FUNCTION private.guard_supplier_bill_identity();
