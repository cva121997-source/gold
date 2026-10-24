-- Tenant/branch RLS regression test for the current Gold schema.
--
-- SAFETY: Run the WHOLE script in one SQL request/session. It creates synthetic
-- Auth and business rows inside one transaction and ends with ROLLBACK. Do not
-- remove the final ROLLBACK or run selected portions independently.
-- This script does not create a Supabase branch, add privileges, or alter schema.

BEGIN;

CREATE TEMP TABLE gold_tenant_isolation_results (
  test_name text PRIMARY KEY,
  passed boolean NOT NULL,
  detail text NOT NULL
) ON COMMIT DROP;
GRANT SELECT, INSERT ON pg_temp.gold_tenant_isolation_results TO authenticated;

DO $guard$
BEGIN
  IF EXISTS (
    SELECT 1 FROM auth.users
    WHERE id IN (
      'f15e1001-0000-4000-8000-000000000001'::uuid,
      'f15e1001-0000-4000-8000-000000000002'::uuid,
      'f15e1001-0000-4000-8000-000000000003'::uuid
    )
    OR email IN (
      'gold-iso-owner-a-20261024@example.invalid',
      'gold-iso-owner-b-20261024@example.invalid',
      'gold-iso-staff-a1-20261024@example.invalid'
    )
  ) OR EXISTS (
    SELECT 1 FROM public.tenants
    WHERE id IN (
      'f15e0001-0000-4000-8000-000000000001'::uuid,
      'f15e0001-0000-4000-8000-000000000002'::uuid
    )
  ) THEN
    RAISE EXCEPTION 'Isolation test fixture identifier collision; refusing to run.';
  END IF;
END
$guard$;

-- Fake, confirmed Auth users only exist within this transaction. The Auth
-- trigger-created profiles and tenant-created scheme drafts roll back too.
INSERT INTO auth.users
  (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
   raw_app_meta_data, raw_user_meta_data, created_at, updated_at, is_sso_user, is_anonymous)
VALUES
  (NULL, 'f15e1001-0000-4000-8000-000000000001', 'authenticated', 'authenticated',
   'gold-iso-owner-a-20261024@example.invalid', '', now(),
   '{"provider":"email","providers":["email"]}'::jsonb, '{"display_name":"ISO Owner A"}'::jsonb,
   now(), now(), false, false),
  (NULL, 'f15e1001-0000-4000-8000-000000000002', 'authenticated', 'authenticated',
   'gold-iso-owner-b-20261024@example.invalid', '', now(),
   '{"provider":"email","providers":["email"]}'::jsonb, '{"display_name":"ISO Owner B"}'::jsonb,
   now(), now(), false, false),
  (NULL, 'f15e1001-0000-4000-8000-000000000003', 'authenticated', 'authenticated',
   'gold-iso-staff-a1-20261024@example.invalid', '', now(),
   '{"provider":"email","providers":["email"]}'::jsonb, '{"display_name":"ISO Staff A1"}'::jsonb,
   now(), now(), false, false);

SELECT set_config('request.jwt.claim.sub', 'f15e1001-0000-4000-8000-000000000001', true);

INSERT INTO public.tenants (id, code, slug, display_name, status, country_code, timezone, default_currency)
VALUES
 ('f15e0001-0000-4000-8000-000000000001', 'ISO_TEST_A_20261024', 'iso-test-a-20261024', 'Isolation Test Tenant A', 'trial', 'IN', 'Asia/Kolkata', 'INR'),
 ('f15e0001-0000-4000-8000-000000000002', 'ISO_TEST_B_20261024', 'iso-test-b-20261024', 'Isolation Test Tenant B', 'trial', 'IN', 'Asia/Kolkata', 'INR');

INSERT INTO public.branches (id, tenant_id, branch_code, name, is_default, is_active)
VALUES
 ('f15e0001-0000-4000-8000-000000000011', 'f15e0001-0000-4000-8000-000000000001', 'ISO-A1', 'Isolation Test A1', true, true),
 ('f15e0001-0000-4000-8000-000000000012', 'f15e0001-0000-4000-8000-000000000001', 'ISO-A2', 'Isolation Test A2', false, true),
 ('f15e0001-0000-4000-8000-000000000013', 'f15e0001-0000-4000-8000-000000000001', 'ISO-A3', 'Isolation Test A3 - no children', false, true),
 ('f15e0001-0000-4000-8000-000000000021', 'f15e0001-0000-4000-8000-000000000002', 'ISO-B1', 'Isolation Test B1', true, true);

INSERT INTO public.tenant_memberships (tenant_id, user_id, branch_id, role, is_active)
VALUES
 ('f15e0001-0000-4000-8000-000000000001', 'f15e1001-0000-4000-8000-000000000001', NULL, 'owner', true),
 ('f15e0001-0000-4000-8000-000000000002', 'f15e1001-0000-4000-8000-000000000002', NULL, 'owner', true),
 ('f15e0001-0000-4000-8000-000000000001', 'f15e1001-0000-4000-8000-000000000003', 'f15e0001-0000-4000-8000-000000000011', 'cashier', true);

INSERT INTO public.products (id, tenant_id, product_code, name)
VALUES
 ('f15e0001-0000-4000-8000-000000000031', 'f15e0001-0000-4000-8000-000000000001', 'ISO-PROD-A', 'Isolation Test Product A'),
 ('f15e0001-0000-4000-8000-000000000032', 'f15e0001-0000-4000-8000-000000000002', 'ISO-PROD-B', 'Isolation Test Product B');

INSERT INTO public.inventory_items (id, tenant_id, branch_id, product_id, item_code, location_label)
VALUES
 ('f15e0001-0000-4000-8000-000000000041', 'f15e0001-0000-4000-8000-000000000001', 'f15e0001-0000-4000-8000-000000000011', 'f15e0001-0000-4000-8000-000000000031', 'ISO-ITEM-A1', 'Test A1'),
 ('f15e0001-0000-4000-8000-000000000042', 'f15e0001-0000-4000-8000-000000000001', 'f15e0001-0000-4000-8000-000000000012', 'f15e0001-0000-4000-8000-000000000031', 'ISO-ITEM-A2', 'Test A2'),
 ('f15e0001-0000-4000-8000-000000000043', 'f15e0001-0000-4000-8000-000000000002', 'f15e0001-0000-4000-8000-000000000021', 'f15e0001-0000-4000-8000-000000000032', 'ISO-ITEM-B1', 'Test B1');

INSERT INTO public.sales (id, tenant_id, branch_id, sale_number, status)
VALUES
 ('f15e0001-0000-4000-8000-000000000051', 'f15e0001-0000-4000-8000-000000000001', 'f15e0001-0000-4000-8000-000000000011', 'ISO-SALE-A1', 'draft'),
 ('f15e0001-0000-4000-8000-000000000052', 'f15e0001-0000-4000-8000-000000000001', 'f15e0001-0000-4000-8000-000000000012', 'ISO-SALE-A2', 'draft'),
 ('f15e0001-0000-4000-8000-000000000053', 'f15e0001-0000-4000-8000-000000000002', 'f15e0001-0000-4000-8000-000000000021', 'ISO-SALE-B1', 'draft');

SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', 'f15e1001-0000-4000-8000-000000000001', true);

DO $owner_a_tests$
DECLARE n integer; changed integer;
BEGIN
  SELECT count(*) INTO n FROM public.tenants WHERE id='f15e0001-0000-4000-8000-000000000001';
  INSERT INTO pg_temp.gold_tenant_isolation_results VALUES ('Owner A reads own tenant', n=1, 'visible_rows='||n);
  SELECT count(*) INTO n FROM public.tenants WHERE id='f15e0001-0000-4000-8000-000000000002';
  INSERT INTO pg_temp.gold_tenant_isolation_results VALUES ('Owner A cannot read tenant B by UUID', n=0, 'visible_rows='||n);
  SELECT count(*) INTO n FROM public.branches WHERE id='f15e0001-0000-4000-8000-000000000021';
  INSERT INTO pg_temp.gold_tenant_isolation_results VALUES ('Owner A cannot read tenant B branch by UUID', n=0, 'visible_rows='||n);
  SELECT count(*) INTO n FROM public.products WHERE id='f15e0001-0000-4000-8000-000000000032';
  INSERT INTO pg_temp.gold_tenant_isolation_results VALUES ('Owner A cannot read tenant B product by UUID', n=0, 'visible_rows='||n);
  SELECT count(*) INTO n FROM public.inventory_items WHERE id='f15e0001-0000-4000-8000-000000000043';
  INSERT INTO pg_temp.gold_tenant_isolation_results VALUES ('Owner A cannot read tenant B inventory by UUID', n=0, 'visible_rows='||n);
  SELECT count(*) INTO n FROM public.sales WHERE id='f15e0001-0000-4000-8000-000000000053';
  INSERT INTO pg_temp.gold_tenant_isolation_results VALUES ('Owner A cannot read tenant B sale by UUID', n=0, 'visible_rows='||n);

  UPDATE public.branches SET name=name WHERE id='f15e0001-0000-4000-8000-000000000021';
  GET DIAGNOSTICS changed = ROW_COUNT;
  INSERT INTO pg_temp.gold_tenant_isolation_results VALUES ('Owner A cross-tenant branch update affects zero rows', changed=0, 'affected_rows='||changed);

  BEGIN
    INSERT INTO public.calculator_quotes
      (tenant_id, branch_id, quote_code, gold_rate_snapshot, weight_grams, gold_value,
       making_charge_mode, taxable_subtotal, total_amount, created_by)
    VALUES
      ('f15e0001-0000-4000-8000-000000000002','f15e0001-0000-4000-8000-000000000021',
       'ISO-CROSS-TENANT-QUOTE',0,0,0,'fixed',0,0,'f15e1001-0000-4000-8000-000000000001');
    INSERT INTO pg_temp.gold_tenant_isolation_results VALUES ('Owner A cannot insert quote into tenant B', false, 'insert unexpectedly succeeded');
  EXCEPTION WHEN insufficient_privilege THEN
    INSERT INTO pg_temp.gold_tenant_isolation_results VALUES ('Owner A cannot insert quote into tenant B', true, 'rejected by RLS');
  WHEN OTHERS THEN
    INSERT INTO pg_temp.gold_tenant_isolation_results VALUES ('Owner A cannot insert quote into tenant B', false, SQLSTATE||' '||SQLERRM);
  END;

  BEGIN
    UPDATE public.branches SET tenant_id='f15e0001-0000-4000-8000-000000000002'
    WHERE id='f15e0001-0000-4000-8000-000000000013';
    GET DIAGNOSTICS changed = ROW_COUNT;
    IF changed=0 THEN
      INSERT INTO pg_temp.gold_tenant_isolation_results VALUES ('Owner A cannot reassign branch A3 to tenant B', true, 'affected_rows=0');
    ELSE
      INSERT INTO pg_temp.gold_tenant_isolation_results VALUES ('Owner A cannot reassign branch A3 to tenant B', false, 'affected_rows='||changed);
    END IF;
  EXCEPTION WHEN insufficient_privilege THEN
    INSERT INTO pg_temp.gold_tenant_isolation_results VALUES ('Owner A cannot reassign branch A3 to tenant B', true, 'rejected by RLS WITH CHECK');
  WHEN OTHERS THEN
    INSERT INTO pg_temp.gold_tenant_isolation_results VALUES ('Owner A cannot reassign branch A3 to tenant B', false, SQLSTATE||' '||SQLERRM);
  END;

  SELECT count(*) INTO n FROM public.branches WHERE id='f15e0001-0000-4000-8000-000000000013' AND tenant_id='f15e0001-0000-4000-8000-000000000001';
  INSERT INTO pg_temp.gold_tenant_isolation_results VALUES ('Branch A3 stays in tenant A after tampering attempt', n=1, 'matching_rows='||n);
END
$owner_a_tests$;

SELECT set_config('request.jwt.claim.sub', 'f15e1001-0000-4000-8000-000000000002', true);

DO $owner_b_tests$
DECLARE n integer;
BEGIN
  SELECT count(*) INTO n FROM public.tenants WHERE id='f15e0001-0000-4000-8000-000000000002';
  INSERT INTO pg_temp.gold_tenant_isolation_results VALUES ('Owner B reads own tenant', n=1, 'visible_rows='||n);
  SELECT count(*) INTO n FROM public.tenants WHERE id='f15e0001-0000-4000-8000-000000000001';
  INSERT INTO pg_temp.gold_tenant_isolation_results VALUES ('Owner B cannot read tenant A by UUID', n=0, 'visible_rows='||n);
  SELECT count(*) INTO n FROM public.inventory_items WHERE id='f15e0001-0000-4000-8000-000000000041';
  INSERT INTO pg_temp.gold_tenant_isolation_results VALUES ('Owner B cannot read tenant A inventory by UUID', n=0, 'visible_rows='||n);
END
$owner_b_tests$;

SELECT set_config('request.jwt.claim.sub', 'f15e1001-0000-4000-8000-000000000003', true);

DO $staff_tests$
DECLARE n integer; changed integer;
BEGIN
  SELECT count(*) INTO n FROM public.branches WHERE id='f15e0001-0000-4000-8000-000000000011';
  INSERT INTO pg_temp.gold_tenant_isolation_results VALUES ('A1 cashier reads assigned branch', n=1, 'visible_rows='||n);
  SELECT count(*) INTO n FROM public.branches WHERE id='f15e0001-0000-4000-8000-000000000012';
  INSERT INTO pg_temp.gold_tenant_isolation_results VALUES ('A1 cashier cannot read sibling branch', n=0, 'visible_rows='||n);
  SELECT count(*) INTO n FROM public.branches WHERE id='f15e0001-0000-4000-8000-000000000021';
  INSERT INTO pg_temp.gold_tenant_isolation_results VALUES ('A1 cashier cannot read tenant B branch', n=0, 'visible_rows='||n);
  SELECT count(*) INTO n FROM public.products WHERE id='f15e0001-0000-4000-8000-000000000031';
  INSERT INTO pg_temp.gold_tenant_isolation_results VALUES ('A1 cashier can read tenant A product', n=1, 'visible_rows='||n);
  SELECT count(*) INTO n FROM public.products WHERE id='f15e0001-0000-4000-8000-000000000032';
  INSERT INTO pg_temp.gold_tenant_isolation_results VALUES ('A1 cashier cannot read tenant B product', n=0, 'visible_rows='||n);
  SELECT count(*) INTO n FROM public.inventory_items WHERE id='f15e0001-0000-4000-8000-000000000041';
  INSERT INTO pg_temp.gold_tenant_isolation_results VALUES ('A1 cashier reads assigned inventory', n=1, 'visible_rows='||n);
  SELECT count(*) INTO n FROM public.inventory_items WHERE id='f15e0001-0000-4000-8000-000000000042';
  INSERT INTO pg_temp.gold_tenant_isolation_results VALUES ('A1 cashier cannot read sibling inventory', n=0, 'visible_rows='||n);
  SELECT count(*) INTO n FROM public.inventory_items WHERE id='f15e0001-0000-4000-8000-000000000043';
  INSERT INTO pg_temp.gold_tenant_isolation_results VALUES ('A1 cashier cannot read tenant B inventory', n=0, 'visible_rows='||n);
  SELECT count(*) INTO n FROM public.sales WHERE id='f15e0001-0000-4000-8000-000000000051';
  INSERT INTO pg_temp.gold_tenant_isolation_results VALUES ('A1 cashier reads assigned sale', n=1, 'visible_rows='||n);
  SELECT count(*) INTO n FROM public.sales WHERE id='f15e0001-0000-4000-8000-000000000052';
  INSERT INTO pg_temp.gold_tenant_isolation_results VALUES ('A1 cashier cannot read sibling sale', n=0, 'visible_rows='||n);
  SELECT count(*) INTO n FROM public.sales WHERE id='f15e0001-0000-4000-8000-000000000053';
  INSERT INTO pg_temp.gold_tenant_isolation_results VALUES ('A1 cashier cannot read tenant B sale', n=0, 'visible_rows='||n);

  UPDATE public.branches SET name=name WHERE id='f15e0001-0000-4000-8000-000000000011';
  GET DIAGNOSTICS changed = ROW_COUNT;
  INSERT INTO pg_temp.gold_tenant_isolation_results VALUES ('A1 cashier cannot update branch record directly', changed=0, 'affected_rows='||changed);

  INSERT INTO public.calculator_quotes
    (tenant_id, branch_id, quote_code, gold_rate_snapshot, weight_grams, gold_value,
     making_charge_mode, taxable_subtotal, total_amount, created_by)
  VALUES
    ('f15e0001-0000-4000-8000-000000000001','f15e0001-0000-4000-8000-000000000011',
     'ISO-QUOTE-A1',0,0,0,'fixed',0,0,'f15e1001-0000-4000-8000-000000000003');
  INSERT INTO pg_temp.gold_tenant_isolation_results VALUES ('A1 cashier can insert quote in assigned branch', true, 'insert succeeded');

  BEGIN
    INSERT INTO public.calculator_quotes
      (tenant_id, branch_id, quote_code, gold_rate_snapshot, weight_grams, gold_value,
       making_charge_mode, taxable_subtotal, total_amount, created_by)
    VALUES
      ('f15e0001-0000-4000-8000-000000000001','f15e0001-0000-4000-8000-000000000012',
       'ISO-QUOTE-A2',0,0,0,'fixed',0,0,'f15e1001-0000-4000-8000-000000000003');
    INSERT INTO pg_temp.gold_tenant_isolation_results VALUES ('A1 cashier cannot insert quote in sibling branch', false, 'insert unexpectedly succeeded');
  EXCEPTION WHEN insufficient_privilege THEN
    INSERT INTO pg_temp.gold_tenant_isolation_results VALUES ('A1 cashier cannot insert quote in sibling branch', true, 'rejected by RLS');
  WHEN OTHERS THEN
    INSERT INTO pg_temp.gold_tenant_isolation_results VALUES ('A1 cashier cannot insert quote in sibling branch', false, SQLSTATE||' '||SQLERRM);
  END;

  BEGIN
    INSERT INTO public.calculator_quotes
      (tenant_id, branch_id, quote_code, gold_rate_snapshot, weight_grams, gold_value,
       making_charge_mode, taxable_subtotal, total_amount, created_by)
    VALUES
      ('f15e0001-0000-4000-8000-000000000002','f15e0001-0000-4000-8000-000000000021',
       'ISO-QUOTE-B1',0,0,0,'fixed',0,0,'f15e1001-0000-4000-8000-000000000003');
    INSERT INTO pg_temp.gold_tenant_isolation_results VALUES ('A1 cashier cannot insert quote in tenant B', false, 'insert unexpectedly succeeded');
  EXCEPTION WHEN insufficient_privilege THEN
    INSERT INTO pg_temp.gold_tenant_isolation_results VALUES ('A1 cashier cannot insert quote in tenant B', true, 'rejected by RLS');
  WHEN OTHERS THEN
    INSERT INTO pg_temp.gold_tenant_isolation_results VALUES ('A1 cashier cannot insert quote in tenant B', false, SQLSTATE||' '||SQLERRM);
  END;
END
$staff_tests$;

RESET ROLE;

SELECT test_name, passed, detail FROM pg_temp.gold_tenant_isolation_results ORDER BY test_name;

ROLLBACK;
