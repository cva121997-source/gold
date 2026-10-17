ALTER TABLE public.stock_transfer_items
 ADD COLUMN IF NOT EXISTS item_code_snapshot text,
 ADD COLUMN IF NOT EXISTS product_code_snapshot text,
 ADD COLUMN IF NOT EXISTS description_snapshot text,
 ADD COLUMN IF NOT EXISTS huid_snapshot text,
 ADD COLUMN IF NOT EXISTS barcode_snapshot text,
 ADD COLUMN IF NOT EXISTS gross_weight_grams_snapshot numeric(12,3),
 ADD COLUMN IF NOT EXISTS net_metal_weight_grams_snapshot numeric(12,3);

CREATE OR REPLACE FUNCTION public.add_stock_transfer_item(p_tenant_id uuid,p_transfer_id uuid,p_inventory_item_id uuid,p_notes text DEFAULT NULL)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE v_transfer public.stock_transfers%rowtype;v_item public.inventory_items%rowtype;v_product public.products%rowtype;v_id uuid;
BEGIN
 IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Authentication required';END IF;
 SELECT * INTO v_transfer FROM public.stock_transfers st WHERE st.id=p_transfer_id AND st.tenant_id=p_tenant_id FOR UPDATE;
 IF NOT FOUND OR v_transfer.status<>'draft' THEN RAISE EXCEPTION 'Only a draft transfer can be edited';END IF;
 IF NOT private.has_tenant_branch_access(p_tenant_id,v_transfer.from_branch_id,ARRAY['owner','manager','inventory_manager']::text[]) THEN RAISE EXCEPTION 'Source branch access denied';END IF;
 SELECT * INTO v_item FROM public.inventory_items ii WHERE ii.id=p_inventory_item_id AND ii.tenant_id=p_tenant_id FOR UPDATE;
 IF NOT FOUND OR v_item.branch_id IS DISTINCT FROM v_transfer.from_branch_id OR v_item.status<>'in_stock' THEN RAISE EXCEPTION 'Only an available item in the source branch can be added';END IF;
 IF EXISTS(SELECT 1 FROM public.stock_transfer_items ti JOIN public.stock_transfers st ON st.id=ti.transfer_id AND st.tenant_id=ti.tenant_id WHERE ti.tenant_id=p_tenant_id AND ti.inventory_item_id=p_inventory_item_id AND st.status IN('pending_approval','approved','in_transit','dispatched')) THEN RAISE EXCEPTION 'This item is already part of an active transfer';END IF;
 IF p_notes IS NOT NULL AND length(p_notes)>300 THEN RAISE EXCEPTION 'Item notes may be up to 300 characters';END IF;
 SELECT * INTO v_product FROM public.products p WHERE p.id=v_item.product_id AND p.tenant_id=p_tenant_id;
 INSERT INTO public.stock_transfer_items(tenant_id,transfer_id,inventory_item_id,notes,item_code_snapshot,product_code_snapshot,description_snapshot,huid_snapshot,barcode_snapshot,gross_weight_grams_snapshot,net_metal_weight_grams_snapshot)
 VALUES(p_tenant_id,p_transfer_id,p_inventory_item_id,nullif(trim(coalesce(p_notes,'')),''),v_item.item_code,v_product.product_code,v_product.name,v_item.huid,v_item.barcode,v_item.gross_weight_grams,v_item.net_metal_weight_grams)
 RETURNING id INTO v_id;
 RETURN v_id;
END;$$;
REVOKE ALL ON FUNCTION public.add_stock_transfer_item(uuid,uuid,uuid,text) FROM public,anon;
GRANT EXECUTE ON FUNCTION public.add_stock_transfer_item(uuid,uuid,uuid,text) TO authenticated;
