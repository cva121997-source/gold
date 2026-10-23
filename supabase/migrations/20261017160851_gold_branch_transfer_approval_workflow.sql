-- Two-person inter-branch stock transfer approval. Inventory is unavailable to POS
-- after submission and remains at the source branch until the receiving branch confirms it.
ALTER TABLE public.stock_transfers ADD COLUMN IF NOT EXISTS requested_at timestamptz,
 ADD COLUMN IF NOT EXISTS approved_by uuid, ADD COLUMN IF NOT EXISTS approved_at timestamptz,
 ADD COLUMN IF NOT EXISTS rejected_by uuid, ADD COLUMN IF NOT EXISTS rejected_at timestamptz,
 ADD COLUMN IF NOT EXISTS rejection_reason text, ADD COLUMN IF NOT EXISTS dispatched_by uuid,
 ADD COLUMN IF NOT EXISTS expected_arrival_date date, ADD COLUMN IF NOT EXISTS received_notes text;
CREATE INDEX IF NOT EXISTS stock_transfers_tenant_status_date_idx ON public.stock_transfers(tenant_id,status,created_at DESC);
CREATE INDEX IF NOT EXISTS stock_transfer_items_lookup_idx ON public.stock_transfer_items(tenant_id,transfer_id,inventory_item_id);

DO $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conname='stock_transfers_status_workflow_check' AND conrelid='public.stock_transfers'::regclass) THEN
  ALTER TABLE public.stock_transfers ADD CONSTRAINT stock_transfers_status_workflow_check CHECK(status IN ('draft','pending_approval','approved','in_transit','received','rejected','cancelled','dispatched'));
 END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conname='stock_transfers_tenant_id_unique' AND conrelid='public.stock_transfers'::regclass) THEN
  ALTER TABLE public.stock_transfers ADD CONSTRAINT stock_transfers_tenant_id_unique UNIQUE(tenant_id,id);
 END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conname='stock_transfer_items_parent_tenant_fk' AND conrelid='public.stock_transfer_items'::regclass) THEN
  ALTER TABLE public.stock_transfer_items ADD CONSTRAINT stock_transfer_items_parent_tenant_fk FOREIGN KEY(tenant_id,transfer_id) REFERENCES public.stock_transfers(tenant_id,id) ON DELETE RESTRICT;
 END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conname='stock_transfer_items_tenant_item_unique' AND conrelid='public.stock_transfer_items'::regclass) THEN
  ALTER TABLE public.stock_transfer_items ADD CONSTRAINT stock_transfer_items_tenant_item_unique UNIQUE(tenant_id,transfer_id,inventory_item_id);
 END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS inventory_items_tenant_id_unique_idx ON public.inventory_items(tenant_id,id);
DO $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conname='stock_transfer_items_inventory_tenant_fk' AND conrelid='public.stock_transfer_items'::regclass) THEN
  ALTER TABLE public.stock_transfer_items ADD CONSTRAINT stock_transfer_items_inventory_tenant_fk
   FOREIGN KEY(tenant_id,inventory_item_id) REFERENCES public.inventory_items(tenant_id,id) ON DELETE RESTRICT;
 END IF;
END $$;

ALTER TABLE public.stock_transfers ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.stock_transfer_items ENABLE ROW LEVEL SECURITY;
REVOKE INSERT,UPDATE,DELETE ON public.stock_transfers,public.stock_transfer_items FROM public,anon,authenticated;
GRANT SELECT ON public.stock_transfers,public.stock_transfer_items TO authenticated;
DROP POLICY IF EXISTS transfers_managers_manage ON public.stock_transfers;
DROP POLICY IF EXISTS transfer_items_manage ON public.stock_transfer_items;
DROP POLICY IF EXISTS transfers_managers_read ON public.stock_transfers;
DROP POLICY IF EXISTS transfers_read ON public.stock_transfers;
DROP POLICY IF EXISTS transfers_select ON public.stock_transfers;
DROP POLICY IF EXISTS transfer_items_read ON public.stock_transfer_items;
DROP POLICY IF EXISTS stock_transfers_branch_read ON public.stock_transfers;
DROP POLICY IF EXISTS stock_transfer_items_branch_read ON public.stock_transfer_items;
CREATE POLICY stock_transfers_branch_read ON public.stock_transfers FOR SELECT TO authenticated
 USING(private.has_tenant_branch_access(tenant_id,from_branch_id,NULL::text[]) OR private.has_tenant_branch_access(tenant_id,to_branch_id,NULL::text[]));
CREATE POLICY stock_transfer_items_branch_read ON public.stock_transfer_items FOR SELECT TO authenticated USING(
 EXISTS(SELECT 1 FROM public.stock_transfers st WHERE st.id=transfer_id AND st.tenant_id=stock_transfer_items.tenant_id
 AND (private.has_tenant_branch_access(st.tenant_id,st.from_branch_id,NULL::text[]) OR private.has_tenant_branch_access(st.tenant_id,st.to_branch_id,NULL::text[]))));

CREATE OR REPLACE FUNCTION public.create_stock_transfer(p_tenant_id uuid,p_from_branch_id uuid,p_to_branch_id uuid,p_notes text DEFAULT NULL,p_expected_arrival_date date DEFAULT NULL)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE v_id uuid;v_code text;
BEGIN
 IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Authentication required';END IF;
 IF p_from_branch_id IS NULL OR p_to_branch_id IS NULL OR p_from_branch_id=p_to_branch_id THEN RAISE EXCEPTION 'Choose two different branches';END IF;
 IF NOT private.has_tenant_branch_access(p_tenant_id,p_from_branch_id,ARRAY['owner','manager','inventory_manager']::text[])
 OR NOT private.has_tenant_branch_access(p_tenant_id,p_to_branch_id,ARRAY['owner','manager','inventory_manager']::text[]) THEN RAISE EXCEPTION 'Transfer requires inventory-management access to both branches';END IF;
 IF NOT EXISTS(SELECT 1 FROM public.branches a JOIN public.branches b ON b.tenant_id=a.tenant_id WHERE a.id=p_from_branch_id AND b.id=p_to_branch_id AND a.tenant_id=p_tenant_id AND a.is_active AND b.is_active) THEN RAISE EXCEPTION 'Both branches must be active branches of the same shop';END IF;
 IF p_notes IS NOT NULL AND length(p_notes)>500 THEN RAISE EXCEPTION 'Notes may be up to 500 characters';END IF;
 v_code:='TR-'||to_char(now() AT TIME ZONE 'Asia/Kolkata','YYYYMMDD')||'-'||upper(substr(replace(gen_random_uuid()::text,'-',''),1,6));
 INSERT INTO public.stock_transfers(tenant_id,transfer_code,from_branch_id,to_branch_id,status,notes,created_by,expected_arrival_date)
 VALUES(p_tenant_id,v_code,p_from_branch_id,p_to_branch_id,'draft',nullif(trim(coalesce(p_notes,'')),''),auth.uid(),p_expected_arrival_date) RETURNING id INTO v_id;
 INSERT INTO public.audit_logs(tenant_id,actor_user_id,event_name,entity_type,entity_id,details) VALUES(p_tenant_id,auth.uid(),'inventory.transfer_created','stock_transfer',v_id::text,jsonb_build_object('transfer_code',v_code,'from_branch_id',p_from_branch_id,'to_branch_id',p_to_branch_id));
 RETURN v_id;
END;$$;

CREATE OR REPLACE FUNCTION public.add_stock_transfer_item(p_tenant_id uuid,p_transfer_id uuid,p_inventory_item_id uuid,p_notes text DEFAULT NULL)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE v_transfer public.stock_transfers%rowtype;v_item public.inventory_items%rowtype;v_id uuid;
BEGIN
 IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Authentication required';END IF;
 SELECT * INTO v_transfer FROM public.stock_transfers st WHERE st.id=p_transfer_id AND st.tenant_id=p_tenant_id FOR UPDATE;
 IF NOT FOUND OR v_transfer.status<>'draft' THEN RAISE EXCEPTION 'Only a draft transfer can be edited';END IF;
 IF NOT private.has_tenant_branch_access(p_tenant_id,v_transfer.from_branch_id,ARRAY['owner','manager','inventory_manager']::text[]) THEN RAISE EXCEPTION 'Source branch access denied';END IF;
 SELECT * INTO v_item FROM public.inventory_items ii WHERE ii.id=p_inventory_item_id AND ii.tenant_id=p_tenant_id FOR UPDATE;
 IF NOT FOUND OR v_item.branch_id IS DISTINCT FROM v_transfer.from_branch_id OR v_item.status<>'in_stock' THEN RAISE EXCEPTION 'Only an available item in the source branch can be added';END IF;
 IF EXISTS(SELECT 1 FROM public.stock_transfer_items ti JOIN public.stock_transfers st ON st.id=ti.transfer_id AND st.tenant_id=ti.tenant_id WHERE ti.tenant_id=p_tenant_id AND ti.inventory_item_id=p_inventory_item_id AND st.status IN('pending_approval','approved','in_transit','dispatched')) THEN RAISE EXCEPTION 'This item is already part of an active transfer';END IF;
 IF p_notes IS NOT NULL AND length(p_notes)>300 THEN RAISE EXCEPTION 'Item notes may be up to 300 characters';END IF;
 INSERT INTO public.stock_transfer_items(tenant_id,transfer_id,inventory_item_id,notes) VALUES(p_tenant_id,p_transfer_id,p_inventory_item_id,nullif(trim(coalesce(p_notes,'')),'')) RETURNING id INTO v_id;
 RETURN v_id;
END;$$;

CREATE OR REPLACE FUNCTION public.submit_stock_transfer(p_tenant_id uuid,p_transfer_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE v_transfer public.stock_transfers%rowtype;v_count integer;v_item record;
BEGIN
 IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Authentication required';END IF;
 SELECT * INTO v_transfer FROM public.stock_transfers st WHERE st.id=p_transfer_id AND st.tenant_id=p_tenant_id FOR UPDATE;
 IF NOT FOUND OR v_transfer.status<>'draft' THEN RAISE EXCEPTION 'Only a draft transfer can be submitted';END IF;
 IF NOT private.has_tenant_branch_access(p_tenant_id,v_transfer.from_branch_id,ARRAY['owner','manager','inventory_manager']::text[]) THEN RAISE EXCEPTION 'Source branch access denied';END IF;
 SELECT count(*) INTO v_count FROM public.stock_transfer_items ti WHERE ti.tenant_id=p_tenant_id AND ti.transfer_id=p_transfer_id;
 IF v_count=0 THEN RAISE EXCEPTION 'Add at least one item before requesting approval';END IF;
 FOR v_item IN SELECT ii.id,ii.item_code FROM public.stock_transfer_items ti JOIN public.inventory_items ii ON ii.id=ti.inventory_item_id AND ii.tenant_id=ti.tenant_id WHERE ti.tenant_id=p_tenant_id AND ti.transfer_id=p_transfer_id FOR UPDATE OF ii LOOP
  IF NOT EXISTS(SELECT 1 FROM public.inventory_items ii WHERE ii.id=v_item.id AND ii.tenant_id=p_tenant_id AND ii.branch_id=v_transfer.from_branch_id AND ii.status='in_stock') THEN RAISE EXCEPTION 'Item % is no longer available at source branch',v_item.item_code;END IF;
 END LOOP;
 PERFORM set_config('gold.inventory_transfer_workflow','on',true);
 UPDATE public.inventory_items ii SET status='transfer_pending',updated_at=now() FROM public.stock_transfer_items ti WHERE ti.tenant_id=p_tenant_id AND ti.transfer_id=p_transfer_id AND ti.inventory_item_id=ii.id AND ii.tenant_id=p_tenant_id;
 PERFORM set_config('gold.inventory_transfer_workflow','off',true);
 UPDATE public.stock_transfers SET status='pending_approval',requested_at=now() WHERE id=p_transfer_id AND tenant_id=p_tenant_id;
 INSERT INTO public.inventory_movements(tenant_id,branch_id,inventory_item_id,product_id,movement_type,quantity,from_branch_id,to_branch_id,reference,reason,actor_user_id)
 SELECT p_tenant_id,v_transfer.from_branch_id,ii.id,ii.product_id,'transfer_requested',1,v_transfer.from_branch_id,v_transfer.to_branch_id,v_transfer.transfer_code,'Pending independent stock transfer approval',auth.uid()
 FROM public.stock_transfer_items ti JOIN public.inventory_items ii ON ii.id=ti.inventory_item_id AND ii.tenant_id=ti.tenant_id WHERE ti.tenant_id=p_tenant_id AND ti.transfer_id=p_transfer_id;
 INSERT INTO public.audit_logs(tenant_id,actor_user_id,event_name,entity_type,entity_id,details) VALUES(p_tenant_id,auth.uid(),'inventory.transfer_submitted','stock_transfer',p_transfer_id::text,jsonb_build_object('transfer_code',v_transfer.transfer_code,'items',v_count));
 RETURN jsonb_build_object('id',p_transfer_id,'status','pending_approval','items',v_count);
END;$$;

CREATE OR REPLACE FUNCTION public.review_stock_transfer(p_tenant_id uuid,p_transfer_id uuid,p_decision text,p_reason text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE v_transfer public.stock_transfers%rowtype;
BEGIN
 IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Authentication required';END IF;
 IF p_decision NOT IN('approve','reject') THEN RAISE EXCEPTION 'Choose approve or reject';END IF;
 IF p_reason IS NOT NULL AND length(p_reason)>500 THEN RAISE EXCEPTION 'Review reason may be up to 500 characters';END IF;
 SELECT * INTO v_transfer FROM public.stock_transfers st WHERE st.id=p_transfer_id AND st.tenant_id=p_tenant_id FOR UPDATE;
 IF NOT FOUND OR v_transfer.status<>'pending_approval' THEN RAISE EXCEPTION 'Only pending transfers can be reviewed';END IF;
 IF NOT(private.has_tenant_branch_access(p_tenant_id,v_transfer.from_branch_id,ARRAY['owner','manager']::text[]) OR private.has_tenant_branch_access(p_tenant_id,v_transfer.to_branch_id,ARRAY['owner','manager']::text[])) THEN RAISE EXCEPTION 'Approval or rejection requires manager access to one of the involved branches';END IF;
 IF v_transfer.created_by=auth.uid() THEN RAISE EXCEPTION 'The transfer requester cannot approve their own transfer';END IF;
 IF p_decision='approve' THEN
  UPDATE public.stock_transfers SET status='approved',approved_by=auth.uid(),approved_at=now(),rejected_by=NULL,rejected_at=NULL,rejection_reason=NULL WHERE id=p_transfer_id AND tenant_id=p_tenant_id;
 ELSE
  IF length(trim(coalesce(p_reason,'')))<5 THEN RAISE EXCEPTION 'Provide a rejection reason of at least 5 characters';END IF;
  PERFORM set_config('gold.inventory_transfer_workflow','on',true);
  UPDATE public.inventory_items ii SET status='in_stock',updated_at=now() FROM public.stock_transfer_items ti WHERE ti.tenant_id=p_tenant_id AND ti.transfer_id=p_transfer_id AND ti.inventory_item_id=ii.id AND ii.tenant_id=p_tenant_id AND ii.status='transfer_pending';
  PERFORM set_config('gold.inventory_transfer_workflow','off',true);
  UPDATE public.stock_transfers SET status='rejected',rejected_by=auth.uid(),rejected_at=now(),rejection_reason=trim(p_reason) WHERE id=p_transfer_id AND tenant_id=p_tenant_id;
  INSERT INTO public.inventory_movements(tenant_id,branch_id,inventory_item_id,product_id,movement_type,quantity,from_branch_id,to_branch_id,reference,reason,actor_user_id)
  SELECT p_tenant_id,v_transfer.from_branch_id,ii.id,ii.product_id,'transfer_rejected',1,v_transfer.from_branch_id,v_transfer.to_branch_id,v_transfer.transfer_code,trim(p_reason),auth.uid()
  FROM public.stock_transfer_items ti JOIN public.inventory_items ii ON ii.id=ti.inventory_item_id AND ii.tenant_id=ti.tenant_id WHERE ti.tenant_id=p_tenant_id AND ti.transfer_id=p_transfer_id;
 END IF;
 INSERT INTO public.audit_logs(tenant_id,actor_user_id,event_name,entity_type,entity_id,details) VALUES(p_tenant_id,auth.uid(),CASE WHEN p_decision='approve' THEN 'inventory.transfer_approved' ELSE 'inventory.transfer_rejected' END,'stock_transfer',p_transfer_id::text,jsonb_build_object('transfer_code',v_transfer.transfer_code,'decision',p_decision,'reason',p_reason,'requester_id',v_transfer.created_by));
 RETURN jsonb_build_object('id',p_transfer_id,'status',CASE WHEN p_decision='approve' THEN 'approved' ELSE 'rejected' END);
END;$$;

CREATE OR REPLACE FUNCTION public.dispatch_stock_transfer(p_tenant_id uuid,p_transfer_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE v_transfer public.stock_transfers%rowtype;v_count integer;v_item record;
BEGIN
 IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Authentication required';END IF;
 SELECT * INTO v_transfer FROM public.stock_transfers st WHERE st.id=p_transfer_id AND st.tenant_id=p_tenant_id FOR UPDATE;
 IF NOT FOUND OR v_transfer.status<>'approved' THEN RAISE EXCEPTION 'Only approved transfers can be dispatched';END IF;
 IF NOT private.has_tenant_branch_access(p_tenant_id,v_transfer.from_branch_id,ARRAY['owner','manager','inventory_manager']::text[]) THEN RAISE EXCEPTION 'Source branch dispatch access denied';END IF;
 SELECT count(*) INTO v_count FROM public.stock_transfer_items ti WHERE ti.tenant_id=p_tenant_id AND ti.transfer_id=p_transfer_id;
 IF v_count=0 THEN RAISE EXCEPTION 'Transfer has no items';END IF;
 FOR v_item IN SELECT ii.id,ii.item_code FROM public.stock_transfer_items ti JOIN public.inventory_items ii ON ii.id=ti.inventory_item_id AND ii.tenant_id=ti.tenant_id WHERE ti.tenant_id=p_tenant_id AND ti.transfer_id=p_transfer_id FOR UPDATE OF ii LOOP
  IF NOT EXISTS(SELECT 1 FROM public.inventory_items ii WHERE ii.id=v_item.id AND ii.tenant_id=p_tenant_id AND ii.branch_id=v_transfer.from_branch_id AND ii.status='transfer_pending') THEN RAISE EXCEPTION 'Item % is not pending at the source branch',v_item.item_code;END IF;
 END LOOP;
 PERFORM set_config('gold.inventory_transfer_workflow','on',true);
 UPDATE public.inventory_items ii SET status='in_transit',updated_at=now() FROM public.stock_transfer_items ti WHERE ti.tenant_id=p_tenant_id AND ti.transfer_id=p_transfer_id AND ti.inventory_item_id=ii.id AND ii.tenant_id=p_tenant_id;
 PERFORM set_config('gold.inventory_transfer_workflow','off',true);
 UPDATE public.stock_transfers SET status='in_transit',dispatched_at=now(),dispatched_by=auth.uid() WHERE id=p_transfer_id AND tenant_id=p_tenant_id;
 INSERT INTO public.inventory_movements(tenant_id,branch_id,inventory_item_id,product_id,movement_type,quantity,from_branch_id,to_branch_id,reference,reason,actor_user_id)
 SELECT p_tenant_id,v_transfer.from_branch_id,ii.id,ii.product_id,'transfer_out',1,v_transfer.from_branch_id,v_transfer.to_branch_id,v_transfer.transfer_code,'Dispatch for approved branch transfer',auth.uid()
 FROM public.stock_transfer_items ti JOIN public.inventory_items ii ON ii.id=ti.inventory_item_id AND ii.tenant_id=ti.tenant_id WHERE ti.tenant_id=p_tenant_id AND ti.transfer_id=p_transfer_id;
 INSERT INTO public.audit_logs(tenant_id,actor_user_id,event_name,entity_type,entity_id,details) VALUES(p_tenant_id,auth.uid(),'inventory.transfer_dispatched','stock_transfer',p_transfer_id::text,jsonb_build_object('transfer_code',v_transfer.transfer_code,'items',v_count));
 RETURN jsonb_build_object('id',p_transfer_id,'status','in_transit','items',v_count);
END;$$;

CREATE OR REPLACE FUNCTION public.receive_stock_transfer(p_tenant_id uuid,p_transfer_id uuid,p_receive_notes text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE v_transfer public.stock_transfers%rowtype;v_count integer;v_item record;
BEGIN
 IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Authentication required';END IF;
 SELECT * INTO v_transfer FROM public.stock_transfers st WHERE st.id=p_transfer_id AND st.tenant_id=p_tenant_id FOR UPDATE;
 IF NOT FOUND OR v_transfer.status<>'in_transit' THEN RAISE EXCEPTION 'Only in-transit transfers can be received';END IF;
 IF NOT private.has_tenant_branch_access(p_tenant_id,v_transfer.to_branch_id,ARRAY['owner','manager','inventory_manager']::text[]) THEN RAISE EXCEPTION 'Receiving branch access denied';END IF;
 IF p_receive_notes IS NOT NULL AND length(p_receive_notes)>500 THEN RAISE EXCEPTION 'Receiving notes may be up to 500 characters';END IF;
 FOR v_item IN SELECT ii.id,ii.item_code FROM public.stock_transfer_items ti JOIN public.inventory_items ii ON ii.id=ti.inventory_item_id AND ii.tenant_id=ti.tenant_id WHERE ti.tenant_id=p_tenant_id AND ti.transfer_id=p_transfer_id FOR UPDATE OF ii LOOP
  IF NOT EXISTS(SELECT 1 FROM public.inventory_items ii WHERE ii.id=v_item.id AND ii.tenant_id=p_tenant_id AND ii.branch_id=v_transfer.from_branch_id AND ii.status='in_transit') THEN RAISE EXCEPTION 'Item % is not in transit from the recorded source branch',v_item.item_code;END IF;
 END LOOP;
 SELECT count(*) INTO v_count FROM public.stock_transfer_items ti WHERE ti.tenant_id=p_tenant_id AND ti.transfer_id=p_transfer_id;
 PERFORM set_config('gold.inventory_transfer_workflow','on',true);
 UPDATE public.inventory_items ii SET branch_id=v_transfer.to_branch_id,status='in_stock',updated_at=now() FROM public.stock_transfer_items ti WHERE ti.tenant_id=p_tenant_id AND ti.transfer_id=p_transfer_id AND ti.inventory_item_id=ii.id AND ii.tenant_id=p_tenant_id;
 PERFORM set_config('gold.inventory_transfer_workflow','off',true);
 UPDATE public.stock_transfers SET status='received',received_at=now(),received_by=auth.uid(),received_notes=nullif(trim(coalesce(p_receive_notes,'')),'') WHERE id=p_transfer_id AND tenant_id=p_tenant_id;
 INSERT INTO public.inventory_movements(tenant_id,branch_id,inventory_item_id,product_id,movement_type,quantity,from_branch_id,to_branch_id,reference,reason,actor_user_id)
 SELECT p_tenant_id,v_transfer.to_branch_id,ii.id,ii.product_id,'transfer_in',1,v_transfer.from_branch_id,v_transfer.to_branch_id,v_transfer.transfer_code,coalesce(nullif(trim(coalesce(p_receive_notes,'')),''),'Received approved branch transfer'),auth.uid()
 FROM public.stock_transfer_items ti JOIN public.inventory_items ii ON ii.id=ti.inventory_item_id AND ii.tenant_id=ti.tenant_id WHERE ti.tenant_id=p_tenant_id AND ti.transfer_id=p_transfer_id;
 INSERT INTO public.audit_logs(tenant_id,actor_user_id,event_name,entity_type,entity_id,details) VALUES(p_tenant_id,auth.uid(),'inventory.transfer_received','stock_transfer',p_transfer_id::text,jsonb_build_object('transfer_code',v_transfer.transfer_code,'items',v_count,'receive_notes',p_receive_notes));
 RETURN jsonb_build_object('id',p_transfer_id,'status','received','items',v_count);
END;$$;

CREATE OR REPLACE FUNCTION public.cancel_stock_transfer(p_tenant_id uuid,p_transfer_id uuid,p_reason text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE v_transfer public.stock_transfers%rowtype;
BEGIN
 IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Authentication required';END IF;
 IF length(trim(coalesce(p_reason,'')))<5 OR length(p_reason)>500 THEN RAISE EXCEPTION 'Provide a cancellation reason between 5 and 500 characters';END IF;
 SELECT * INTO v_transfer FROM public.stock_transfers st WHERE st.id=p_transfer_id AND st.tenant_id=p_tenant_id FOR UPDATE;
 IF NOT FOUND OR v_transfer.status NOT IN('draft','pending_approval','approved') THEN RAISE EXCEPTION 'This transfer can no longer be cancelled';END IF;
 IF NOT private.has_tenant_branch_access(p_tenant_id,v_transfer.from_branch_id,ARRAY['owner','manager','inventory_manager']::text[]) THEN RAISE EXCEPTION 'Source branch cancellation access denied';END IF;
 IF v_transfer.created_by<>auth.uid() AND NOT private.has_tenant_branch_access(p_tenant_id,v_transfer.from_branch_id,ARRAY['owner','manager']::text[]) THEN RAISE EXCEPTION 'Only the requester or source manager can cancel this transfer';END IF;
 IF v_transfer.status IN('pending_approval','approved') THEN
  PERFORM set_config('gold.inventory_transfer_workflow','on',true);
  UPDATE public.inventory_items ii SET status='in_stock',updated_at=now() FROM public.stock_transfer_items ti WHERE ti.tenant_id=p_tenant_id AND ti.transfer_id=p_transfer_id AND ti.inventory_item_id=ii.id AND ii.tenant_id=p_tenant_id AND ii.status='transfer_pending';
  PERFORM set_config('gold.inventory_transfer_workflow','off',true);
  INSERT INTO public.inventory_movements(tenant_id,branch_id,inventory_item_id,product_id,movement_type,quantity,from_branch_id,to_branch_id,reference,reason,actor_user_id)
  SELECT p_tenant_id,v_transfer.from_branch_id,ii.id,ii.product_id,'transfer_cancelled',1,v_transfer.from_branch_id,v_transfer.to_branch_id,v_transfer.transfer_code,trim(p_reason),auth.uid()
  FROM public.stock_transfer_items ti JOIN public.inventory_items ii ON ii.id=ti.inventory_item_id AND ii.tenant_id=ti.tenant_id WHERE ti.tenant_id=p_tenant_id AND ti.transfer_id=p_transfer_id AND ii.status='in_stock';
 END IF;
 UPDATE public.stock_transfers SET status='cancelled',rejection_reason=trim(p_reason) WHERE id=p_transfer_id AND tenant_id=p_tenant_id;
 INSERT INTO public.audit_logs(tenant_id,actor_user_id,event_name,entity_type,entity_id,details) VALUES(p_tenant_id,auth.uid(),'inventory.transfer_cancelled','stock_transfer',p_transfer_id::text,jsonb_build_object('transfer_code',v_transfer.transfer_code,'reason',trim(p_reason)));
 RETURN jsonb_build_object('id',p_transfer_id,'status','cancelled');
END;$$;

CREATE OR REPLACE FUNCTION public.move_inventory_item(p_tenant_id uuid,p_inventory_item_id uuid,p_movement text,p_to_branch_id uuid DEFAULT NULL,p_reason text DEFAULT NULL)
RETURNS void LANGUAGE plpgsql SECURITY INVOKER SET search_path=public,private,pg_temp AS $$
BEGIN
 IF p_movement='transfer' THEN RAISE EXCEPTION 'Direct transfers are disabled. Create a transfer request and complete approval, dispatch and receiving.';END IF;
 PERFORM private.move_inventory_item(p_tenant_id,p_inventory_item_id,p_movement,p_to_branch_id,p_reason);
END;$$;

REVOKE ALL ON FUNCTION public.create_stock_transfer(uuid,uuid,uuid,text,date) FROM public,anon;
REVOKE ALL ON FUNCTION public.add_stock_transfer_item(uuid,uuid,uuid,text) FROM public,anon;
REVOKE ALL ON FUNCTION public.submit_stock_transfer(uuid,uuid) FROM public,anon;
REVOKE ALL ON FUNCTION public.review_stock_transfer(uuid,uuid,text,text) FROM public,anon;
REVOKE ALL ON FUNCTION public.dispatch_stock_transfer(uuid,uuid) FROM public,anon;
REVOKE ALL ON FUNCTION public.receive_stock_transfer(uuid,uuid,text) FROM public,anon;
REVOKE ALL ON FUNCTION public.cancel_stock_transfer(uuid,uuid,text) FROM public,anon;
REVOKE ALL ON FUNCTION public.move_inventory_item(uuid,uuid,text,uuid,text) FROM public,anon;
GRANT EXECUTE ON FUNCTION public.create_stock_transfer(uuid,uuid,uuid,text,date) TO authenticated;
GRANT EXECUTE ON FUNCTION public.add_stock_transfer_item(uuid,uuid,uuid,text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.submit_stock_transfer(uuid,uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.review_stock_transfer(uuid,uuid,text,text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.dispatch_stock_transfer(uuid,uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.receive_stock_transfer(uuid,uuid,text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.cancel_stock_transfer(uuid,uuid,text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.move_inventory_item(uuid,uuid,text,uuid,text) TO authenticated;
