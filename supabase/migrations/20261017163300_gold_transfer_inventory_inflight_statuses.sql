-- The workflow holds requested/transporting pieces outside saleable stock.
-- Preserve the existing states and add explicit in-flight states for approval transfers.
ALTER TABLE public.inventory_items DROP CONSTRAINT IF EXISTS inventory_items_status_check;
ALTER TABLE public.inventory_items ADD CONSTRAINT inventory_items_status_check
 CHECK(status=ANY(ARRAY['in_stock'::text,'reserved'::text,'sold'::text,'repair'::text,'transferred'::text,'transfer_pending'::text,'in_transit'::text,'written_off'::text]));
