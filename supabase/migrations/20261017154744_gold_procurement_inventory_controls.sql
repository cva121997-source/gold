-- Purchase order and individually traceable stock-receipt workflow.
ALTER TABLE public.inventory_items
  ADD COLUMN IF NOT EXISTS barcode text,
  ADD COLUMN IF NOT EXISTS huid text,
  ADD COLUMN IF NOT EXISTS purity_id smallint REFERENCES public.purity_definitions(id),
  ADD COLUMN IF NOT EXISTS gross_weight_grams numeric(12,3),
  ADD COLUMN IF NOT EXISTS net_metal_weight_grams numeric(12,3),
  ADD COLUMN IF NOT EXISTS stone_weight_grams numeric(12,3),
  ADD COLUMN IF NOT EXISTS hallmark_details jsonb NOT NULL DEFAULT '{}'::jsonb;

CREATE UNIQUE INDEX IF NOT EXISTS inventory_items_tenant_item_code_uidx ON public.inventory_items(tenant_id,item_code);
CREATE UNIQUE INDEX IF NOT EXISTS inventory_items_tenant_barcode_uidx ON public.inventory_items(tenant_id,barcode) WHERE barcode IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS inventory_items_tenant_huid_uidx ON public.inventory_items(tenant_id,huid) WHERE huid IS NOT NULL;

CREATE TABLE IF NOT EXISTS public.purchase_orders (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE RESTRICT,
 branch_id uuid NOT NULL REFERENCES public.branches(id) ON DELETE RESTRICT,
 supplier_id uuid NOT NULL REFERENCES public.suppliers(id) ON DELETE RESTRICT, po_number text NOT NULL,
 status text NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','ordered','partially_received','received','cancelled')),
 order_date date NOT NULL DEFAULT current_date, expected_delivery_date date, supplier_invoice_number text,
 subtotal numeric(14,2) NOT NULL DEFAULT 0 CHECK(subtotal>=0), tax_amount numeric(14,2) NOT NULL DEFAULT 0 CHECK(tax_amount>=0),
 total_amount numeric(14,2) NOT NULL DEFAULT 0 CHECK(total_amount>=0), notes text, created_by uuid DEFAULT auth.uid(),
 ordered_at timestamptz, received_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(), UNIQUE(tenant_id,po_number), UNIQUE(tenant_id,id)
);

CREATE TABLE IF NOT EXISTS public.purchase_order_lines (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE RESTRICT,
 purchase_order_id uuid NOT NULL, line_number integer NOT NULL CHECK(line_number>0),
 product_id uuid NOT NULL REFERENCES public.products(id) ON DELETE RESTRICT, product_code text NOT NULL,
 description text NOT NULL, ordered_quantity integer NOT NULL CHECK(ordered_quantity>0),
 received_quantity integer NOT NULL DEFAULT 0 CHECK(received_quantity>=0 AND received_quantity<=ordered_quantity),
 gross_weight_grams numeric(12,3) NOT NULL DEFAULT 0 CHECK(gross_weight_grams>=0),
 net_metal_weight_grams numeric(12,3) NOT NULL DEFAULT 0 CHECK(net_metal_weight_grams>=0),
 stone_weight_grams numeric(12,3) NOT NULL DEFAULT 0 CHECK(stone_weight_grams>=0),
 purity_id smallint REFERENCES public.purity_definitions(id), unit_cost numeric(14,2) NOT NULL CHECK(unit_cost>=0),
 tax_rate numeric(6,3) NOT NULL DEFAULT 0 CHECK(tax_rate>=0 AND tax_rate<=100),
 line_subtotal numeric(14,2) GENERATED ALWAYS AS (round(ordered_quantity*unit_cost,2)) STORED,
 tax_amount numeric(14,2) GENERATED ALWAYS AS (round(ordered_quantity*unit_cost*tax_rate/100,2)) STORED,
 line_total numeric(14,2) GENERATED ALWAYS AS (round(ordered_quantity*unit_cost,2)+round(ordered_quantity*unit_cost*tax_rate/100,2)) STORED,
 created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(tenant_id,purchase_order_id,line_number),
 FOREIGN KEY(tenant_id,purchase_order_id) REFERENCES public.purchase_orders(tenant_id,id) ON DELETE RESTRICT,
 CHECK(net_metal_weight_grams+stone_weight_grams<=gross_weight_grams+0.001)
);

CREATE TABLE IF NOT EXISTS public.goods_receipts (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE RESTRICT,
 branch_id uuid NOT NULL REFERENCES public.branches(id) ON DELETE RESTRICT, purchase_order_id uuid NOT NULL,
 receipt_number text NOT NULL, supplier_invoice_number text, idempotency_key text NOT NULL,
 status text NOT NULL DEFAULT 'posted' CHECK(status IN ('posted','void')), item_count integer NOT NULL DEFAULT 0 CHECK(item_count>=0),
 received_at timestamptz NOT NULL DEFAULT now(), created_by uuid NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(tenant_id,receipt_number), UNIQUE(tenant_id,idempotency_key), UNIQUE(tenant_id,id),
 FOREIGN KEY(tenant_id,purchase_order_id) REFERENCES public.purchase_orders(tenant_id,id) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS public.goods_receipt_lines (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE RESTRICT,
 goods_receipt_id uuid NOT NULL REFERENCES public.goods_receipts(id) ON DELETE RESTRICT,
 purchase_order_line_id uuid NOT NULL REFERENCES public.purchase_order_lines(id) ON DELETE RESTRICT,
 inventory_item_id uuid NOT NULL REFERENCES public.inventory_items(id) ON DELETE RESTRICT,
 quantity integer NOT NULL DEFAULT 1 CHECK(quantity=1), purchase_cost numeric(14,2) NOT NULL CHECK(purchase_cost>=0),
 gross_weight_grams numeric(12,3) NOT NULL CHECK(gross_weight_grams>0),
 net_metal_weight_grams numeric(12,3) NOT NULL CHECK(net_metal_weight_grams>=0),
 stone_weight_grams numeric(12,3) NOT NULL CHECK(stone_weight_grams>=0),
 created_at timestamptz NOT NULL DEFAULT now(),
 CHECK(net_metal_weight_grams+stone_weight_grams<=gross_weight_grams+0.001)
);

CREATE INDEX IF NOT EXISTS purchase_orders_branch_status_date_idx ON public.purchase_orders(tenant_id,branch_id,status,order_date DESC);
CREATE INDEX IF NOT EXISTS purchase_order_lines_order_idx ON public.purchase_order_lines(tenant_id,purchase_order_id,line_number);
CREATE INDEX IF NOT EXISTS goods_receipts_order_date_idx ON public.goods_receipts(tenant_id,purchase_order_id,received_at DESC);
CREATE INDEX IF NOT EXISTS goods_receipt_lines_inventory_idx ON public.goods_receipt_lines(tenant_id,inventory_item_id);

ALTER TABLE public.purchase_orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.purchase_order_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.goods_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.goods_receipt_lines ENABLE ROW LEVEL SECURITY;
GRANT SELECT,INSERT,UPDATE ON public.purchase_orders TO authenticated;
GRANT SELECT,INSERT,UPDATE,DELETE ON public.purchase_order_lines TO authenticated;
GRANT SELECT ON public.goods_receipts,public.goods_receipt_lines TO authenticated;
REVOKE ALL ON public.goods_receipts,public.goods_receipt_lines FROM anon;

DROP POLICY IF EXISTS purchase_orders_branch_read ON public.purchase_orders;
CREATE POLICY purchase_orders_branch_read ON public.purchase_orders FOR SELECT TO authenticated USING(private.has_tenant_branch_access(tenant_id,branch_id,NULL::text[]));
DROP POLICY IF EXISTS purchase_orders_draft_insert ON public.purchase_orders;
CREATE POLICY purchase_orders_draft_insert ON public.purchase_orders FOR INSERT TO authenticated WITH CHECK(
 status='draft' AND private.has_tenant_branch_access(tenant_id,branch_id,ARRAY['owner','manager','accountant','inventory_manager']::text[])
 AND EXISTS(SELECT 1 FROM public.branches b WHERE b.id=branch_id AND b.tenant_id=purchase_orders.tenant_id AND b.is_active)
 AND EXISTS(SELECT 1 FROM public.suppliers s WHERE s.id=supplier_id AND s.tenant_id=purchase_orders.tenant_id AND s.is_active));
DROP POLICY IF EXISTS purchase_orders_draft_update ON public.purchase_orders;
CREATE POLICY purchase_orders_draft_update ON public.purchase_orders FOR UPDATE TO authenticated
 USING(status='draft' AND private.has_tenant_branch_access(tenant_id,branch_id,ARRAY['owner','manager','accountant','inventory_manager']::text[]))
 WITH CHECK(status='draft' AND private.has_tenant_branch_access(tenant_id,branch_id,ARRAY['owner','manager','accountant','inventory_manager']::text[])
 AND EXISTS(SELECT 1 FROM public.suppliers s WHERE s.id=supplier_id AND s.tenant_id=purchase_orders.tenant_id AND s.is_active));
DROP POLICY IF EXISTS purchase_order_lines_branch_read ON public.purchase_order_lines;
CREATE POLICY purchase_order_lines_branch_read ON public.purchase_order_lines FOR SELECT TO authenticated
 USING(EXISTS(SELECT 1 FROM public.purchase_orders po WHERE po.id=purchase_order_id AND po.tenant_id=purchase_order_lines.tenant_id AND private.has_tenant_branch_access(po.tenant_id,po.branch_id,NULL::text[])));
DROP POLICY IF EXISTS purchase_order_lines_draft_insert ON public.purchase_order_lines;
CREATE POLICY purchase_order_lines_draft_insert ON public.purchase_order_lines FOR INSERT TO authenticated WITH CHECK(
 EXISTS(SELECT 1 FROM public.purchase_orders po WHERE po.id=purchase_order_id AND po.tenant_id=purchase_order_lines.tenant_id AND po.status='draft'
 AND private.has_tenant_branch_access(po.tenant_id,po.branch_id,ARRAY['owner','manager','accountant','inventory_manager']::text[])));
DROP POLICY IF EXISTS purchase_order_lines_draft_update ON public.purchase_order_lines;
CREATE POLICY purchase_order_lines_draft_update ON public.purchase_order_lines FOR UPDATE TO authenticated
 USING(EXISTS(SELECT 1 FROM public.purchase_orders po WHERE po.id=purchase_order_id AND po.tenant_id=purchase_order_lines.tenant_id AND po.status='draft'
 AND private.has_tenant_branch_access(po.tenant_id,po.branch_id,ARRAY['owner','manager','accountant','inventory_manager']::text[])))
 WITH CHECK(EXISTS(SELECT 1 FROM public.purchase_orders po WHERE po.id=purchase_order_id AND po.tenant_id=purchase_order_lines.tenant_id AND po.status='draft'
 AND private.has_tenant_branch_access(po.tenant_id,po.branch_id,ARRAY['owner','manager','accountant','inventory_manager']::text[])));
DROP POLICY IF EXISTS purchase_order_lines_draft_delete ON public.purchase_order_lines;
CREATE POLICY purchase_order_lines_draft_delete ON public.purchase_order_lines FOR DELETE TO authenticated
 USING(EXISTS(SELECT 1 FROM public.purchase_orders po WHERE po.id=purchase_order_id AND po.tenant_id=purchase_order_lines.tenant_id AND po.status='draft'
 AND private.has_tenant_branch_access(po.tenant_id,po.branch_id,ARRAY['owner','manager','accountant','inventory_manager']::text[])));
DROP POLICY IF EXISTS goods_receipts_branch_read ON public.goods_receipts;
CREATE POLICY goods_receipts_branch_read ON public.goods_receipts FOR SELECT TO authenticated USING(private.has_tenant_branch_access(tenant_id,branch_id,NULL::text[]));
DROP POLICY IF EXISTS goods_receipt_lines_branch_read ON public.goods_receipt_lines;
CREATE POLICY goods_receipt_lines_branch_read ON public.goods_receipt_lines FOR SELECT TO authenticated USING(
 EXISTS(SELECT 1 FROM public.goods_receipts gr WHERE gr.id=goods_receipt_id AND gr.tenant_id=goods_receipt_lines.tenant_id AND private.has_tenant_branch_access(gr.tenant_id,gr.branch_id,NULL::text[])));

CREATE OR REPLACE FUNCTION private.guard_purchase_order_line()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE v_status text;
BEGIN
 SELECT po.status INTO v_status FROM public.purchase_orders po WHERE po.id=NEW.purchase_order_id AND po.tenant_id=NEW.tenant_id;
 IF NOT FOUND OR v_status<>'draft' THEN RAISE EXCEPTION 'Purchase order lines can only be changed while the order is a draft'; END IF;
 IF NOT EXISTS(SELECT 1 FROM public.products p WHERE p.id=NEW.product_id AND p.tenant_id=NEW.tenant_id AND p.is_active) THEN RAISE EXCEPTION 'Product must be active and belong to this shop'; END IF;
 IF NEW.net_metal_weight_grams+NEW.stone_weight_grams>NEW.gross_weight_grams+0.001 THEN RAISE EXCEPTION 'Net metal weight plus stone weight cannot exceed gross weight'; END IF;
 RETURN NEW;
END; $$;
DROP TRIGGER IF EXISTS guard_purchase_order_line_before_write ON public.purchase_order_lines;
CREATE TRIGGER guard_purchase_order_line_before_write BEFORE INSERT OR UPDATE ON public.purchase_order_lines FOR EACH ROW EXECUTE FUNCTION private.guard_purchase_order_line();

CREATE OR REPLACE FUNCTION private.guard_purchase_order_status()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
 IF OLD.status IS DISTINCT FROM NEW.status AND COALESCE(current_setting('gold.purchase_workflow',true),'')<>'on' THEN RAISE EXCEPTION 'Change purchase-order status through the validated workflow'; END IF;
 RETURN NEW;
END; $$;
DROP TRIGGER IF EXISTS guard_purchase_order_status_before_update ON public.purchase_orders;
CREATE TRIGGER guard_purchase_order_status_before_update BEFORE UPDATE OF status ON public.purchase_orders FOR EACH ROW EXECUTE FUNCTION private.guard_purchase_order_status();

CREATE OR REPLACE FUNCTION public.submit_purchase_order(p_tenant_id uuid,p_order_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE v_order public.purchase_orders%rowtype; v_count integer; v_subtotal numeric(14,2); v_tax numeric(14,2);
BEGIN
 IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Authentication required'; END IF;
 SELECT * INTO v_order FROM public.purchase_orders po WHERE po.id=p_order_id AND po.tenant_id=p_tenant_id FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Purchase order not found'; END IF;
 IF NOT private.has_tenant_branch_access(p_tenant_id,v_order.branch_id,ARRAY['owner','manager','accountant','inventory_manager']::text[]) THEN RAISE EXCEPTION 'You do not have permission to submit this purchase order'; END IF;
 IF v_order.status<>'draft' THEN RAISE EXCEPTION 'Only draft purchase orders can be submitted'; END IF;
 SELECT count(*),COALESCE(sum(pol.line_subtotal),0),COALESCE(sum(pol.tax_amount),0) INTO v_count,v_subtotal,v_tax FROM public.purchase_order_lines pol WHERE pol.tenant_id=p_tenant_id AND pol.purchase_order_id=p_order_id;
 IF v_count=0 THEN RAISE EXCEPTION 'Add at least one product before submitting'; END IF;
 PERFORM set_config('gold.purchase_workflow','on',true);
 UPDATE public.purchase_orders SET status='ordered',subtotal=v_subtotal,tax_amount=v_tax,total_amount=v_subtotal+v_tax,ordered_at=now(),updated_at=now() WHERE id=p_order_id AND tenant_id=p_tenant_id;
 PERFORM set_config('gold.purchase_workflow','off',true);
 INSERT INTO public.audit_logs(tenant_id,actor_user_id,event_name,entity_type,entity_id,details) VALUES(p_tenant_id,auth.uid(),'purchase_order.submitted','purchase_order',p_order_id::text,jsonb_build_object('po_number',v_order.po_number,'lines',v_count,'total_amount',v_subtotal+v_tax));
 RETURN jsonb_build_object('id',p_order_id,'status','ordered','subtotal',v_subtotal,'tax_amount',v_tax,'total_amount',v_subtotal+v_tax);
END; $$;

CREATE OR REPLACE FUNCTION public.receive_purchase_order(p_tenant_id uuid,p_order_id uuid,p_supplier_invoice_number text,p_idempotency_key text,p_items jsonb)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE
 v_order public.purchase_orders%rowtype; v_line public.purchase_order_lines%rowtype; v_product public.products%rowtype;
 v_item jsonb; v_receipt_id uuid; v_inventory_item_id uuid; v_receipt_number text; v_item_code text; v_serial text; v_barcode text; v_huid text;
 v_gross numeric(12,3); v_net numeric(12,3); v_stone numeric(12,3); v_cost numeric(14,2); v_count integer; v_remaining boolean; v_new_status text;
BEGIN
 IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Authentication required'; END IF;
 IF p_idempotency_key IS NULL OR length(trim(p_idempotency_key))<8 OR length(p_idempotency_key)>160 THEN RAISE EXCEPTION 'A valid idempotency key is required'; END IF;
 IF p_items IS NULL OR jsonb_typeof(p_items)<>'array' THEN RAISE EXCEPTION 'Receipt items must be a JSON array'; END IF;
 v_count:=jsonb_array_length(p_items); IF v_count<1 OR v_count>300 THEN RAISE EXCEPTION 'Receive between 1 and 300 individual items per receipt'; END IF;
 SELECT * INTO v_order FROM public.purchase_orders po WHERE po.id=p_order_id AND po.tenant_id=p_tenant_id FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Purchase order not found'; END IF;
 IF NOT private.has_tenant_branch_access(p_tenant_id,v_order.branch_id,ARRAY['owner','manager','inventory_manager']::text[]) THEN RAISE EXCEPTION 'You do not have permission to receive stock for this branch'; END IF;
 IF v_order.status NOT IN ('ordered','partially_received') THEN RAISE EXCEPTION 'Only submitted purchase orders can receive stock'; END IF;
 v_receipt_number:='GR-'||upper(substr(replace(gen_random_uuid()::text,'-',''),1,10));
 INSERT INTO public.goods_receipts(tenant_id,branch_id,purchase_order_id,receipt_number,supplier_invoice_number,idempotency_key,status,item_count,created_by)
 VALUES(p_tenant_id,v_order.branch_id,p_order_id,v_receipt_number,nullif(trim(coalesce(p_supplier_invoice_number,'')),''),p_idempotency_key,'posted',0,auth.uid())
 ON CONFLICT(tenant_id,idempotency_key) DO NOTHING RETURNING id INTO v_receipt_id;
 IF v_receipt_id IS NULL THEN SELECT gr.id INTO v_receipt_id FROM public.goods_receipts gr WHERE gr.tenant_id=p_tenant_id AND gr.idempotency_key=p_idempotency_key; RETURN v_receipt_id; END IF;
 FOR v_item IN SELECT value FROM jsonb_array_elements(p_items)
 LOOP
  SELECT * INTO v_line FROM public.purchase_order_lines pol WHERE pol.id=nullif(v_item->>'purchase_order_line_id','')::uuid AND pol.tenant_id=p_tenant_id AND pol.purchase_order_id=p_order_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Receipt line does not belong to this purchase order'; END IF;
  IF v_line.received_quantity>=v_line.ordered_quantity THEN RAISE EXCEPTION 'The ordered quantity for % has already been received',v_line.product_code; END IF;
  SELECT * INTO v_product FROM public.products p WHERE p.id=v_line.product_id AND p.tenant_id=p_tenant_id AND p.is_active;
  IF NOT FOUND THEN RAISE EXCEPTION 'Product is no longer active in this shop'; END IF;
  v_item_code:=nullif(trim(coalesce(v_item->>'item_code','')),''); IF v_item_code IS NULL THEN RAISE EXCEPTION 'Every received piece needs a unique item code'; END IF;
  v_serial:=nullif(trim(coalesce(v_item->>'serial_number','')),''); v_barcode:=nullif(trim(coalesce(v_item->>'barcode','')),''); v_huid:=nullif(upper(trim(coalesce(v_item->>'huid',''))),'');
  v_gross:=coalesce(nullif(v_item->>'gross_weight_grams','')::numeric,v_line.gross_weight_grams,v_product.gross_weight_grams);
  v_net:=coalesce(nullif(v_item->>'net_metal_weight_grams','')::numeric,v_line.net_metal_weight_grams,v_product.net_metal_weight_grams);
  v_stone:=coalesce(nullif(v_item->>'stone_weight_grams','')::numeric,v_line.stone_weight_grams,v_product.stone_weight_grams); v_cost:=coalesce(nullif(v_item->>'purchase_cost','')::numeric,v_line.unit_cost);
  IF v_gross IS NULL OR v_gross<=0 OR v_net IS NULL OR v_net<0 OR v_stone IS NULL OR v_stone<0 OR v_net+v_stone>v_gross+0.001 THEN RAISE EXCEPTION 'Invalid weights for item %: net metal plus stone must not exceed gross weight',v_item_code; END IF;
  IF v_cost<0 THEN RAISE EXCEPTION 'Purchase cost cannot be negative'; END IF;
  INSERT INTO public.inventory_items(tenant_id,branch_id,product_id,item_code,serial_number,barcode,huid,purity_id,gross_weight_grams,net_metal_weight_grams,stone_weight_grams,hallmark_details,status,acquired_at,purchase_cost,current_valuation,notes)
  VALUES(p_tenant_id,v_order.branch_id,v_line.product_id,v_item_code,v_serial,v_barcode,v_huid,coalesce(v_line.purity_id,v_product.purity_id),v_gross,v_net,v_stone,coalesce(v_item->'hallmark_details','{}'::jsonb),'in_stock',now(),v_cost,v_cost,'Received from purchase order '||v_order.po_number) RETURNING id INTO v_inventory_item_id;
  INSERT INTO public.inventory_movements(tenant_id,branch_id,inventory_item_id,product_id,movement_type,quantity,reference,reason,actor_user_id)
  VALUES(p_tenant_id,v_order.branch_id,v_inventory_item_id,v_line.product_id,'purchase_receipt',1,v_receipt_number,'Received against purchase order '||v_order.po_number,auth.uid());
  INSERT INTO public.goods_receipt_lines(tenant_id,goods_receipt_id,purchase_order_line_id,inventory_item_id,quantity,purchase_cost,gross_weight_grams,net_metal_weight_grams,stone_weight_grams)
  VALUES(p_tenant_id,v_receipt_id,v_line.id,v_inventory_item_id,1,v_cost,v_gross,v_net,v_stone);
  UPDATE public.purchase_order_lines SET received_quantity=received_quantity+1 WHERE tenant_id=p_tenant_id AND id=v_line.id;
 END LOOP;
 SELECT EXISTS(SELECT 1 FROM public.purchase_order_lines pol WHERE pol.tenant_id=p_tenant_id AND pol.purchase_order_id=p_order_id AND pol.received_quantity<pol.ordered_quantity) INTO v_remaining;
 v_new_status:=CASE WHEN v_remaining THEN 'partially_received' ELSE 'received' END;
 PERFORM set_config('gold.purchase_workflow','on',true);
 UPDATE public.purchase_orders SET status=v_new_status,supplier_invoice_number=coalesce(nullif(trim(coalesce(p_supplier_invoice_number,'')),''),supplier_invoice_number),received_at=CASE WHEN v_new_status='received' THEN now() ELSE received_at END,updated_at=now() WHERE id=p_order_id AND tenant_id=p_tenant_id;
 PERFORM set_config('gold.purchase_workflow','off',true);
 UPDATE public.goods_receipts SET item_count=v_count WHERE id=v_receipt_id AND tenant_id=p_tenant_id;
 INSERT INTO public.audit_logs(tenant_id,actor_user_id,event_name,entity_type,entity_id,details) VALUES(p_tenant_id,auth.uid(),'purchase_order.stock_received','purchase_order',p_order_id::text,jsonb_build_object('po_number',v_order.po_number,'receipt_number',v_receipt_number,'items',v_count,'status',v_new_status));
 RETURN v_receipt_id;
END; $$;

REVOKE ALL ON FUNCTION public.submit_purchase_order(uuid,uuid) FROM public,anon;
REVOKE ALL ON FUNCTION public.receive_purchase_order(uuid,uuid,text,text,jsonb) FROM public,anon;
GRANT EXECUTE ON FUNCTION public.submit_purchase_order(uuid,uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.receive_purchase_order(uuid,uuid,text,text,jsonb) TO authenticated;
