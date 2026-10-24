-- Workflow RPC authorization regression test for the live Gold schema.
--
-- SAFETY: Execute the entire file as one request/session and retain the final
-- ROLLBACK. All Auth/business fixtures and generated audit/scheme rows are
-- synthetic and transaction-local; this script adds no privileges or schema
-- changes to permanent objects.

BEGIN;

CREATE TEMP TABLE gold_workflow_rpc_results (
  test_name text PRIMARY KEY,
  passed boolean NOT NULL,
  detail text NOT NULL
) ON COMMIT DROP;
GRANT SELECT, INSERT ON pg_temp.gold_workflow_rpc_results TO authenticated;

CREATE FUNCTION pg_temp.expect_rpc_error(
  p_test_name text,
  p_statement text,
  p_expected_fragments text[]
) RETURNS void
LANGUAGE plpgsql
AS $helper$
DECLARE
  v_message text;
  v_pass boolean;
BEGIN
  EXECUTE p_statement;
  INSERT INTO pg_temp.gold_workflow_rpc_results
    VALUES (p_test_name, false, 'call unexpectedly succeeded');
EXCEPTION WHEN OTHERS THEN
  GET STACKED DIAGNOSTICS v_message = MESSAGE_TEXT;
  SELECT coalesce(bool_or(v_message ILIKE '%' || fragment || '%'), false)
    INTO v_pass
    FROM unnest(p_expected_fragments) AS fragments(fragment);
  INSERT INTO pg_temp.gold_workflow_rpc_results
    VALUES (p_test_name, v_pass, v_message);
END
$helper$;
GRANT EXECUTE ON FUNCTION pg_temp.expect_rpc_error(text, text, text[]) TO authenticated;

DO $guard$
BEGIN
  IF EXISTS (
    SELECT 1 FROM auth.users
    WHERE id IN (
      'f15f1001-0000-4000-8000-000000000001'::uuid,
      'f15f1001-0000-4000-8000-000000000002'::uuid,
      'f15f1001-0000-4000-8000-000000000003'::uuid
    )
    OR email IN (
      'gold-rpc-owner-a-20261024@example.invalid',
      'gold-rpc-owner-b-20261024@example.invalid',
      'gold-rpc-cashier-a1-20261024@example.invalid'
    )
  ) OR EXISTS (
    SELECT 1 FROM public.tenants
    WHERE id IN (
      'f15f0001-0000-4000-8000-000000000001'::uuid,
      'f15f0001-0000-4000-8000-000000000002'::uuid
    )
  ) THEN
    RAISE EXCEPTION 'Workflow RPC test fixture identifier collision; refusing to run.';
  END IF;
END
$guard$;

INSERT INTO auth.users
  (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
   raw_app_meta_data, raw_user_meta_data, created_at, updated_at, is_sso_user, is_anonymous)
VALUES
  (NULL, 'f15f1001-0000-4000-8000-000000000001', 'authenticated', 'authenticated',
   'gold-rpc-owner-a-20261024@example.invalid', '', now(),
   '{"provider":"email","providers":["email"]}'::jsonb, '{"display_name":"RPC Owner A"}'::jsonb,
   now(), now(), false, false),
  (NULL, 'f15f1001-0000-4000-8000-000000000002', 'authenticated', 'authenticated',
   'gold-rpc-owner-b-20261024@example.invalid', '', now(),
   '{"provider":"email","providers":["email"]}'::jsonb, '{"display_name":"RPC Owner B"}'::jsonb,
   now(), now(), false, false),
  (NULL, 'f15f1001-0000-4000-8000-000000000003', 'authenticated', 'authenticated',
   'gold-rpc-cashier-a1-20261024@example.invalid', '', now(),
   '{"provider":"email","providers":["email"]}'::jsonb, '{"display_name":"RPC Cashier A1"}'::jsonb,
   now(), now(), false, false);

SELECT set_config('request.jwt.claim.sub', 'f15f1001-0000-4000-8000-000000000001', true);

INSERT INTO public.tenants (id, code, slug, display_name, status, country_code, timezone, default_currency)
VALUES
 ('f15f0001-0000-4000-8000-000000000001', 'RPC_TEST_A_20261024', 'rpc-test-a-20261024', 'RPC Test Tenant A', 'trial', 'IN', 'Asia/Kolkata', 'INR'),
 ('f15f0001-0000-4000-8000-000000000002', 'RPC_TEST_B_20261024', 'rpc-test-b-20261024', 'RPC Test Tenant B', 'trial', 'IN', 'Asia/Kolkata', 'INR');

INSERT INTO public.branches (id, tenant_id, branch_code, name, is_default, is_active)
VALUES
 ('f15f0001-0000-4000-8000-000000000011', 'f15f0001-0000-4000-8000-000000000001', 'RPC-A1', 'RPC Test A1', true, true),
 ('f15f0001-0000-4000-8000-000000000012', 'f15f0001-0000-4000-8000-000000000001', 'RPC-A2', 'RPC Test A2', false, true),
 ('f15f0001-0000-4000-8000-000000000013', 'f15f0001-0000-4000-8000-000000000001', 'RPC-A3', 'RPC Test A3 - empty', false, true),
 ('f15f0001-0000-4000-8000-000000000021', 'f15f0001-0000-4000-8000-000000000002', 'RPC-B1', 'RPC Test B1', true, true),
 ('f15f0001-0000-4000-8000-000000000022', 'f15f0001-0000-4000-8000-000000000002', 'RPC-B2', 'RPC Test B2', false, true);

INSERT INTO public.tenant_memberships (tenant_id, user_id, branch_id, role, is_active)
VALUES
 ('f15f0001-0000-4000-8000-000000000001', 'f15f1001-0000-4000-8000-000000000001', NULL, 'owner', true),
 ('f15f0001-0000-4000-8000-000000000002', 'f15f1001-0000-4000-8000-000000000002', NULL, 'owner', true),
 ('f15f0001-0000-4000-8000-000000000001', 'f15f1001-0000-4000-8000-000000000003', 'f15f0001-0000-4000-8000-000000000011', 'cashier', true);

INSERT INTO public.products (id, tenant_id, product_code, name)
VALUES
 ('f15f0001-0000-4000-8000-000000000031', 'f15f0001-0000-4000-8000-000000000001', 'RPC-PROD-A', 'RPC Test Product A'),
 ('f15f0001-0000-4000-8000-000000000032', 'f15f0001-0000-4000-8000-000000000002', 'RPC-PROD-B', 'RPC Test Product B');

INSERT INTO public.inventory_items (id, tenant_id, branch_id, product_id, item_code, location_label)
VALUES
 ('f15f0001-0000-4000-8000-000000000041', 'f15f0001-0000-4000-8000-000000000001', 'f15f0001-0000-4000-8000-000000000011', 'f15f0001-0000-4000-8000-000000000031', 'RPC-ITEM-A1', 'RPC Test A1'),
 ('f15f0001-0000-4000-8000-000000000042', 'f15f0001-0000-4000-8000-000000000001', 'f15f0001-0000-4000-8000-000000000012', 'f15f0001-0000-4000-8000-000000000031', 'RPC-ITEM-A2', 'RPC Test A2'),
 ('f15f0001-0000-4000-8000-000000000043', 'f15f0001-0000-4000-8000-000000000002', 'f15f0001-0000-4000-8000-000000000021', 'f15f0001-0000-4000-8000-000000000032', 'RPC-ITEM-B1', 'RPC Test B1');

INSERT INTO public.sales (id, tenant_id, branch_id, sale_number, status)
VALUES
 ('f15f0001-0000-4000-8000-000000000051', 'f15f0001-0000-4000-8000-000000000001', 'f15f0001-0000-4000-8000-000000000011', 'RPC-SALE-A1', 'draft'),
 ('f15f0001-0000-4000-8000-000000000052', 'f15f0001-0000-4000-8000-000000000001', 'f15f0001-0000-4000-8000-000000000012', 'RPC-SALE-A2', 'draft'),
 ('f15f0001-0000-4000-8000-000000000053', 'f15f0001-0000-4000-8000-000000000002', 'f15f0001-0000-4000-8000-000000000021', 'RPC-SALE-B1', 'draft');

INSERT INTO public.inventory_stocktakes
  (id, tenant_id, branch_id, count_number, count_name, status, created_by)
VALUES
 ('f15f0001-0000-4000-8000-000000000061', 'f15f0001-0000-4000-8000-000000000001', 'f15f0001-0000-4000-8000-000000000011', 'RPC-ST-A1', 'RPC Test Stocktake A1', 'open', 'f15f1001-0000-4000-8000-000000000001'),
 ('f15f0001-0000-4000-8000-000000000062', 'f15f0001-0000-4000-8000-000000000002', 'f15f0001-0000-4000-8000-000000000021', 'RPC-ST-B1-OPEN', 'RPC Test Stocktake B1 Open', 'open', 'f15f1001-0000-4000-8000-000000000002'),
 ('f15f0001-0000-4000-8000-000000000063', 'f15f0001-0000-4000-8000-000000000002', 'f15f0001-0000-4000-8000-000000000021', 'RPC-ST-B1-COMPLETE', 'RPC Test Stocktake B1 Complete', 'completed', 'f15f1001-0000-4000-8000-000000000002');

-- Exercise all workflow states from the surviving validated status constraint.
INSERT INTO public.stock_transfers
  (id, tenant_id, transfer_code, from_branch_id, to_branch_id, status, created_by)
VALUES
 ('f15f0001-0000-4000-8000-000000000071', 'f15f0001-0000-4000-8000-000000000002', 'RPC-TR-DRAFT', 'f15f0001-0000-4000-8000-000000000021', 'f15f0001-0000-4000-8000-000000000022', 'draft', 'f15f1001-0000-4000-8000-000000000002'),
 ('f15f0001-0000-4000-8000-000000000072', 'f15f0001-0000-4000-8000-000000000002', 'RPC-TR-PENDING', 'f15f0001-0000-4000-8000-000000000021', 'f15f0001-0000-4000-8000-000000000022', 'pending_approval', 'f15f1001-0000-4000-8000-000000000002'),
 ('f15f0001-0000-4000-8000-000000000073', 'f15f0001-0000-4000-8000-000000000002', 'RPC-TR-APPROVED', 'f15f0001-0000-4000-8000-000000000021', 'f15f0001-0000-4000-8000-000000000022', 'approved', 'f15f1001-0000-4000-8000-000000000002'),
 ('f15f0001-0000-4000-8000-000000000074', 'f15f0001-0000-4000-8000-000000000002', 'RPC-TR-IN-TRANSIT', 'f15f0001-0000-4000-8000-000000000022', 'f15f0001-0000-4000-8000-000000000021', 'in_transit', 'f15f1001-0000-4000-8000-000000000002');

DO $status_fixture$
DECLARE n integer;
BEGIN
  SELECT count(*) INTO n FROM public.stock_transfers
  WHERE id IN ('f15f0001-0000-4000-8000-000000000071','f15f0001-0000-4000-8000-000000000072','f15f0001-0000-4000-8000-000000000073','f15f0001-0000-4000-8000-000000000074')
    AND status IN ('draft','pending_approval','approved','in_transit');
  IF n <> 4 THEN RAISE EXCEPTION 'Stock-transfer workflow status fixture was not accepted'; END IF;
END
$status_fixture$;

SET LOCAL ROLE authenticated;

-- Positive control: the authorized tenant owner can create a transfer in their shop.
SELECT set_config('request.jwt.claim.sub', 'f15f1001-0000-4000-8000-000000000001', true);
DO $positive$
DECLARE v_transfer uuid; v_message text;
BEGIN
  BEGIN
    v_transfer := public.create_stock_transfer(
      'f15f0001-0000-4000-8000-000000000001',
      'f15f0001-0000-4000-8000-000000000011',
      'f15f0001-0000-4000-8000-000000000012',
      'rollback-only positive control',
      NULL
    );
    INSERT INTO pg_temp.gold_workflow_rpc_results
      VALUES ('Owner A can create transfer between own branches', EXISTS(
        SELECT 1 FROM public.stock_transfers st
        WHERE st.id=v_transfer AND st.tenant_id='f15f0001-0000-4000-8000-000000000001' AND st.status='draft'
      ), 'transfer_id='||v_transfer::text);
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_message = MESSAGE_TEXT;
    INSERT INTO pg_temp.gold_workflow_rpc_results
      VALUES ('Owner A can create transfer between own branches', false, SQLSTATE||' '||v_message);
  END;
END
$positive$;

SELECT pg_temp.expect_rpc_error('add_stock_transfer_item blocks cross-tenant user',
  $$select public.add_stock_transfer_item('f15f0001-0000-4000-8000-000000000002','f15f0001-0000-4000-8000-000000000071','f15f0001-0000-4000-8000-000000000043','cross-tenant attempt')$$,
  ARRAY['Source branch access denied']);

SELECT pg_temp.expect_rpc_error('cancel_stock_transfer blocks cross-tenant user',
  $$select public.cancel_stock_transfer('f15f0001-0000-4000-8000-000000000002','f15f0001-0000-4000-8000-000000000071','Unauthorized cancel attempt')$$,
  ARRAY['Source branch cancellation access denied']);

SELECT pg_temp.expect_rpc_error('submit_stock_transfer blocks cross-tenant user',
  $$select public.submit_stock_transfer('f15f0001-0000-4000-8000-000000000002','f15f0001-0000-4000-8000-000000000071')$$,
  ARRAY['Source branch access denied']);

SELECT pg_temp.expect_rpc_error('review_stock_transfer blocks cross-tenant user',
  $$select public.review_stock_transfer('f15f0001-0000-4000-8000-000000000002','f15f0001-0000-4000-8000-000000000072','approve',NULL)$$,
  ARRAY['Approval or rejection requires manager access']);

SELECT pg_temp.expect_rpc_error('dispatch_stock_transfer blocks cross-tenant user',
  $$select public.dispatch_stock_transfer('f15f0001-0000-4000-8000-000000000002','f15f0001-0000-4000-8000-000000000073')$$,
  ARRAY['Source branch dispatch access denied']);

SELECT pg_temp.expect_rpc_error('receive_stock_transfer blocks cross-tenant user',
  $$select public.receive_stock_transfer('f15f0001-0000-4000-8000-000000000002','f15f0001-0000-4000-8000-000000000074','Unauthorized receive attempt')$$,
  ARRAY['Receiving branch access denied']);

SELECT pg_temp.expect_rpc_error('create_stock_transfer rejects cross-tenant destination branch',
  $$select public.create_stock_transfer('f15f0001-0000-4000-8000-000000000001','f15f0001-0000-4000-8000-000000000011','f15f0001-0000-4000-8000-000000000021','cross-tenant destination branch',NULL)$$,
  ARRAY['Both branches must be active branches of the same shop']);

-- Cashier is authenticated but lacks inventory-management and accounting roles.
SELECT set_config('request.jwt.claim.sub', 'f15f1001-0000-4000-8000-000000000003', true);

SELECT pg_temp.expect_rpc_error('Cashier cannot create stock transfer',
  $$select public.create_stock_transfer('f15f0001-0000-4000-8000-000000000001','f15f0001-0000-4000-8000-000000000011','f15f0001-0000-4000-8000-000000000012','cashier role test',NULL)$$,
  ARRAY['Transfer requires inventory-management access']);

SELECT pg_temp.expect_rpc_error('Cashier cannot start inventory stocktake',
  $$select public.create_inventory_stocktake('f15f0001-0000-4000-8000-000000000001','f15f0001-0000-4000-8000-000000000011','Cashier must not start stocktake')$$,
  ARRAY['permission to count stock in this branch']);

SELECT pg_temp.expect_rpc_error('Cashier cannot mark stocktake item',
  $$select public.mark_inventory_stocktake_item('f15f0001-0000-4000-8000-000000000001','f15f0001-0000-4000-8000-000000000061','f15f0001-0000-4000-8000-000000000041',true,'cashier attempt')$$,
  ARRAY['Stocktake branch access denied']);

SELECT pg_temp.expect_rpc_error('Cashier cannot revalue inventory',
  $$select public.revalue_inventory_item('f15f0001-0000-4000-8000-000000000001','f15f0001-0000-4000-8000-000000000011','f15f0001-0000-4000-8000-000000000041',100,'unauthorized cashier attempt',NULL)$$,
  ARRAY['Valuation permission denied']);

SELECT pg_temp.expect_rpc_error('Cashier cannot record consent in sibling branch',
  $$select public.record_customer_consent('f15f0001-0000-4000-8000-000000000001','f15f0001-0000-4000-8000-000000000012','f15f9001-0000-4000-8000-000000000001','promotional',true,'v1','staff_entry','{}'::jsonb)$$,
  ARRAY['Permission denied']);

-- The owner of tenant A must not operate on tenant B's financial/scheme objects.
SELECT set_config('request.jwt.claim.sub', 'f15f1001-0000-4000-8000-000000000001', true);

SELECT pg_temp.expect_rpc_error('request_refund blocks wrong tenant',
  $$select public.request_refund('f15f0001-0000-4000-8000-000000000002','f15f9001-0000-4000-8000-000000000001',1,'tenant scope test')$$,
  ARRAY['Permission denied']);

SELECT pg_temp.expect_rpc_error('review_refund_request blocks wrong tenant',
  $$select public.review_refund_request('f15f0001-0000-4000-8000-000000000002','f15f9001-0000-4000-8000-000000000001','approve',NULL)$$,
  ARRAY['Permission denied']);

SELECT pg_temp.expect_rpc_error('begin_razorpay_gateway_refund blocks wrong tenant',
  $$select public.begin_razorpay_gateway_refund('f15f0001-0000-4000-8000-000000000002','f15f9001-0000-4000-8000-000000000001')$$,
  ARRAY['Permission denied']);

SELECT pg_temp.expect_rpc_error('complete_manual_refund blocks wrong tenant',
  $$select public.complete_manual_refund('f15f0001-0000-4000-8000-000000000002','f15f9001-0000-4000-8000-000000000001','TEST-REF')$$,
  ARRAY['Permission denied']);

SELECT pg_temp.expect_rpc_error('review_provider_gold_rate blocks wrong tenant',
  $$select public.review_provider_gold_rate('f15f0001-0000-4000-8000-000000000002','f15f9001-0000-4000-8000-000000000001','verify',false)$$,
  ARRAY['Only a shop owner or manager']);

SELECT pg_temp.expect_rpc_error('set_scheme_lifecycle blocks wrong tenant',
  $$select public.set_scheme_lifecycle('f15f0001-0000-4000-8000-000000000002','f15f9001-0000-4000-8000-000000000001','pause')$$,
  ARRAY['Permission denied']);

SELECT pg_temp.expect_rpc_error('update_scheme_draft blocks wrong tenant',
  $$select public.update_scheme_draft('f15f0001-0000-4000-8000-000000000002','f15f9001-0000-4000-8000-000000000001','Tampered','test','custom','{}'::jsonb)$$,
  ARRAY['Permission denied']);

SELECT pg_temp.expect_rpc_error('void_draft_credit_note blocks wrong tenant',
  $$select public.void_draft_credit_note('f15f0001-0000-4000-8000-000000000002','f15f9001-0000-4000-8000-000000000001','authorization test')$$,
  ARRAY['Permission denied']);

SELECT pg_temp.expect_rpc_error('create_credit_note_draft blocks wrong tenant',
  $$select public.create_credit_note_draft('f15f0001-0000-4000-8000-000000000002','f15f9001-0000-4000-8000-000000000001','testing','[{"invoice_line_id":"f15f9001-0000-4000-8000-000000000002","quantity":1}]'::jsonb)$$,
  ARRAY['Permission denied']);

SELECT pg_temp.expect_rpc_error('finalize_inventory_stocktake blocks wrong tenant',
  $$select public.finalize_inventory_stocktake('f15f0001-0000-4000-8000-000000000002','f15f0001-0000-4000-8000-000000000062')$$,
  ARRAY['finalise and review stock discrepancies']);

SELECT pg_temp.expect_rpc_error('resolve_inventory_stocktake_discrepancy blocks wrong tenant',
  $$select public.resolve_inventory_stocktake_discrepancy('f15f0001-0000-4000-8000-000000000002','f15f0001-0000-4000-8000-000000000063','f15f9001-0000-4000-8000-000000000003','write_off','authorization test')$$,
  ARRAY['Only an owner or manager can resolve stocktake discrepancies']);

-- UUID tampering: authorized A scope plus a B inventory UUID must not pass as A stock.
SELECT pg_temp.expect_rpc_error('create_draft_invoice prevents cross-tenant inventory UUID tampering',
  $$select public.create_draft_invoice_for_inventory_item('f15f0001-0000-4000-8000-000000000001','f15f0001-0000-4000-8000-000000000011','f15f9001-0000-4000-8000-000000000004','f15f0001-0000-4000-8000-000000000043',0,0)$$,
  ARRAY['Stock item was not found in this shop']);

SELECT pg_temp.expect_rpc_error('create_draft_invoice blocks owner from wrong tenant branch',
  $$select public.create_draft_invoice_for_inventory_item('f15f0001-0000-4000-8000-000000000002','f15f0001-0000-4000-8000-000000000021','f15f9001-0000-4000-8000-000000000004','f15f0001-0000-4000-8000-000000000043',0,0)$$,
  ARRAY['Permission denied']);

RESET ROLE;

SELECT test_name, passed, detail FROM pg_temp.gold_workflow_rpc_results ORDER BY test_name;

ROLLBACK;
