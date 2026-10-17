
CREATE TABLE IF NOT EXISTS public.inventory_stocktake_resolutions(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE RESTRICT,
 stocktake_id uuid NOT NULL REFERENCES public.inventory_stocktakes(id) ON DELETE RESTRICT,
 stocktake_line_id uuid NOT NULL REFERENCES public.inventory_stocktake_lines(id) ON DELETE RESTRICT,
 inventory_item_id uuid NOT NULL REFERENCES public.inventory_items(id) ON DELETE RESTRICT,
 resolution_type text NOT NULL CHECK(resolution_type IN('write_off','found_after_count')),
 reason text NOT NULL CHECK(length(trim(reason))>=5),created_by uuid NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(tenant_id,stocktake_line_id)
);
CREATE INDEX IF NOT EXISTS inventory_stocktake_resolutions_session_idx ON public.inventory_stocktake_resolutions(tenant_id,stocktake_id,created_at DESC);
ALTER TABLE public.inventory_stocktake_resolutions ENABLE ROW LEVEL SECURITY;
GRANT SELECT ON public.inventory_stocktake_resolutions TO authenticated;
REVOKE ALL ON public.inventory_stocktake_resolutions FROM anon,public;
DROP POLICY IF EXISTS inventory_stocktake_resolutions_branch_read ON public.inventory_stocktake_resolutions;
CREATE POLICY inventory_stocktake_resolutions_branch_read ON public.inventory_stocktake_resolutions FOR SELECT TO authenticated USING(
 EXISTS(SELECT 1 FROM public.inventory_stocktakes st WHERE st.id=stocktake_id AND st.tenant_id=inventory_stocktake_resolutions.tenant_id
 AND private.has_tenant_branch_access(st.tenant_id,st.branch_id,NULL::text[])));

CREATE OR REPLACE FUNCTION public.resolve_inventory_stocktake_discrepancy(p_tenant_id uuid,p_stocktake_id uuid,p_stocktake_line_id uuid,p_resolution text,p_reason text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE v_stocktake public.inventory_stocktakes%rowtype;v_line public.inventory_stocktake_lines%rowtype;v_item public.inventory_items%rowtype;v_id uuid;
BEGIN
 IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Authentication required';END IF;
 IF p_resolution NOT IN('write_off','found_after_count') THEN RAISE EXCEPTION 'Choose write off or found after count';END IF;
 IF length(trim(coalesce(p_reason,'')))<5 OR length(p_reason)>500 THEN RAISE EXCEPTION 'Provide a resolution reason between 5 and 500 characters';END IF;
 SELECT * INTO v_stocktake FROM public.inventory_stocktakes st WHERE st.id=p_stocktake_id AND st.tenant_id=p_tenant_id FOR UPDATE;
 IF NOT FOUND OR v_stocktake.status<>'completed' THEN RAISE EXCEPTION 'Only completed stocktakes can have discrepancies resolved';END IF;
 IF NOT private.has_tenant_branch_access(p_tenant_id,v_stocktake.branch_id,ARRAY['owner','manager']::text[]) THEN RAISE EXCEPTION 'Only an owner or manager can resolve stocktake discrepancies';END IF;
 SELECT * INTO v_line FROM public.inventory_stocktake_lines stl WHERE stl.id=p_stocktake_line_id AND stl.tenant_id=p_tenant_id AND stl.stocktake_id=p_stocktake_id FOR UPDATE;
 IF NOT FOUND OR v_line.line_type<>'expected' OR v_line.is_counted THEN RAISE EXCEPTION 'Only an expected, uncounted piece can be resolved';END IF;
 SELECT * INTO v_item FROM public.inventory_items ii WHERE ii.id=v_line.inventory_item_id AND ii.tenant_id=p_tenant_id AND ii.branch_id=v_stocktake.branch_id FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'The inventory item no longer exists at the counted branch; resolve its movement history separately';END IF;
 IF v_item.status IS DISTINCT FROM v_line.expected_status THEN RAISE EXCEPTION 'Item status changed during the count; do not write off or mark it found from this discrepancy. Review its movement history.';END IF;
 IF v_item.status NOT IN('in_stock','reserved','repair') THEN RAISE EXCEPTION 'Item is no longer an on-hand status and cannot be adjusted by this workflow';END IF;
 IF EXISTS(SELECT 1 FROM public.inventory_stocktake_resolutions r WHERE r.tenant_id=p_tenant_id AND r.stocktake_line_id=p_stocktake_line_id) THEN RAISE EXCEPTION 'This stocktake discrepancy already has a resolution';END IF;
 IF p_resolution='write_off' THEN
  PERFORM private.move_inventory_item(p_tenant_id,v_item.id,'write_off',NULL,trim(p_reason));
 ELSE
  UPDATE public.inventory_stocktake_lines SET is_counted=true,counted_at=now(),counted_by=auth.uid(),notes=concat_ws(E'\n',nullif(notes,''),'Found after count: '||trim(p_reason)),updated_at=now()
  WHERE id=p_stocktake_line_id AND tenant_id=p_tenant_id;
  UPDATE public.inventory_stocktakes SET found_count=found_count+1,missing_count=greatest(missing_count-1,0) WHERE id=p_stocktake_id AND tenant_id=p_tenant_id;
 END IF;
 INSERT INTO public.inventory_stocktake_resolutions(tenant_id,stocktake_id,stocktake_line_id,inventory_item_id,resolution_type,reason,created_by)
 VALUES(p_tenant_id,p_stocktake_id,p_stocktake_line_id,v_item.id,p_resolution,trim(p_reason),auth.uid()) RETURNING id INTO v_id;
 INSERT INTO public.audit_logs(tenant_id,actor_user_id,event_name,entity_type,entity_id,details)
 VALUES(p_tenant_id,auth.uid(),'inventory.stocktake_discrepancy_resolved','inventory_stocktake',p_stocktake_id::text,
 jsonb_build_object('resolution_id',v_id,'stocktake_line_id',p_stocktake_line_id,'inventory_item_id',v_item.id,'item_code',v_item.item_code,'resolution',p_resolution,'reason',trim(p_reason),'expected_status',v_line.expected_status));
 RETURN jsonb_build_object('id',v_id,'stocktake_id',p_stocktake_id,'inventory_item_id',v_item.id,'resolution',p_resolution);
END;$$;
REVOKE ALL ON FUNCTION public.resolve_inventory_stocktake_discrepancy(uuid,uuid,uuid,text,text) FROM public,anon;
GRANT EXECUTE ON FUNCTION public.resolve_inventory_stocktake_discrepancy(uuid,uuid,uuid,text,text) TO authenticated;
