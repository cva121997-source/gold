-- Seed an explicitly labelled one-time baseline for stock items that existed
-- before valuation events were enabled. This is not a verified historical change.
INSERT INTO public.inventory_valuation_history(
 tenant_id,branch_id,inventory_item_id,product_id,event_type,previous_value,new_value,reason,source_reference,actor_user_id,created_at
)
SELECT ii.tenant_id,ii.branch_id,ii.id,ii.product_id,'initial_valuation',NULL,ii.current_valuation,
 'Baseline at valuation-history rollout; historical value not independently verified',
 'valuation-history-rollout-2026-10-17',NULL,ii.created_at
FROM public.inventory_items ii
WHERE ii.current_valuation IS NOT NULL
 AND NOT EXISTS (
  SELECT 1 FROM public.inventory_valuation_history vh
  WHERE vh.tenant_id=ii.tenant_id AND vh.inventory_item_id=ii.id AND vh.event_type='initial_valuation'
 );
