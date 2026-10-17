-- Auditable stocktake snapshots and discrepancy review. A count never silently
-- writes off stock: missing, extra and changed-during-count items are recorded
-- for a manager to review and resolve through existing stock workflows.

CREATE TABLE IF NOT EXISTS public.inventory_stocktakes (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE RESTRICT,
 branch_id uuid NOT NULL REFERENCES public.branches(id) ON DELETE RESTRICT,
 count_number text NOT NULL,
 count_name text NOT NULL,
 status text NOT NULL DEFAULT 'open' CHECK(status IN ('open','completed','cancelled')),
 started_at timestamptz NOT NULL DEFAULT now(),
 completed_at timestamptz,
 created_by uuid NOT NULL,
 reviewed_by uuid,
 snapshot_count integer NOT NULL DEFAULT 0 CHECK(snapshot_count>=0),
 found_count integer NOT NULL DEFAULT 0 CHECK(found_count>=0),
 missing_count integer NOT NULL DEFAULT 0 CHECK(missing_count>=0),
 extra_count integer NOT NULL DEFAULT 0 CHECK(extra_count>=0),
 changed_during_count integer NOT NULL DEFAULT 0 CHECK(changed_during_count>=0),
 notes text,
 created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(tenant_id,count_number),
 UNIQUE(tenant_id,id)
);

CREATE TABLE IF NOT EXISTS public.inventory_stocktake_lines (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE RESTRICT,
 stocktake_id uuid NOT NULL REFERENCES public.inventory_stocktakes(id) ON DELETE RESTRICT,
 inventory_item_id uuid NOT NULL REFERENCES public.inventory_items(id) ON DELETE RESTRICT,
 line_type text NOT NULL DEFAULT 'expected' CHECK(line_type IN ('expected','extra')),
 expected_status text NOT NULL,
 is_counted boolean NOT NULL DEFAULT false,
 counted_at timestamptz,
 counted_by uuid,
 notes text,
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(tenant_id,stocktake_id,inventory_item_id)
);

CREATE INDEX IF NOT EXISTS inventory_stocktakes_branch_status_idx ON public.inventory_stocktakes(tenant_id,branch_id,status,started_at DESC);
CREATE INDEX IF NOT EXISTS inventory_stocktake_lines_session_idx ON public.inventory_stocktake_lines(tenant_id,stocktake_id,line_type,is_counted);
CREATE INDEX IF NOT EXISTS inventory_stocktake_lines_item_idx ON public.inventory_stocktake_lines(tenant_id,inventory_item_id);

ALTER TABLE public.inventory_stocktakes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.inventory_stocktake_lines ENABLE ROW LEVEL SECURITY;
GRANT SELECT ON public.inventory_stocktakes,public.inventory_stocktake_lines TO authenticated;
REVOKE ALL ON public.inventory_stocktakes,public.inventory_stocktake_lines FROM anon;

DROP POLICY IF EXISTS inventory_stocktakes_branch_read ON public.inventory_stocktakes;
CREATE POLICY inventory_stocktakes_branch_read ON public.inventory_stocktakes FOR SELECT TO authenticated
 USING(private.has_tenant_branch_access(tenant_id,branch_id,NULL::text[]));
DROP POLICY IF EXISTS inventory_stocktake_lines_branch_read ON public.inventory_stocktake_lines;
CREATE POLICY inventory_stocktake_lines_branch_read ON public.inventory_stocktake_lines FOR SELECT TO authenticated
 USING(EXISTS(SELECT 1 FROM public.inventory_stocktakes st WHERE st.id=stocktake_id AND st.tenant_id=inventory_stocktake_lines.tenant_id
 AND private.has_tenant_branch_access(st.tenant_id,st.branch_id,NULL::text[])));

CREATE OR REPLACE FUNCTION public.create_inventory_stocktake(p_tenant_id uuid,p_branch_id uuid,p_count_name text)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE v_stocktake_id uuid; v_count_number text; v_count integer;
BEGIN
 IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Authentication required'; END IF;
 IF length(trim(coalesce(p_count_name,'')))<3 OR length(p_count_name)>160 THEN RAISE EXCEPTION 'Enter a stocktake name between 3 and 160 characters'; END IF;
 IF NOT private.has_tenant_branch_access(p_tenant_id,p_branch_id,ARRAY['owner','manager','inventory_manager']::text[]) THEN RAISE EXCEPTION 'You do not have permission to count stock in this branch'; END IF;
 IF NOT EXISTS(SELECT 1 FROM public.branches b WHERE b.id=p_branch_id AND b.tenant_id=p_tenant_id AND b.is_active) THEN RAISE EXCEPTION 'Active branch not found'; END IF;
 v_count_number:='SC-'||to_char(now() AT TIME ZONE 'Asia/Kolkata','YYYYMMDD')||'-'||upper(substr(replace(gen_random_uuid()::text,'-',''),1,6));
 INSERT INTO public.inventory_stocktakes(tenant_id,branch_id,count_number,count_name,status,created_by)
 VALUES(p_tenant_id,p_branch_id,v_count_number,trim(p_count_name),'open',auth.uid()) RETURNING id INTO v_stocktake_id;
 INSERT INTO public.inventory_stocktake_lines(tenant_id,stocktake_id,inventory_item_id,line_type,expected_status)
 SELECT p_tenant_id,v_stocktake_id,ii.id,'expected',ii.status FROM public.inventory_items ii
 WHERE ii.tenant_id=p_tenant_id AND ii.branch_id=p_branch_id AND ii.status IN ('in_stock','reserved','repair');
 GET DIAGNOSTICS v_count=ROW_COUNT;
 UPDATE public.inventory_stocktakes SET snapshot_count=v_count WHERE id=v_stocktake_id;
 INSERT INTO public.audit_logs(tenant_id,actor_user_id,event_name,entity_type,entity_id,details)
 VALUES(p_tenant_id,auth.uid(),'inventory.stocktake_started','inventory_stocktake',v_stocktake_id::text,
 jsonb_build_object('count_number',v_count_number,'branch_id',p_branch_id,'snapshot_count',v_count,'count_name',trim(p_count_name)));
 RETURN v_stocktake_id;
END; $$;

CREATE OR REPLACE FUNCTION public.mark_inventory_stocktake_item(
 p_tenant_id uuid,p_stocktake_id uuid,p_inventory_item_id uuid,p_is_counted boolean,p_notes text DEFAULT NULL
)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE v_stocktake public.inventory_stocktakes%rowtype; v_item public.inventory_items%rowtype; v_line public.inventory_stocktake_lines%rowtype;
BEGIN
 IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Authentication required'; END IF;
 SELECT * INTO v_stocktake FROM public.inventory_stocktakes st WHERE st.id=p_stocktake_id AND st.tenant_id=p_tenant_id FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Stocktake not found'; END IF;
 IF v_stocktake.status<>'open' THEN RAISE EXCEPTION 'Only open stocktakes can be changed'; END IF;
 IF NOT private.has_tenant_branch_access(p_tenant_id,v_stocktake.branch_id,ARRAY['owner','manager','inventory_manager']::text[]) THEN RAISE EXCEPTION 'Stocktake branch access denied'; END IF;
 SELECT * INTO v_item FROM public.inventory_items ii WHERE ii.id=p_inventory_item_id AND ii.tenant_id=p_tenant_id AND ii.branch_id=v_stocktake.branch_id FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Item is not assigned to this shop branch'; END IF;
 IF v_item.status NOT IN ('in_stock','reserved','repair') THEN RAISE EXCEPTION 'Only items currently on hand can be marked as physically counted'; END IF;
 SELECT * INTO v_line FROM public.inventory_stocktake_lines stl WHERE stl.tenant_id=p_tenant_id AND stl.stocktake_id=p_stocktake_id AND stl.inventory_item_id=p_inventory_item_id FOR UPDATE;
 IF NOT FOUND THEN
  IF NOT p_is_counted THEN RAISE EXCEPTION 'An unexpected item must be marked as found to add it to this count'; END IF;
  INSERT INTO public.inventory_stocktake_lines(tenant_id,stocktake_id,inventory_item_id,line_type,expected_status,is_counted,counted_at,counted_by,notes)
  VALUES(p_tenant_id,p_stocktake_id,p_inventory_item_id,'extra',v_item.status,true,now(),auth.uid(),nullif(trim(coalesce(p_notes,'')),''))
  RETURNING * INTO v_line;
 ELSE
  UPDATE public.inventory_stocktake_lines SET is_counted=p_is_counted,counted_at=CASE WHEN p_is_counted THEN now() ELSE NULL END,
   counted_by=CASE WHEN p_is_counted THEN auth.uid() ELSE NULL END,
   notes=CASE WHEN p_notes IS NULL THEN notes ELSE nullif(trim(p_notes),'') END,updated_at=now()
  WHERE id=v_line.id RETURNING * INTO v_line;
 END IF;
 RETURN jsonb_build_object('line_id',v_line.id,'line_type',v_line.line_type,'is_counted',v_line.is_counted,'item_code',v_item.item_code);
END; $$;

CREATE OR REPLACE FUNCTION public.finalize_inventory_stocktake(p_tenant_id uuid,p_stocktake_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE v_stocktake public.inventory_stocktakes%rowtype; v_found integer; v_missing integer; v_extra integer; v_changed integer;
BEGIN
 IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Authentication required'; END IF;
 SELECT * INTO v_stocktake FROM public.inventory_stocktakes st WHERE st.id=p_stocktake_id AND st.tenant_id=p_tenant_id FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Stocktake not found'; END IF;
 IF v_stocktake.status<>'open' THEN RAISE EXCEPTION 'Only open stocktakes can be finalised'; END IF;
 IF NOT private.has_tenant_branch_access(p_tenant_id,v_stocktake.branch_id,ARRAY['owner','manager']::text[]) THEN
  RAISE EXCEPTION 'Only a shop owner or manager can finalise and review stock discrepancies';
 END IF;
 SELECT count(*) FILTER(WHERE stl.line_type='expected' AND stl.is_counted AND ii.status=stl.expected_status),
 count(*) FILTER(WHERE stl.line_type='expected' AND NOT stl.is_counted AND ii.status=stl.expected_status),
 count(*) FILTER(WHERE stl.line_type='extra' AND stl.is_counted AND ii.status=stl.expected_status),
 count(*) FILTER(WHERE stl.line_type='expected' AND ii.status IS DISTINCT FROM stl.expected_status)
 INTO v_found,v_missing,v_extra,v_changed
 FROM public.inventory_stocktake_lines stl JOIN public.inventory_items ii ON ii.id=stl.inventory_item_id AND ii.tenant_id=stl.tenant_id
 WHERE stl.tenant_id=p_tenant_id AND stl.stocktake_id=p_stocktake_id;
 UPDATE public.inventory_stocktakes SET status='completed',completed_at=now(),reviewed_by=auth.uid(),
 found_count=v_found,missing_count=v_missing,extra_count=v_extra,changed_during_count=v_changed
 WHERE id=p_stocktake_id AND tenant_id=p_tenant_id;
 INSERT INTO public.audit_logs(tenant_id,actor_user_id,event_name,entity_type,entity_id,details)
 VALUES(p_tenant_id,auth.uid(),'inventory.stocktake_finalized','inventory_stocktake',p_stocktake_id::text,
 jsonb_build_object('count_number',v_stocktake.count_number,'snapshot_count',v_stocktake.snapshot_count,
 'found_count',v_found,'missing_count',v_missing,'extra_count',v_extra,'changed_during_count',v_changed));
 RETURN jsonb_build_object('id',p_stocktake_id,'status','completed','snapshot_count',v_stocktake.snapshot_count,
 'found_count',v_found,'missing_count',v_missing,'extra_count',v_extra,'changed_during_count',v_changed);
END; $$;

REVOKE ALL ON FUNCTION public.create_inventory_stocktake(uuid,uuid,text) FROM public,anon;
REVOKE ALL ON FUNCTION public.mark_inventory_stocktake_item(uuid,uuid,uuid,boolean,text) FROM public,anon;
REVOKE ALL ON FUNCTION public.finalize_inventory_stocktake(uuid,uuid) FROM public,anon;
GRANT EXECUTE ON FUNCTION public.create_inventory_stocktake(uuid,uuid,text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.mark_inventory_stocktake_item(uuid,uuid,uuid,boolean,text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.finalize_inventory_stocktake(uuid,uuid) TO authenticated;
