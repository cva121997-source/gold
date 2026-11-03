-- Business workflow success-path regression suite for the Gold schema.
--
-- SAFETY: Execute this entire file in ONE SQL request/session. It creates one
-- synthetic tenant, owner, supplier, statement payments, invoice and generated
-- workflow records inside a transaction and ends with ROLLBACK. Keep the final
-- ROLLBACK; do not execute selected fragments independently.
-- This script makes no schema changes and grants access only to its temp result table.

BEGIN;

CREATE TEMP TABLE gold_business_workflow_results (
  test_name text PRIMARY KEY,
  passed boolean NOT NULL,
  detail text NOT NULL
) ON COMMIT DROP;
GRANT SELECT, INSERT ON pg_temp.gold_business_workflow_results TO authenticated;

DO $guard$
BEGIN
  IF EXISTS (
    SELECT 1 FROM auth.users
    WHERE id = 'f17f1001-0000-4000-8000-000000000001'::uuid
       OR email = 'gold-stage7-owner-20261103@example.invalid'
  ) OR EXISTS (
    SELECT 1 FROM public.tenants
    WHERE id = 'f17f0001-0000-4000-8000-000000000001'::uuid
       OR code = 'STAGE7_TEST_20261103'
  ) OR EXISTS (
    SELECT 1 FROM public.supplier_bills
    WHERE id = 'f17f0001-0000-4000-8000-000000000041'::uuid
  ) THEN
    RAISE EXCEPTION 'Stage 7 fixture collision; refusing to run.';
  END IF;
END
$guard$;

INSERT INTO auth.users
  (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
   raw_app_meta_data, raw_user_meta_data, created_at, updated_at, is_sso_user, is_anonymous)
VALUES
  (NULL, 'f17f1001-0000-4000-8000-000000000001', 'authenticated', 'authenticated',
   'gold-stage7-owner-20261103@example.invalid', '', now(),
   '{"provider":"email","providers":["email"]}'::jsonb,
   '{"display_name":"Stage 7 Workflow Owner"}'::jsonb,
   now(), now(), false, false);

SELECT set_config('request.jwt.claim.sub', 'f17f1001-0000-4000-8000-000000000001', true);

INSERT INTO public.tenants
  (id, code, slug, display_name, status, country_code, timezone, default_currency)
VALUES
  ('f17f0001-0000-4000-8000-000000000001',
   'STAGE7_TEST_20261103', 'stage7-test-20261103', 'Stage 7 Rollback Test Tenant',
   'trial', 'IN', 'Asia/Kolkata', 'INR');

INSERT INTO public.branches
  (id, tenant_id, branch_code, name, is_default, is_active)
VALUES
  ('f17f0001-0000-4000-8000-000000000011',
   'f17f0001-0000-4000-8000-000000000001', 'STG7-A1',
   'Stage 7 Rollback Test Branch', true, true);

INSERT INTO public.tenant_memberships
  (tenant_id, user_id, branch_id, role, is_active)
VALUES
  ('f17f0001-0000-4000-8000-000000000001',
   'f17f1001-0000-4000-8000-000000000001', NULL, 'owner', true);

INSERT INTO public.suppliers
  (id, tenant_id, supplier_code, name, is_active)
VALUES
  ('f17f0001-0000-4000-8000-000000000031',
   'f17f0001-0000-4000-8000-000000000001',
   'STG7-SUP-001', 'Stage 7 Test Supplier', true);

-- Synthetic confirmed Razorpay ledger rows used by the statement importer.
INSERT INTO public.payments
  (id, tenant_id, branch_id, payment_method, status, amount, currency,
   provider, provider_payment_ref, idempotency_key, confirmation_source,
   confirmed_by, confirmed_at, metadata)
VALUES
  ('f17f0001-0000-4000-8000-000000000051',
   'f17f0001-0000-4000-8000-000000000001',
   'f17f0001-0000-4000-8000-000000000011',
   'gateway', 'confirmed', 75, 'INR', 'razorpay', 'STAGE7-RZP-75-REF',
   'stage7-recon-ledger-75', 'provider_webhook',
   'f17f1001-0000-4000-8000-000000000001', now(), '{}'::jsonb),
  ('f17f0001-0000-4000-8000-000000000052',
   'f17f0001-0000-4000-8000-000000000001',
   'f17f0001-0000-4000-8000-000000000011',
   'gateway', 'confirmed', 25, 'INR', 'razorpay', 'STAGE7-RZP-25-REF',
   'stage7-recon-ledger-25', 'provider_webhook',
   'f17f1001-0000-4000-8000-000000000001', now(), '{}'::jsonb);

INSERT INTO public.reconciliation_records
  (id, tenant_id, branch_id, provider, period_start, period_end, expected_amount, actual_amount, status, notes)
VALUES
  ('f17f0001-0000-4000-8000-000000000061',
   'f17f0001-0000-4000-8000-000000000001',
   'f17f0001-0000-4000-8000-000000000011',
   'razorpay', current_date, current_date, 75, 0, 'open', 'Stage 7 exact-match test'),
  ('f17f0001-0000-4000-8000-000000000062',
   'f17f0001-0000-4000-8000-000000000001',
   'f17f0001-0000-4000-8000-000000000011',
   'razorpay', current_date, current_date, 25, 0, 'open', 'Stage 7 unresolved-line test');

SET LOCAL ROLE authenticated;

DO $suite$
DECLARE
  v_tenant uuid := 'f17f0001-0000-4000-8000-000000000001';
  v_branch uuid := 'f17f0001-0000-4000-8000-000000000011';
  v_bill uuid := 'f17f0001-0000-4000-8000-000000000041';
  v_p1 uuid;
  v_p1_repeat uuid;
  v_p2 uuid;
  v_post jsonb;
  v_reverse jsonb;
  v_import jsonb;
  v_status text;
  v_paid numeric(14,2);
  v_total numeric(14,2);
  v_actual numeric(14,2);
  v_difference numeric(14,2);
  v_line_status text;
  v_count integer;
  v_invoice uuid;
  v_invoice_line uuid;
  v_credit_note uuid;
  v_message text;
BEGIN
  -- Supplier bill draft -> posted, deriving totals from generated bill-line fields.
  BEGIN
    INSERT INTO public.supplier_bills
      (id, tenant_id, branch_id, supplier_id, supplier_invoice_number, status, notes)
    VALUES
      (v_bill, v_tenant, v_branch,
       'f17f0001-0000-4000-8000-000000000031',
       'STAGE7-SUP-INV-001', 'draft', 'Rollback-only successful posting test');

    INSERT INTO public.supplier_bill_lines
      (tenant_id, supplier_bill_id, description, quantity, unit_cost, tax_rate)
    VALUES
      (v_tenant, v_bill, 'Stage 7 sample gold component', 1, 100, 10);

    v_post := public.post_supplier_bill(v_tenant, v_bill);
    SELECT status, total_amount INTO v_status, v_total
    FROM public.supplier_bills WHERE tenant_id = v_tenant AND id = v_bill;

    INSERT INTO pg_temp.gold_business_workflow_results
    VALUES (
      'Supplier bill posts with generated subtotal, tax and total',
      v_status = 'posted' AND v_total = 110
        AND (v_post->>'subtotal')::numeric = 100
        AND (v_post->>'tax_amount')::numeric = 10
        AND (v_post->>'total_amount')::numeric = 110,
      'rpc=' || v_post::text || '; stored_status=' || coalesce(v_status, 'NULL')
        || '; stored_total=' || coalesce(v_total::text, 'NULL')
    );
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_message = MESSAGE_TEXT;
    INSERT INTO pg_temp.gold_business_workflow_results
    VALUES ('Supplier bill posts with generated subtotal, tax and total',
      false, SQLSTATE || ' ' || v_message);
  END;

  -- First partial payment.
  BEGIN
    v_p1 := public.record_supplier_bill_payment(
      v_tenant, v_bill, 40, 'upi', 'STAGE7-PAY-40',
      current_date, 'stage7-supplier-payment-40-a'
    );
    SELECT status, paid_amount INTO v_status, v_paid
    FROM public.supplier_bills WHERE tenant_id = v_tenant AND id = v_bill;

    INSERT INTO pg_temp.gold_business_workflow_results
    VALUES ('Supplier bill accepts partial payment and remains partially_paid',
      v_p1 IS NOT NULL AND v_status = 'partially_paid' AND v_paid = 40,
      'payment_id=' || coalesce(v_p1::text, 'NULL')
        || '; status=' || coalesce(v_status, 'NULL')
        || '; paid_amount=' || coalesce(v_paid::text, 'NULL'));
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_message = MESSAGE_TEXT;
    INSERT INTO pg_temp.gold_business_workflow_results
    VALUES ('Supplier bill accepts partial payment and remains partially_paid',
      false, SQLSTATE || ' ' || v_message);
  END;

  -- Retrying the same operation with the same key must return the original row,
  -- without applying the money twice.
  BEGIN
    v_p1_repeat := public.record_supplier_bill_payment(
      v_tenant, v_bill, 40, 'upi', 'STAGE7-PAY-40',
      current_date, 'stage7-supplier-payment-40-a'
    );
    SELECT status, paid_amount INTO v_status, v_paid
    FROM public.supplier_bills WHERE tenant_id = v_tenant AND id = v_bill;
    SELECT count(*) INTO v_count FROM public.supplier_bill_payments
    WHERE tenant_id = v_tenant AND idempotency_key = 'stage7-supplier-payment-40-a';

    INSERT INTO pg_temp.gold_business_workflow_results
    VALUES ('Supplier payment idempotency prevents double posting',
      v_p1 IS NOT NULL AND v_p1_repeat = v_p1 AND v_count = 1
        AND v_status = 'partially_paid' AND v_paid = 40,
      'first_id=' || coalesce(v_p1::text, 'NULL')
        || '; retry_id=' || coalesce(v_p1_repeat::text, 'NULL')
        || '; rows=' || v_count || '; paid_amount=' || coalesce(v_paid::text, 'NULL'));
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_message = MESSAGE_TEXT;
    INSERT INTO pg_temp.gold_business_workflow_results
    VALUES ('Supplier payment idempotency prevents double posting',
      false, SQLSTATE || ' ' || v_message);
  END;

  -- Final payment settles the bill.
  BEGIN
    v_p2 := public.record_supplier_bill_payment(
      v_tenant, v_bill, 70, 'bank_transfer', 'STAGE7-PAY-70',
      current_date, 'stage7-supplier-payment-70-b'
    );
    SELECT status, paid_amount INTO v_status, v_paid
    FROM public.supplier_bills WHERE tenant_id = v_tenant AND id = v_bill;

    INSERT INTO pg_temp.gold_business_workflow_results
    VALUES ('Supplier bill becomes paid after its remaining balance is paid',
      v_p2 IS NOT NULL AND v_status = 'paid' AND v_paid = 110,
      'payment_id=' || coalesce(v_p2::text, 'NULL')
        || '; status=' || coalesce(v_status, 'NULL')
        || '; paid_amount=' || coalesce(v_paid::text, 'NULL'));
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_message = MESSAGE_TEXT;
    INSERT INTO pg_temp.gold_business_workflow_results
    VALUES ('Supplier bill becomes paid after its remaining balance is paid',
      false, SQLSTATE || ' ' || v_message);
  END;

  -- Reverse the final 70 payment, then the original 40 payment.
  BEGIN
    v_reverse := public.reverse_supplier_bill_payment(
      v_tenant, v_p2, 'Stage 7 test reversal of final payment'
    );
    SELECT status, paid_amount INTO v_status, v_paid
    FROM public.supplier_bills WHERE tenant_id = v_tenant AND id = v_bill;

    INSERT INTO pg_temp.gold_business_workflow_results
    VALUES ('Reversing final supplier payment restores partial balance',
      v_reverse->>'status' = 'reversed' AND v_status = 'partially_paid' AND v_paid = 40,
      'rpc=' || coalesce(v_reverse::text, 'NULL')
        || '; bill_status=' || coalesce(v_status, 'NULL')
        || '; paid_amount=' || coalesce(v_paid::text, 'NULL'));
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_message = MESSAGE_TEXT;
    INSERT INTO pg_temp.gold_business_workflow_results
    VALUES ('Reversing final supplier payment restores partial balance',
      false, SQLSTATE || ' ' || v_message);
  END;

  BEGIN
    v_reverse := public.reverse_supplier_bill_payment(
      v_tenant, v_p1, 'Stage 7 test reversal of first payment'
    );
    SELECT status, paid_amount INTO v_status, v_paid
    FROM public.supplier_bills WHERE tenant_id = v_tenant AND id = v_bill;

    INSERT INTO pg_temp.gold_business_workflow_results
    VALUES ('Reversing all supplier payments restores posted open balance',
      v_reverse->>'status' = 'reversed' AND v_status = 'posted' AND v_paid = 0,
      'rpc=' || coalesce(v_reverse::text, 'NULL')
        || '; bill_status=' || coalesce(v_status, 'NULL')
        || '; paid_amount=' || coalesce(v_paid::text, 'NULL'));
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_message = MESSAGE_TEXT;
    INSERT INTO pg_temp.gold_business_workflow_results
    VALUES ('Reversing all supplier payments restores posted open balance',
      false, SQLSTATE || ' ' || v_message);
  END;

  -- Import one exact provider payment match and verify the reconciliation period.
  BEGIN
    v_import := public.import_reconciliation_statement_lines(
      v_tenant,
      'f17f0001-0000-4000-8000-000000000061',
      jsonb_build_array(jsonb_build_object(
        'transaction_date', to_char(current_date, 'YYYY-MM-DD'),
        'provider_reference', 'STAGE7-RZP-75-REF',
        'amount', 75, 'currency', 'INR', 'description', 'Stage 7 exact match'
      ))
    );
    SELECT status, actual_amount, difference_amount
      INTO v_status, v_actual, v_difference
    FROM public.reconciliation_records
    WHERE tenant_id = v_tenant AND id = 'f17f0001-0000-4000-8000-000000000061';
    SELECT line_status INTO v_line_status
    FROM public.reconciliation_statement_lines
    WHERE tenant_id = v_tenant
      AND reconciliation_id = 'f17f0001-0000-4000-8000-000000000061';

    INSERT INTO pg_temp.gold_business_workflow_results
    VALUES ('Exact statement payment match reconciles the period',
      (v_import->>'inserted')::integer = 1 AND v_line_status = 'matched'
        AND v_status = 'matched' AND v_actual = 75 AND v_difference = 0,
      'rpc=' || v_import::text || '; line_status=' || coalesce(v_line_status, 'NULL')
        || '; reconciliation_status=' || coalesce(v_status, 'NULL')
        || '; actual=' || coalesce(v_actual::text, 'NULL')
        || '; difference=' || coalesce(v_difference::text, 'NULL'));
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_message = MESSAGE_TEXT;
    INSERT INTO pg_temp.gold_business_workflow_results
    VALUES ('Exact statement payment match reconciles the period',
      false, SQLSTATE || ' ' || v_message);
  END;

  -- Reimporting identical statement data must not duplicate a line.
  BEGIN
    v_import := public.import_reconciliation_statement_lines(
      v_tenant,
      'f17f0001-0000-4000-8000-000000000061',
      jsonb_build_array(jsonb_build_object(
        'transaction_date', to_char(current_date, 'YYYY-MM-DD'),
        'provider_reference', 'STAGE7-RZP-75-REF',
        'amount', 75, 'currency', 'INR', 'description', 'Stage 7 exact match'
      ))
    );
    SELECT count(*) INTO v_count
    FROM public.reconciliation_statement_lines
    WHERE tenant_id = v_tenant
      AND reconciliation_id = 'f17f0001-0000-4000-8000-000000000061';

    INSERT INTO pg_temp.gold_business_workflow_results
    VALUES ('Repeated statement import is idempotent',
      (v_import->>'inserted')::integer = 0
        AND (v_import->>'duplicateLinesSkipped')::integer = 1
        AND v_count = 1,
      'rpc=' || v_import::text || '; stored_lines=' || v_count);
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_message = MESSAGE_TEXT;
    INSERT INTO pg_temp.gold_business_workflow_results
    VALUES ('Repeated statement import is idempotent',
      false, SQLSTATE || ' ' || v_message);
  END;

  -- An exact total with an unmatched line remains under investigation.
  BEGIN
    v_import := public.import_reconciliation_statement_lines(
      v_tenant,
      'f17f0001-0000-4000-8000-000000000062',
      jsonb_build_array(jsonb_build_object(
        'transaction_date', to_char(current_date, 'YYYY-MM-DD'),
        'provider_reference', 'STAGE7-RZP-UNMATCHED-REF',
        'amount', 25, 'currency', 'INR', 'description', 'Stage 7 unresolved line'
      ))
    );
    SELECT status, actual_amount, difference_amount
      INTO v_status, v_actual, v_difference
    FROM public.reconciliation_records
    WHERE tenant_id = v_tenant AND id = 'f17f0001-0000-4000-8000-000000000062';
    SELECT line_status INTO v_line_status
    FROM public.reconciliation_statement_lines
    WHERE tenant_id = v_tenant
      AND reconciliation_id = 'f17f0001-0000-4000-8000-000000000062';

    INSERT INTO pg_temp.gold_business_workflow_results
    VALUES ('Unresolved statement line prevents false reconciliation',
      (v_import->>'inserted')::integer = 1 AND v_line_status = 'unmatched'
        AND v_status = 'investigating' AND v_actual = 25 AND v_difference = 0,
      'rpc=' || v_import::text || '; line_status=' || coalesce(v_line_status, 'NULL')
        || '; reconciliation_status=' || coalesce(v_status, 'NULL')
        || '; actual=' || coalesce(v_actual::text, 'NULL')
        || '; difference=' || coalesce(v_difference::text, 'NULL'));
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_message = MESSAGE_TEXT;
    INSERT INTO pg_temp.gold_business_workflow_results
    VALUES ('Unresolved statement line prevents false reconciliation',
      false, SQLSTATE || ' ' || v_message);
  END;

  -- Invoice -> issued -> credit-note draft.
  BEGIN
    v_invoice := public.create_draft_invoice(
      v_tenant, v_branch, NULL::uuid, 'Stage 7 credit-note test item',
      1, 1, 1000, 0, 0, 0, 0, 0
    );
    PERFORM public.finalize_invoice(v_tenant, v_invoice);
    SELECT id INTO v_invoice_line
    FROM public.invoice_lines
    WHERE tenant_id = v_tenant AND invoice_id = v_invoice
    ORDER BY line_number LIMIT 1;
    SELECT status, total_amount INTO v_status, v_total
    FROM public.invoices WHERE tenant_id = v_tenant AND id = v_invoice;

    INSERT INTO pg_temp.gold_business_workflow_results
    VALUES ('Invoice finalizes before credit-note creation',
      v_invoice IS NOT NULL AND v_invoice_line IS NOT NULL
        AND v_status = 'issued' AND v_total > 0,
      'invoice_id=' || coalesce(v_invoice::text, 'NULL')
        || '; invoice_line_id=' || coalesce(v_invoice_line::text, 'NULL')
        || '; status=' || coalesce(v_status, 'NULL')
        || '; total=' || coalesce(v_total::text, 'NULL'));
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_message = MESSAGE_TEXT;
    INSERT INTO pg_temp.gold_business_workflow_results
    VALUES ('Invoice finalizes before credit-note creation',
      false, SQLSTATE || ' ' || v_message);
  END;

  BEGIN
    v_credit_note := public.create_credit_note_draft(
      v_tenant, v_invoice, 'Stage 7 rollback-only customer return',
      jsonb_build_array(jsonb_build_object(
        'invoice_line_id', v_invoice_line, 'quantity', 1
      ))
    );
    SELECT status, total_amount INTO v_status, v_total
    FROM public.credit_notes
    WHERE tenant_id = v_tenant AND id = v_credit_note;
    SELECT count(*) INTO v_count
    FROM public.credit_note_lines
    WHERE tenant_id = v_tenant AND credit_note_id = v_credit_note;

    INSERT INTO pg_temp.gold_business_workflow_results
    VALUES ('Credit-note draft derives a positive amount from its invoice line',
      v_credit_note IS NOT NULL AND v_status = 'draft'
        AND v_total > 0 AND v_count = 1,
      'credit_note_id=' || coalesce(v_credit_note::text, 'NULL')
        || '; status=' || coalesce(v_status, 'NULL')
        || '; total=' || coalesce(v_total::text, 'NULL')
        || '; lines=' || v_count);
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_message = MESSAGE_TEXT;
    INSERT INTO pg_temp.gold_business_workflow_results
    VALUES ('Credit-note draft derives a positive amount from its invoice line',
      false, SQLSTATE || ' ' || v_message);
  END;

  BEGIN
    PERFORM public.issue_credit_note(v_tenant, v_credit_note);
    SELECT status, total_amount INTO v_status, v_total
    FROM public.credit_notes
    WHERE tenant_id = v_tenant AND id = v_credit_note;

    INSERT INTO pg_temp.gold_business_workflow_results
    VALUES ('Credit-note draft issues and preserves its positive total',
      v_status = 'issued' AND v_total > 0,
      'status=' || coalesce(v_status, 'NULL')
        || '; total=' || coalesce(v_total::text, 'NULL'));
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_message = MESSAGE_TEXT;
    INSERT INTO pg_temp.gold_business_workflow_results
    VALUES ('Credit-note draft issues and preserves its positive total',
      false, SQLSTATE || ' ' || v_message);
  END;
END
$suite$;

RESET ROLE;

SELECT test_name, passed, detail
FROM pg_temp.gold_business_workflow_results
ORDER BY test_name;

ROLLBACK;
