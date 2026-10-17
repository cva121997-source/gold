CREATE OR REPLACE FUNCTION private.guard_inventory_valuation_update()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE v_reason text;
BEGIN
 IF NEW.current_valuation IS DISTINCT FROM OLD.current_valuation THEN
  v_reason:=NULLIF(trim(coalesce(current_setting('gold.valuation_reason',true),'')),'');
  IF v_reason IS NULL OR length(v_reason)<5 THEN RAISE EXCEPTION 'Change item valuation through the audited revaluation workflow with a reason'; END IF;
  IF NEW.current_valuation IS NULL OR NEW.current_valuation<0 THEN RAISE EXCEPTION 'Inventory valuation must be non-negative'; END IF;
 END IF;
 RETURN NEW;
END; $$;
DROP TRIGGER IF EXISTS guard_inventory_valuation_update ON public.inventory_items;
CREATE TRIGGER guard_inventory_valuation_update BEFORE UPDATE OF current_valuation ON public.inventory_items FOR EACH ROW EXECUTE FUNCTION private.guard_inventory_valuation_update();

CREATE OR REPLACE FUNCTION private.capture_inventory_valuation_history()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE v_reason text; v_reference text;
BEGIN
 v_reason:=NULLIF(trim(coalesce(current_setting('gold.valuation_reason',true),'')),'');
 v_reference:=NULLIF(trim(coalesce(current_setting('gold.valuation_reference',true),'')),'');
 IF TG_OP='INSERT' THEN
  IF NEW.current_valuation IS NULL THEN RETURN NEW; END IF;
  IF v_reason IS NULL THEN v_reason:='Initial valuation at stock receipt'; END IF;
  INSERT INTO public.inventory_valuation_history(tenant_id,branch_id,inventory_item_id,product_id,event_type,previous_value,new_value,reason,source_reference,actor_user_id)
  VALUES(NEW.tenant_id,NEW.branch_id,NEW.id,NEW.product_id,'initial_valuation',NULL,NEW.current_valuation,v_reason,v_reference,auth.uid());
  RETURN NEW;
 END IF;
 IF NEW.current_valuation IS DISTINCT FROM OLD.current_valuation THEN
  IF v_reason IS NULL THEN v_reason:='Valuation changed'; END IF;
  IF NEW.current_valuation IS NULL OR NEW.current_valuation<0 THEN RAISE EXCEPTION 'Inventory valuation must be non-negative'; END IF;
  INSERT INTO public.inventory_valuation_history(tenant_id,branch_id,inventory_item_id,product_id,event_type,previous_value,new_value,reason,source_reference,actor_user_id)
  VALUES(NEW.tenant_id,NEW.branch_id,NEW.id,NEW.product_id,'revaluation',OLD.current_valuation,NEW.current_valuation,v_reason,v_reference,auth.uid());
 END IF;
 RETURN NEW;
END; $$;

CREATE OR REPLACE FUNCTION public.revalue_inventory_item(
 p_tenant_id uuid,p_branch_id uuid,p_inventory_item_id uuid,p_new_value numeric,p_reason text,p_source_reference text DEFAULT NULL
)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE v_item public.inventory_items%rowtype;
BEGIN
 IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Authentication required'; END IF;
 IF p_new_value IS NULL OR p_new_value<0 THEN RAISE EXCEPTION 'New valuation must be a non-negative amount'; END IF;
 IF p_reason IS NULL OR length(trim(p_reason))<5 OR length(p_reason)>500 THEN RAISE EXCEPTION 'Enter a valuation reason between 5 and 500 characters'; END IF;
 IF p_source_reference IS NOT NULL AND length(p_source_reference)>160 THEN RAISE EXCEPTION 'Source reference must be 160 characters or fewer'; END IF;
 IF NOT private.has_tenant_branch_access(p_tenant_id,p_branch_id,ARRAY['owner','manager','inventory_manager']::text[]) THEN RAISE EXCEPTION 'Valuation permission denied for this branch'; END IF;
 SELECT * INTO v_item FROM public.inventory_items ii WHERE ii.id=p_inventory_item_id AND ii.tenant_id=p_tenant_id AND ii.branch_id=p_branch_id FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Inventory item not found in the selected branch'; END IF;
 IF v_item.current_valuation IS NOT DISTINCT FROM p_new_value THEN RAISE EXCEPTION 'The new value matches the current valuation'; END IF;
 PERFORM set_config('gold.valuation_reason',trim(p_reason),true);
 PERFORM set_config('gold.valuation_reference',coalesce(nullif(trim(coalesce(p_source_reference,'')),''),''),true);
 UPDATE public.inventory_items SET current_valuation=p_new_value WHERE id=p_inventory_item_id AND tenant_id=p_tenant_id AND branch_id=p_branch_id;
 INSERT INTO public.audit_logs(tenant_id,actor_user_id,event_name,entity_type,entity_id,details)
 VALUES(p_tenant_id,auth.uid(),'inventory.item_revalued','inventory_item',p_inventory_item_id::text,
 jsonb_build_object('item_code',v_item.item_code,'previous_value',v_item.current_valuation,'new_value',p_new_value,'reason',trim(p_reason),'source_reference',p_source_reference));
 RETURN jsonb_build_object('inventory_item_id',p_inventory_item_id,'previous_value',v_item.current_valuation,'new_value',p_new_value,'reason',trim(p_reason));
END; $$;
REVOKE ALL ON FUNCTION public.revalue_inventory_item(uuid,uuid,uuid,numeric,text,text) FROM public,anon;
GRANT EXECUTE ON FUNCTION public.revalue_inventory_item(uuid,uuid,uuid,numeric,text,text) TO authenticated;
