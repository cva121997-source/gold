CREATE UNIQUE INDEX IF NOT EXISTS inventory_items_tenant_id_unique_idx ON public.inventory_items(tenant_id,id);
DO $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conname='stock_transfer_items_inventory_tenant_fk' AND conrelid='public.stock_transfer_items'::regclass) THEN
  ALTER TABLE public.stock_transfer_items ADD CONSTRAINT stock_transfer_items_inventory_tenant_fk
   FOREIGN KEY(tenant_id,inventory_item_id) REFERENCES public.inventory_items(tenant_id,id) ON DELETE RESTRICT;
 END IF;
END $$;

CREATE OR REPLACE FUNCTION public.review_stock_transfer(p_tenant_id uuid,p_transfer_id uuid,p_decision text,p_reason text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE v_transfer public.stock_transfers%rowtype;
BEGIN
 IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Authentication required'; END IF;
 IF p_decision NOT IN('approve','reject') THEN RAISE EXCEPTION 'Choose approve or reject'; END IF;
 IF p_reason IS NOT NULL AND length(p_reason)>500 THEN RAISE EXCEPTION 'Review reason may be up to 500 characters'; END IF;
 SELECT * INTO v_transfer FROM public.stock_transfers st WHERE st.id=p_transfer_id AND st.tenant_id=p_tenant_id FOR UPDATE;
 IF NOT FOUND OR v_transfer.status<>'pending_approval' THEN RAISE EXCEPTION 'Only pending transfers can be reviewed'; END IF;
 IF NOT(private.has_tenant_branch_access(p_tenant_id,v_transfer.from_branch_id,ARRAY['owner','manager']::text[]) OR private.has_tenant_branch_access(p_tenant_id,v_transfer.to_branch_id,ARRAY['owner','manager']::text[])) THEN RAISE EXCEPTION 'Approval or rejection requires manager access to one of the involved branches'; END IF;
 IF v_transfer.created_by=auth.uid() THEN RAISE EXCEPTION 'The transfer requester cannot approve their own transfer'; END IF;
 IF p_decision='approve' THEN
  UPDATE public.stock_transfers SET status='approved',approved_by=auth.uid(),approved_at=now(),rejected_by=NULL,rejected_at=NULL,rejection_reason=NULL WHERE id=p_transfer_id AND tenant_id=p_tenant_id;
 ELSE
  IF length(trim(coalesce(p_reason,'')))<5 THEN RAISE EXCEPTION 'Provide a rejection reason of at least 5 characters'; END IF;
  PERFORM set_config('gold.inventory_transfer_workflow','on',true);
  UPDATE public.inventory_items ii SET status='in_stock',updated_at=now()
   FROM public.stock_transfer_items ti WHERE ti.tenant_id=p_tenant_id AND ti.transfer_id=p_transfer_id AND ti.inventory_item_id=ii.id AND ii.tenant_id=p_tenant_id AND ii.status='transfer_pending';
  PERFORM set_config('gold.inventory_transfer_workflow','off',true);
  UPDATE public.stock_transfers SET status='rejected',rejected_by=auth.uid(),rejected_at=now(),rejection_reason=trim(p_reason) WHERE id=p_transfer_id AND tenant_id=p_tenant_id;
  INSERT INTO public.inventory_movements(tenant_id,branch_id,inventory_item_id,product_id,movement_type,quantity,from_branch_id,to_branch_id,reference,reason,actor_user_id)
   SELECT p_tenant_id,v_transfer.from_branch_id,ii.id,ii.product_id,'transfer_rejected',1,v_transfer.from_branch_id,v_transfer.to_branch_id,v_transfer.transfer_code,trim(p_reason),auth.uid()
   FROM public.stock_transfer_items ti JOIN public.inventory_items ii ON ii.id=ti.inventory_item_id AND ii.tenant_id=ti.tenant_id WHERE ti.tenant_id=p_tenant_id AND ti.transfer_id=p_transfer_id;
 END IF;
 INSERT INTO public.audit_logs(tenant_id,actor_user_id,event_name,entity_type,entity_id,details)
 VALUES(p_tenant_id,auth.uid(),CASE WHEN p_decision='approve' THEN 'inventory.transfer_approved' ELSE 'inventory.transfer_rejected' END,'stock_transfer',p_transfer_id::text,jsonb_build_object('transfer_code',v_transfer.transfer_code,'decision',p_decision,'reason',p_reason,'requester_id',v_transfer.created_by));
 RETURN jsonb_build_object('id',p_transfer_id,'status',CASE WHEN p_decision='approve' THEN 'approved' ELSE 'rejected' END);
END; $$;
REVOKE ALL ON FUNCTION public.review_stock_transfer(uuid,uuid,text,text) FROM public,anon;
GRANT EXECUTE ON FUNCTION public.review_stock_transfer(uuid,uuid,text,text) TO authenticated;
