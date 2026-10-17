CREATE OR REPLACE FUNCTION public.get_inventory_reorder_status(p_tenant_id uuid,p_branch_id uuid DEFAULT NULL)
RETURNS TABLE(
 tenant_id uuid,branch_id uuid,branch_name text,product_id uuid,product_code text,product_name text,
 minimum_stock integer,reorder_quantity integer,on_hand bigint,shortage bigint,is_low_stock boolean
)
LANGUAGE sql STABLE SECURITY INVOKER SET search_path='' AS $$
 SELECT r.tenant_id,r.branch_id,b.name,p.id,p.product_code,p.name,r.minimum_stock,r.reorder_quantity,
        count(ii.id)::bigint,
        greatest(r.minimum_stock-count(ii.id)::integer,0)::bigint,
        count(ii.id)<=r.minimum_stock
 FROM public.inventory_reorder_rules r
 JOIN public.branches b ON b.id=r.branch_id AND b.tenant_id=r.tenant_id
 JOIN public.products p ON p.id=r.product_id AND p.tenant_id=r.tenant_id
 LEFT JOIN public.inventory_items ii ON ii.tenant_id=r.tenant_id AND ii.branch_id=r.branch_id AND ii.product_id=r.product_id AND ii.status='in_stock'
 WHERE r.tenant_id=p_tenant_id AND r.is_active AND (p_branch_id IS NULL OR r.branch_id=p_branch_id)
   AND private.has_tenant_branch_access(r.tenant_id,r.branch_id,NULL::text[])
 GROUP BY r.tenant_id,r.branch_id,b.name,p.id,p.product_code,p.name,r.minimum_stock,r.reorder_quantity
 ORDER BY (count(ii.id)<=r.minimum_stock) DESC,b.name,p.name
$$;
REVOKE ALL ON FUNCTION public.get_inventory_reorder_status(uuid,uuid) FROM public,anon;
GRANT EXECUTE ON FUNCTION public.get_inventory_reorder_status(uuid,uuid) TO authenticated;
