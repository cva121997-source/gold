-- Inventory cost/valuation history and branch-specific low-stock thresholds.

CREATE TABLE IF NOT EXISTS public.inventory_valuation_history (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE RESTRICT,
 branch_id uuid REFERENCES public.branches(id) ON DELETE RESTRICT,
 inventory_item_id uuid NOT NULL REFERENCES public.inventory_items(id) ON DELETE RESTRICT,
 product_id uuid REFERENCES public.products(id) ON DELETE RESTRICT,
 event_type text NOT NULL CHECK(event_type IN ('initial_valuation','revaluation')),
 previous_value numeric(14,2),
 new_value numeric(14,2) NOT NULL CHECK(new_value>=0),
 delta_value numeric(14,2) GENERATED ALWAYS AS (new_value-COALESCE(previous_value,0)) STORED,
 reason text NOT NULL, source_reference text, actor_user_id uuid,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS inventory_valuation_history_item_idx ON public.inventory_valuation_history(tenant_id,inventory_item_id,created_at DESC);
CREATE INDEX IF NOT EXISTS inventory_valuation_history_branch_idx ON public.inventory_valuation_history(tenant_id,branch_id,created_at DESC);

ALTER TABLE public.inventory_valuation_history ENABLE ROW LEVEL SECURITY;
GRANT SELECT ON public.inventory_valuation_history TO authenticated;
REVOKE ALL ON public.inventory_valuation_history FROM anon;
DROP POLICY IF EXISTS inventory_valuation_history_branch_read ON public.inventory_valuation_history;
CREATE POLICY inventory_valuation_history_branch_read ON public.inventory_valuation_history FOR SELECT TO authenticated
 USING(private.has_tenant_branch_access(tenant_id,branch_id,NULL::text[]));

CREATE OR REPLACE FUNCTION private.capture_inventory_valuation_history()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE v_reason text; v_event text;
BEGIN
 IF TG_OP='INSERT' THEN
  IF NEW.current_valuation IS NULL THEN RETURN NEW; END IF;
  v_event:='initial_valuation';
  v_reason:=NULLIF(trim(coalesce(current_setting('gold.valuation_reason',true),'')),'');
  IF v_reason IS NULL THEN v_reason:='Initial valuation at stock receipt'; END IF;
  INSERT INTO public.inventory_valuation_history(tenant_id,branch_id,inventory_item_id,product_id,event_type,previous_value,new_value,reason,actor_user_id)
  VALUES(NEW.tenant_id,NEW.branch_id,NEW.id,NEW.product_id,v_event,NULL,NEW.current_valuation,v_reason,auth.uid());
  RETURN NEW;
 END IF;
 IF NEW.current_valuation IS DISTINCT FROM OLD.current_valuation THEN
  v_event:='revaluation';
  v_reason:=NULLIF(trim(coalesce(current_setting('gold.valuation_reason',true),'')),'');
  IF v_reason IS NULL THEN v_reason:='Valuation changed'; END IF;
  IF NEW.current_valuation IS NULL OR NEW.current_valuation<0 THEN RAISE EXCEPTION 'Inventory valuation must be non-negative'; END IF;
  INSERT INTO public.inventory_valuation_history(tenant_id,branch_id,inventory_item_id,product_id,event_type,previous_value,new_value,reason,actor_user_id)
  VALUES(NEW.tenant_id,NEW.branch_id,NEW.id,NEW.product_id,v_event,OLD.current_valuation,NEW.current_valuation,v_reason,auth.uid());
 END IF;
 RETURN NEW;
END; $$;

DROP TRIGGER IF EXISTS inventory_item_valuation_history ON public.inventory_items;
CREATE TRIGGER inventory_item_valuation_history AFTER INSERT OR UPDATE OF current_valuation ON public.inventory_items
 FOR EACH ROW EXECUTE FUNCTION private.capture_inventory_valuation_history();

CREATE TABLE IF NOT EXISTS public.inventory_reorder_rules (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE RESTRICT,
 branch_id uuid NOT NULL REFERENCES public.branches(id) ON DELETE RESTRICT,
 product_id uuid NOT NULL REFERENCES public.products(id) ON DELETE RESTRICT,
 minimum_stock integer NOT NULL DEFAULT 1 CHECK(minimum_stock>=0),
 reorder_quantity integer NOT NULL DEFAULT 1 CHECK(reorder_quantity>0),
 is_active boolean NOT NULL DEFAULT true,
 created_by uuid DEFAULT auth.uid(), updated_by uuid DEFAULT auth.uid(),
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(tenant_id,branch_id,product_id)
);
CREATE INDEX IF NOT EXISTS inventory_reorder_rules_branch_idx ON public.inventory_reorder_rules(tenant_id,branch_id,is_active);

ALTER TABLE public.inventory_reorder_rules ENABLE ROW LEVEL SECURITY;
GRANT SELECT,INSERT,UPDATE,DELETE ON public.inventory_reorder_rules TO authenticated;
REVOKE ALL ON public.inventory_reorder_rules FROM anon;
DROP POLICY IF EXISTS inventory_reorder_rules_branch_read ON public.inventory_reorder_rules;
CREATE POLICY inventory_reorder_rules_branch_read ON public.inventory_reorder_rules FOR SELECT TO authenticated USING(private.has_tenant_branch_access(tenant_id,branch_id,NULL::text[]));
DROP POLICY IF EXISTS inventory_reorder_rules_manager_insert ON public.inventory_reorder_rules;
CREATE POLICY inventory_reorder_rules_manager_insert ON public.inventory_reorder_rules FOR INSERT TO authenticated WITH CHECK(private.has_tenant_branch_access(tenant_id,branch_id,ARRAY['owner','manager','inventory_manager']::text[]));
DROP POLICY IF EXISTS inventory_reorder_rules_manager_update ON public.inventory_reorder_rules;
CREATE POLICY inventory_reorder_rules_manager_update ON public.inventory_reorder_rules FOR UPDATE TO authenticated
 USING(private.has_tenant_branch_access(tenant_id,branch_id,ARRAY['owner','manager','inventory_manager']::text[]))
 WITH CHECK(private.has_tenant_branch_access(tenant_id,branch_id,ARRAY['owner','manager','inventory_manager']::text[]));
DROP POLICY IF EXISTS inventory_reorder_rules_manager_delete ON public.inventory_reorder_rules;
CREATE POLICY inventory_reorder_rules_manager_delete ON public.inventory_reorder_rules FOR DELETE TO authenticated USING(private.has_tenant_branch_access(tenant_id,branch_id,ARRAY['owner','manager','inventory_manager']::text[]));

CREATE OR REPLACE FUNCTION private.guard_inventory_reorder_rule()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
 IF NEW.minimum_stock<0 OR NEW.reorder_quantity<1 THEN RAISE EXCEPTION 'Minimum stock must be non-negative and reorder quantity must be at least one'; END IF;
 IF NOT EXISTS(SELECT 1 FROM public.branches b WHERE b.id=NEW.branch_id AND b.tenant_id=NEW.tenant_id AND b.is_active) THEN RAISE EXCEPTION 'Branch must be active and belong to the selected shop'; END IF;
 IF NOT EXISTS(SELECT 1 FROM public.products p WHERE p.id=NEW.product_id AND p.tenant_id=NEW.tenant_id AND p.is_active) THEN RAISE EXCEPTION 'Product must be active and belong to the selected shop'; END IF;
 NEW.updated_at:=now(); NEW.updated_by:=auth.uid(); RETURN NEW;
END; $$;
DROP TRIGGER IF EXISTS guard_inventory_reorder_rule_before_write ON public.inventory_reorder_rules;
CREATE TRIGGER guard_inventory_reorder_rule_before_write BEFORE INSERT OR UPDATE ON public.inventory_reorder_rules
 FOR EACH ROW EXECUTE FUNCTION private.guard_inventory_reorder_rule();
