
-- Supplier invoice matching, payables ledger, controlled payments and reversals.
CREATE UNIQUE INDEX IF NOT EXISTS suppliers_tenant_id_unique_idx ON public.suppliers(tenant_id,id);
CREATE UNIQUE INDEX IF NOT EXISTS purchase_order_lines_tenant_id_unique_idx ON public.purchase_order_lines(tenant_id,id);

CREATE TABLE IF NOT EXISTS public.supplier_bills(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE RESTRICT,
 branch_id uuid NOT NULL REFERENCES public.branches(id) ON DELETE RESTRICT,supplier_id uuid NOT NULL,purchase_order_id uuid,
 supplier_invoice_number text,invoice_date date NOT NULL DEFAULT current_date,due_date date,
 status text NOT NULL DEFAULT 'draft' CHECK(status IN('draft','posted','partially_paid','paid','void')),
 subtotal numeric(14,2) NOT NULL DEFAULT 0 CHECK(subtotal>=0),tax_amount numeric(14,2) NOT NULL DEFAULT 0 CHECK(tax_amount>=0),
 total_amount numeric(14,2) NOT NULL DEFAULT 0 CHECK(total_amount>=0),paid_amount numeric(14,2) NOT NULL DEFAULT 0 CHECK(paid_amount>=0 AND paid_amount<=total_amount),
 balance_amount numeric(14,2) GENERATED ALWAYS AS(greatest(total_amount-paid_amount,0)) STORED,
 notes text,source_reference text,created_by uuid NOT NULL DEFAULT auth.uid(),posted_by uuid,posted_at timestamptz,
 voided_by uuid,voided_at timestamptz,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(tenant_id,id),FOREIGN KEY(tenant_id,supplier_id) REFERENCES public.suppliers(tenant_id,id) ON DELETE RESTRICT,
 FOREIGN KEY(tenant_id,purchase_order_id) REFERENCES public.purchase_orders(tenant_id,id) ON DELETE RESTRICT
);
CREATE UNIQUE INDEX IF NOT EXISTS supplier_bills_invoice_number_uidx ON public.supplier_bills(tenant_id,supplier_id,lower(supplier_invoice_number)) WHERE supplier_invoice_number IS NOT NULL;
CREATE INDEX IF NOT EXISTS supplier_bills_branch_status_due_idx ON public.supplier_bills(tenant_id,branch_id,status,due_date);
CREATE INDEX IF NOT EXISTS supplier_bills_supplier_date_idx ON public.supplier_bills(tenant_id,supplier_id,invoice_date DESC);

CREATE TABLE IF NOT EXISTS public.supplier_bill_lines(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE RESTRICT,
 supplier_bill_id uuid NOT NULL,purchase_order_line_id uuid,description text NOT NULL,
 quantity numeric(12,3) NOT NULL CHECK(quantity>0),unit_cost numeric(14,2) NOT NULL CHECK(unit_cost>=0),
 tax_rate numeric(6,3) NOT NULL DEFAULT 0 CHECK(tax_rate>=0 AND tax_rate<=100),
 line_subtotal numeric(14,2) GENERATED ALWAYS AS(round(quantity*unit_cost,2)) STORED,
 tax_amount numeric(14,2) GENERATED ALWAYS AS(round(quantity*unit_cost*tax_rate/100,2)) STORED,
 line_total numeric(14,2) GENERATED ALWAYS AS(round(quantity*unit_cost,2)+round(quantity*unit_cost*tax_rate/100,2)) STORED,
 notes text,created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(tenant_id,id),
 FOREIGN KEY(tenant_id,supplier_bill_id) REFERENCES public.supplier_bills(tenant_id,id) ON DELETE RESTRICT,
 FOREIGN KEY(tenant_id,purchase_order_line_id) REFERENCES public.purchase_order_lines(tenant_id,id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS supplier_bill_lines_bill_idx ON public.supplier_bill_lines(tenant_id,supplier_bill_id);
CREATE INDEX IF NOT EXISTS supplier_bill_lines_po_line_idx ON public.supplier_bill_lines(tenant_id,purchase_order_line_id);

CREATE TABLE IF NOT EXISTS public.supplier_bill_payments(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE RESTRICT,
 supplier_bill_id uuid NOT NULL,payment_number text NOT NULL,amount numeric(14,2) NOT NULL CHECK(amount>0),
 payment_method text NOT NULL CHECK(payment_method IN('cash','bank_transfer','upi','cheque','neft','rtgs','other')),
 payment_reference text,payment_date date NOT NULL DEFAULT current_date,idempotency_key text NOT NULL,
 status text NOT NULL DEFAULT 'confirmed' CHECK(status IN('confirmed','reversed')),created_by uuid NOT NULL,
 reversed_by uuid,reversed_at timestamptz,reversal_reason text,created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(tenant_id,id),UNIQUE(tenant_id,payment_number),UNIQUE(tenant_id,idempotency_key),
 FOREIGN KEY(tenant_id,supplier_bill_id) REFERENCES public.supplier_bills(tenant_id,id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS supplier_bill_payments_bill_date_idx ON public.supplier_bill_payments(tenant_id,supplier_bill_id,payment_date DESC);

ALTER TABLE public.supplier_bills ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.supplier_bill_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.supplier_bill_payments ENABLE ROW LEVEL SECURITY;
GRANT SELECT,INSERT,UPDATE ON public.supplier_bills TO authenticated;
GRANT SELECT,INSERT,UPDATE,DELETE ON public.supplier_bill_lines TO authenticated;
GRANT SELECT ON public.supplier_bill_payments TO authenticated;
REVOKE ALL ON public.supplier_bill_payments FROM public,anon;

DROP POLICY IF EXISTS supplier_bills_branch_read ON public.supplier_bills;
CREATE POLICY supplier_bills_branch_read ON public.supplier_bills FOR SELECT TO authenticated USING(private.has_tenant_branch_access(tenant_id,branch_id,NULL::text[]));
DROP POLICY IF EXISTS supplier_bills_draft_insert ON public.supplier_bills;
CREATE POLICY supplier_bills_draft_insert ON public.supplier_bills FOR INSERT TO authenticated WITH CHECK(status='draft' AND paid_amount=0
 AND private.has_tenant_branch_access(tenant_id,branch_id,ARRAY['owner','manager','accountant']::text[])
 AND EXISTS(SELECT 1 FROM public.suppliers s WHERE s.tenant_id=supplier_bills.tenant_id AND s.id=supplier_id AND s.is_active)
 AND EXISTS(SELECT 1 FROM public.branches b WHERE b.tenant_id=supplier_bills.tenant_id AND b.id=branch_id AND b.is_active));
DROP POLICY IF EXISTS supplier_bills_draft_update ON public.supplier_bills;
CREATE POLICY supplier_bills_draft_update ON public.supplier_bills FOR UPDATE TO authenticated
 USING(status='draft' AND private.has_tenant_branch_access(tenant_id,branch_id,ARRAY['owner','manager','accountant']::text[]))
 WITH CHECK(status='draft' AND paid_amount=0 AND private.has_tenant_branch_access(tenant_id,branch_id,ARRAY['owner','manager','accountant']::text[])
 AND EXISTS(SELECT 1 FROM public.suppliers s WHERE s.tenant_id=supplier_bills.tenant_id AND s.id=supplier_id)
 AND (purchase_order_id IS NULL OR EXISTS(SELECT 1 FROM public.purchase_orders po WHERE po.tenant_id=supplier_bills.tenant_id AND po.id=purchase_order_id AND po.supplier_id=supplier_bills.supplier_id AND po.branch_id=supplier_bills.branch_id)));

DROP POLICY IF EXISTS supplier_bill_lines_branch_read ON public.supplier_bill_lines;
CREATE POLICY supplier_bill_lines_branch_read ON public.supplier_bill_lines FOR SELECT TO authenticated USING(EXISTS(
 SELECT 1 FROM public.supplier_bills sb WHERE sb.id=supplier_bill_id AND sb.tenant_id=supplier_bill_lines.tenant_id AND private.has_tenant_branch_access(sb.tenant_id,sb.branch_id,NULL::text[])));
DROP POLICY IF EXISTS supplier_bill_lines_draft_insert ON public.supplier_bill_lines;
CREATE POLICY supplier_bill_lines_draft_insert ON public.supplier_bill_lines FOR INSERT TO authenticated WITH CHECK(EXISTS(
 SELECT 1 FROM public.supplier_bills sb WHERE sb.id=supplier_bill_id AND sb.tenant_id=supplier_bill_lines.tenant_id AND sb.status='draft'
 AND private.has_tenant_branch_access(sb.tenant_id,sb.branch_id,ARRAY['owner','manager','accountant']::text[])));
DROP POLICY IF EXISTS supplier_bill_lines_draft_update ON public.supplier_bill_lines;
CREATE POLICY supplier_bill_lines_draft_update ON public.supplier_bill_lines FOR UPDATE TO authenticated USING(EXISTS(
 SELECT 1 FROM public.supplier_bills sb WHERE sb.id=supplier_bill_id AND sb.tenant_id=supplier_bill_lines.tenant_id AND sb.status='draft'
 AND private.has_tenant_branch_access(sb.tenant_id,sb.branch_id,ARRAY['owner','manager','accountant']::text[])))
 WITH CHECK(EXISTS(SELECT 1 FROM public.supplier_bills sb WHERE sb.id=supplier_bill_id AND sb.tenant_id=supplier_bill_lines.tenant_id AND sb.status='draft'
 AND private.has_tenant_branch_access(sb.tenant_id,sb.branch_id,ARRAY['owner','manager','accountant']::text[])));
DROP POLICY IF EXISTS supplier_bill_lines_draft_delete ON public.supplier_bill_lines;
CREATE POLICY supplier_bill_lines_draft_delete ON public.supplier_bill_lines FOR DELETE TO authenticated USING(EXISTS(
 SELECT 1 FROM public.supplier_bills sb WHERE sb.id=supplier_bill_id AND sb.tenant_id=supplier_bill_lines.tenant_id AND sb.status='draft'
 AND private.has_tenant_branch_access(sb.tenant_id,sb.branch_id,ARRAY['owner','manager','accountant']::text[])));
DROP POLICY IF EXISTS supplier_bill_payments_branch_read ON public.supplier_bill_payments;
CREATE POLICY supplier_bill_payments_branch_read ON public.supplier_bill_payments FOR SELECT TO authenticated USING(EXISTS(
 SELECT 1 FROM public.supplier_bills sb WHERE sb.id=supplier_bill_id AND sb.tenant_id=supplier_bill_payments.tenant_id AND private.has_tenant_branch_access(sb.tenant_id,sb.branch_id,NULL::text[])));

CREATE OR REPLACE FUNCTION private.guard_supplier_bill_line()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE v_bill public.supplier_bills%rowtype;
BEGIN
 SELECT * INTO v_bill FROM public.supplier_bills sb WHERE sb.id=coalesce(NEW.supplier_bill_id,OLD.supplier_bill_id) AND sb.tenant_id=coalesce(NEW.tenant_id,OLD.tenant_id);
 IF NOT FOUND OR v_bill.status<>'draft' THEN RAISE EXCEPTION 'Supplier invoice lines can only change while the bill is a draft';END IF;
 IF TG_OP<>'DELETE' THEN
  IF length(trim(coalesce(NEW.description,'')))<2 OR length(NEW.description)>250 THEN RAISE EXCEPTION 'Enter a bill line description between 2 and 250 characters';END IF;
  IF NEW.purchase_order_line_id IS NOT NULL AND v_bill.purchase_order_id IS NULL THEN RAISE EXCEPTION 'A PO line cannot be matched when the bill has no purchase order';END IF;
  IF NEW.purchase_order_line_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.purchase_order_lines pol WHERE pol.tenant_id=NEW.tenant_id AND pol.id=NEW.purchase_order_line_id AND pol.purchase_order_id=v_bill.purchase_order_id) THEN RAISE EXCEPTION 'Matched purchase-order line must belong to the selected order';END IF;
  RETURN NEW;
 END IF;RETURN OLD;
END;$$;
DROP TRIGGER IF EXISTS guard_supplier_bill_line_before_write ON public.supplier_bill_lines;
CREATE TRIGGER guard_supplier_bill_line_before_write BEFORE INSERT OR UPDATE OR DELETE ON public.supplier_bill_lines FOR EACH ROW EXECUTE FUNCTION private.guard_supplier_bill_line();

CREATE OR REPLACE FUNCTION private.guard_supplier_bill_status()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
 IF OLD.status IS DISTINCT FROM NEW.status AND COALESCE(current_setting('gold.supplier_bill_workflow',true),'')<>'on' THEN RAISE EXCEPTION 'Supplier bill status must be changed through the audited workflow';END IF;
 IF NEW.paid_amount IS DISTINCT FROM OLD.paid_amount AND COALESCE(current_setting('gold.supplier_bill_workflow',true),'')<>'on' THEN RAISE EXCEPTION 'Supplier bill balance must be changed through supplier payment workflow';END IF;
 RETURN NEW;
END;$$;
DROP TRIGGER IF EXISTS guard_supplier_bill_status_before_update ON public.supplier_bills;
CREATE TRIGGER guard_supplier_bill_status_before_update BEFORE UPDATE OF status,paid_amount ON public.supplier_bills FOR EACH ROW EXECUTE FUNCTION private.guard_supplier_bill_status();

CREATE OR REPLACE FUNCTION public.post_supplier_bill(p_tenant_id uuid,p_bill_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE v_bill public.supplier_bills%rowtype;v_count integer;v_subtotal numeric(14,2);v_tax numeric(14,2);v_total numeric(14,2);v_matched integer;
BEGIN
 IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Authentication required';END IF;
 SELECT * INTO v_bill FROM public.supplier_bills sb WHERE sb.id=p_bill_id AND sb.tenant_id=p_tenant_id FOR UPDATE;
 IF NOT FOUND OR v_bill.status<>'draft' THEN RAISE EXCEPTION 'Only draft supplier bills can be posted';END IF;
 IF NOT private.has_tenant_branch_access(p_tenant_id,v_bill.branch_id,ARRAY['owner','manager','accountant']::text[]) THEN RAISE EXCEPTION 'Accounts-payable access denied';END IF;
 IF length(trim(coalesce(v_bill.supplier_invoice_number,'')))<2 OR length(v_bill.supplier_invoice_number)>120 THEN RAISE EXCEPTION 'Supplier invoice number is required before posting';END IF;
 IF v_bill.purchase_order_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.purchase_orders po WHERE po.id=v_bill.purchase_order_id AND po.tenant_id=p_tenant_id AND po.supplier_id=v_bill.supplier_id AND po.branch_id=v_bill.branch_id) THEN RAISE EXCEPTION 'Purchase order supplier and branch must match the bill';END IF;
 SELECT count(*),coalesce(sum(line_subtotal),0),coalesce(sum(tax_amount),0),coalesce(sum(line_total),0),count(*) FILTER(WHERE purchase_order_line_id IS NOT NULL)
 INTO v_count,v_subtotal,v_tax,v_total,v_matched FROM public.supplier_bill_lines WHERE tenant_id=p_tenant_id AND supplier_bill_id=p_bill_id;
 IF v_count=0 THEN RAISE EXCEPTION 'Add at least one supplier invoice line';END IF;
 IF v_bill.purchase_order_id IS NOT NULL AND v_matched<>v_count THEN RAISE EXCEPTION 'Every invoice line must be matched to a line from the linked purchase order';END IF;
 IF v_bill.purchase_order_id IS NULL AND v_matched>0 THEN RAISE EXCEPTION 'Non-PO bills cannot contain matched PO lines';END IF;
 IF v_bill.purchase_order_id IS NOT NULL AND EXISTS(
  SELECT 1 FROM (SELECT purchase_order_line_id,sum(quantity) bill_qty FROM public.supplier_bill_lines
   WHERE tenant_id=p_tenant_id AND supplier_bill_id=p_bill_id AND purchase_order_line_id IS NOT NULL GROUP BY purchase_order_line_id) cur
  JOIN public.purchase_order_lines pol ON pol.id=cur.purchase_order_line_id AND pol.tenant_id=p_tenant_id
  WHERE cur.bill_qty+coalesce((SELECT sum(ol.quantity) FROM public.supplier_bill_lines ol JOIN public.supplier_bills ob ON ob.id=ol.supplier_bill_id AND ob.tenant_id=ol.tenant_id
   WHERE ol.tenant_id=p_tenant_id AND ol.purchase_order_line_id=cur.purchase_order_line_id AND ob.id<>p_bill_id AND ob.status IN('posted','partially_paid','paid')),0)>pol.received_quantity
 ) THEN RAISE EXCEPTION 'Invoice quantity exceeds received quantity or has already been billed';END IF;
 PERFORM set_config('gold.supplier_bill_workflow','on',true);
 UPDATE public.supplier_bills SET status='posted',subtotal=v_subtotal,tax_amount=v_tax,total_amount=v_total,paid_amount=0,posted_by=auth.uid(),posted_at=now(),updated_at=now() WHERE id=p_bill_id AND tenant_id=p_tenant_id;
 PERFORM set_config('gold.supplier_bill_workflow','off',true);
 INSERT INTO public.audit_logs(tenant_id,actor_user_id,event_name,entity_type,entity_id,details) VALUES(p_tenant_id,auth.uid(),'supplier_bill.posted','supplier_bill',p_bill_id::text,
 jsonb_build_object('supplier_id',v_bill.supplier_id,'supplier_invoice_number',v_bill.supplier_invoice_number,'purchase_order_id',v_bill.purchase_order_id,'subtotal',v_subtotal,'tax_amount',v_tax,'total_amount',v_total,'matched_lines',v_matched));
 RETURN jsonb_build_object('id',p_bill_id,'status','posted','subtotal',v_subtotal,'tax_amount',v_tax,'total_amount',v_total);
END;$$;

CREATE OR REPLACE FUNCTION public.record_supplier_bill_payment(p_tenant_id uuid,p_bill_id uuid,p_amount numeric,p_payment_method text,p_payment_reference text,p_payment_date date,p_idempotency_key text)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE v_bill public.supplier_bills%rowtype;v_old public.supplier_bill_payments%rowtype;v_id uuid;v_number text;v_balance numeric(14,2);
BEGIN
 IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Authentication required';END IF;
 IF p_amount IS NULL OR p_amount<=0 THEN RAISE EXCEPTION 'Payment amount must be greater than zero';END IF;
 IF p_payment_method NOT IN('cash','bank_transfer','upi','cheque','neft','rtgs','other') THEN RAISE EXCEPTION 'Choose a supported supplier payment method';END IF;
 IF p_idempotency_key IS NULL OR length(trim(p_idempotency_key))<8 OR length(p_idempotency_key)>160 THEN RAISE EXCEPTION 'Payment idempotency key is required';END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(p_tenant_id::text||':'||p_idempotency_key,0));
 SELECT * INTO v_old FROM public.supplier_bill_payments WHERE tenant_id=p_tenant_id AND idempotency_key=p_idempotency_key;
 IF FOUND THEN
  IF v_old.supplier_bill_id<>p_bill_id OR v_old.amount<>p_amount OR v_old.payment_method<>p_payment_method OR coalesce(v_old.payment_reference,'')<>coalesce(p_payment_reference,'') THEN RAISE EXCEPTION 'Idempotency key was already used for a different supplier payment';END IF;
  RETURN v_old.id;
 END IF;
 SELECT * INTO v_bill FROM public.supplier_bills WHERE id=p_bill_id AND tenant_id=p_tenant_id FOR UPDATE;
 IF NOT FOUND OR v_bill.status NOT IN('posted','partially_paid') THEN RAISE EXCEPTION 'Only posted supplier bills with an outstanding balance can be paid';END IF;
 IF NOT private.has_tenant_branch_access(p_tenant_id,v_bill.branch_id,ARRAY['owner','manager','accountant']::text[]) THEN RAISE EXCEPTION 'Accounts-payable access denied';END IF;
 v_balance:=v_bill.total_amount-v_bill.paid_amount;IF p_amount>v_balance THEN RAISE EXCEPTION 'Payment exceeds current balance of %',v_balance;END IF;
 v_number:='SP-'||to_char(now() AT TIME ZONE 'Asia/Kolkata','YYYYMMDD')||'-'||upper(substr(replace(gen_random_uuid()::text,'-',''),1,6));
 INSERT INTO public.supplier_bill_payments(tenant_id,supplier_bill_id,payment_number,amount,payment_method,payment_reference,payment_date,idempotency_key,status,created_by)
 VALUES(p_tenant_id,p_bill_id,v_number,p_amount,p_payment_method,nullif(trim(coalesce(p_payment_reference,'')),''),coalesce(p_payment_date,current_date),p_idempotency_key,'confirmed',auth.uid()) RETURNING id INTO v_id;
 PERFORM set_config('gold.supplier_bill_workflow','on',true);
 UPDATE public.supplier_bills SET paid_amount=paid_amount+p_amount,status=CASE WHEN paid_amount+p_amount>=total_amount THEN 'paid' ELSE 'partially_paid' END,updated_at=now() WHERE id=p_bill_id AND tenant_id=p_tenant_id;
 PERFORM set_config('gold.supplier_bill_workflow','off',true);
 INSERT INTO public.audit_logs(tenant_id,actor_user_id,event_name,entity_type,entity_id,details) VALUES(p_tenant_id,auth.uid(),'supplier_bill.payment_recorded','supplier_bill',p_bill_id::text,jsonb_build_object('payment_id',v_id,'payment_number',v_number,'amount',p_amount,'method',p_payment_method,'reference',p_payment_reference));
 RETURN v_id;
END;$$;

CREATE OR REPLACE FUNCTION public.reverse_supplier_bill_payment(p_tenant_id uuid,p_payment_id uuid,p_reason text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE v_payment public.supplier_bill_payments%rowtype;v_bill public.supplier_bills%rowtype;
BEGIN
 IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Authentication required';END IF;
 IF length(trim(coalesce(p_reason,'')))<5 OR length(p_reason)>500 THEN RAISE EXCEPTION 'Provide a reversal reason between 5 and 500 characters';END IF;
 SELECT * INTO v_payment FROM public.supplier_bill_payments WHERE id=p_payment_id AND tenant_id=p_tenant_id FOR UPDATE;
 IF NOT FOUND OR v_payment.status<>'confirmed' THEN RAISE EXCEPTION 'Only confirmed supplier payments can be reversed';END IF;
 SELECT * INTO v_bill FROM public.supplier_bills WHERE id=v_payment.supplier_bill_id AND tenant_id=p_tenant_id FOR UPDATE;
 IF NOT FOUND OR NOT private.has_tenant_branch_access(p_tenant_id,v_bill.branch_id,ARRAY['owner','manager','accountant']::text[]) THEN RAISE EXCEPTION 'Accounts-payable access denied';END IF;
 PERFORM set_config('gold.supplier_bill_workflow','on',true);
 UPDATE public.supplier_bill_payments SET status='reversed',reversed_by=auth.uid(),reversed_at=now(),reversal_reason=trim(p_reason) WHERE id=p_payment_id AND tenant_id=p_tenant_id;
 UPDATE public.supplier_bills SET paid_amount=greatest(paid_amount-v_payment.amount,0),status=CASE WHEN greatest(paid_amount-v_payment.amount,0)<=0 THEN 'posted' ELSE 'partially_paid' END,updated_at=now() WHERE id=v_bill.id AND tenant_id=p_tenant_id;
 PERFORM set_config('gold.supplier_bill_workflow','off',true);
 INSERT INTO public.audit_logs(tenant_id,actor_user_id,event_name,entity_type,entity_id,details) VALUES(p_tenant_id,auth.uid(),'supplier_bill.payment_reversed','supplier_bill',v_bill.id::text,jsonb_build_object('payment_id',p_payment_id,'amount',v_payment.amount,'reason',trim(p_reason)));
 RETURN jsonb_build_object('payment_id',p_payment_id,'status','reversed','amount',v_payment.amount);
END;$$;

REVOKE ALL ON FUNCTION public.post_supplier_bill(uuid,uuid) FROM public,anon;
REVOKE ALL ON FUNCTION public.record_supplier_bill_payment(uuid,uuid,numeric,text,text,date,text) FROM public,anon;
REVOKE ALL ON FUNCTION public.reverse_supplier_bill_payment(uuid,uuid,text) FROM public,anon;
GRANT EXECUTE ON FUNCTION public.post_supplier_bill(uuid,uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.record_supplier_bill_payment(uuid,uuid,numeric,text,text,date,text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.reverse_supplier_bill_payment(uuid,uuid,text) TO authenticated;
