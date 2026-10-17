import { randomUUID } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { createClient as createSupabaseClient } from "@supabase/supabase-js";
import { createClient as createSessionClient } from "@/lib/supabase/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Purpose = "scheme_contribution" | "invoice" | "order_advance" | "other";
type JsonObject = Record<string, unknown>;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const allowedStaffRoles = new Set(["owner", "manager", "accountant", "cashier"]);
const money = (value: number) => Math.round((value + Number.EPSILON) * 100) / 100;
const isObject = (value: unknown): value is JsonObject => !!value && typeof value === "object" && !Array.isArray(value);
const num = (value: unknown) => {
  const n = typeof value === "number" || typeof value === "string" ? Number(value) : NaN;
  return Number.isFinite(n) ? n : null;
};

function adminClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceKey) throw new Error("SUPABASE_SERVER_NOT_CONFIGURED");
  return createSupabaseClient(url, serviceKey, { auth: { autoRefreshToken: false, persistSession: false } });
}

function errorResponse(message: string, status: number) {
  return NextResponse.json({ error: message }, { status });
}

export async function POST(request: NextRequest) {
  let session;
  try {
    session = await createSessionClient();
  } catch {
    return errorResponse("Supabase authentication is not configured on this server.", 503);
  }
  const { data: { user }, error: authError } = await session.auth.getUser();
  if (authError || !user) return errorResponse("Sign in before creating a payment.", 401);

  let body: JsonObject;
  try {
    const parsed: unknown = await request.json();
    if (!isObject(parsed)) return errorResponse("Request body must be a JSON object.", 400);
    body = parsed;
  } catch {
    return errorResponse("Request body must be valid JSON.", 400);
  }

  const tenantId = typeof body.tenantId === "string" ? body.tenantId : "";
  const purpose = body.purpose as Purpose;
  const requestedAmount = num(body.amount);
  const requestedBranchId = typeof body.branchId === "string" && body.branchId ? body.branchId : null;
  const enrolmentId = typeof body.enrolmentId === "string" && body.enrolmentId ? body.enrolmentId : null;
  const invoiceId = typeof body.invoiceId === "string" && body.invoiceId ? body.invoiceId : null;
  const requestedCustomerId = typeof body.customerId === "string" && body.customerId ? body.customerId : null;
  const requestedKey = typeof body.idempotencyKey === "string" ? body.idempotencyKey.trim() : "";
  const idempotencyKey = requestedKey || randomUUID();

  if (!UUID.test(tenantId)) return errorResponse("A valid shop identifier is required.", 400);
  if (!["scheme_contribution", "invoice", "order_advance", "other"].includes(purpose)) return errorResponse("Unsupported payment purpose.", 400);
  if (requestedAmount === null || requestedAmount <= 0 || requestedAmount > 100000000) return errorResponse("Enter a valid payment amount greater than ₹0 and no more than ₹10 crore.", 400);
  const amount = money(requestedAmount);
  if (amount <= 0) return errorResponse("Payment amount must be at least ₹0.01.", 400);
  if (!/^[A-Za-z0-9:_-]{8,128}$/.test(idempotencyKey)) return errorResponse("The payment retry key is invalid.", 400);
  if (requestedBranchId && !UUID.test(requestedBranchId)) return errorResponse("Branch identifier is invalid.", 400);
  if (enrolmentId && !UUID.test(enrolmentId)) return errorResponse("Scheme enrolment identifier is invalid.", 400);
  if (invoiceId && !UUID.test(invoiceId)) return errorResponse("Invoice identifier is invalid.", 400);
  if (requestedCustomerId && !UUID.test(requestedCustomerId)) return errorResponse("Customer identifier is invalid.", 400);
  if (purpose === "scheme_contribution" && !enrolmentId) return errorResponse("Choose a scheme enrolment.", 400);
  if (purpose === "invoice" && !invoiceId) return errorResponse("Choose an invoice.", 400);
  if (purpose !== "scheme_contribution" && enrolmentId) return errorResponse("Scheme enrolment does not match the selected payment purpose.", 400);
  if (purpose !== "invoice" && invoiceId) return errorResponse("Invoice does not match the selected payment purpose.", 400);

  const keyId = process.env.RAZORPAY_KEY_ID;
  const keySecret = process.env.RAZORPAY_KEY_SECRET;
  if (!keyId || !keySecret) return errorResponse("Online payments are not configured. Set RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET on the server.", 503);

  let admin;
  try {
    admin = adminClient();
  } catch {
    return errorResponse("Gold server database access is not configured.", 503);
  }

  const { data: tenant, error: tenantError } = await admin.from("tenants")
    .select("id,status,display_name").eq("id", tenantId).maybeSingle();
  if (tenantError) return errorResponse("Could not verify the shop status.", 500);
  if (!tenant || !["active", "trial"].includes(tenant.status)) return errorResponse("This shop is not accepting payments.", 403);

  const [{ data: membership }, { data: customerLink }] = await Promise.all([
    admin.from("tenant_memberships").select("tenant_id,branch_id,role,is_active")
      .eq("tenant_id", tenantId).eq("user_id", user.id).eq("is_active", true).maybeSingle(),
    admin.from("customer_auth_links").select("tenant_id,customer_id,verified_at")
      .eq("tenant_id", tenantId).eq("auth_user_id", user.id).not("verified_at", "is", null).maybeSingle()
  ]);
  const staff = !!membership && membership.is_active === true && allowedStaffRoles.has(membership.role);
  const linkedCustomer = !!customerLink?.customer_id && !!customerLink.verified_at;
  if (!staff && !linkedCustomer) return errorResponse("You do not have an active staff membership or a verified customer profile for this shop.", 403);
  if (!staff && !["scheme_contribution", "invoice"].includes(purpose)) return errorResponse("Customer accounts can only pay their own scheme contributions or invoices.", 403);

  const elevatedBranchRoles = staff && ["owner", "manager"].includes(membership.role);
  let branchId = staff ? (requestedBranchId ?? membership.branch_id ?? null) : null;
  if (staff && !elevatedBranchRoles && branchId !== (membership.branch_id ?? null)) {
    return errorResponse("Your staff account cannot create payments for this branch.", 403);
  }

  let customerId = staff ? requestedCustomerId : (customerLink?.customer_id ?? null);
  let schemeRateSnapshot: { rate: number; rateId: string; purityCode: string; effectiveAt: string; sourceLabel: string | null } | null = null;
  let orderMetadata: JsonObject = { purpose, created_by: user.id };

  if (purpose === "scheme_contribution") {
    const { data: enrolment, error: enrolmentError } = await admin.from("scheme_enrolments")
      .select("id,tenant_id,branch_id,customer_id,status,scheme_version_id,agreed_terms")
      .eq("tenant_id", tenantId).eq("id", enrolmentId).maybeSingle();
    if (enrolmentError) return errorResponse("Could not verify the scheme enrolment.", 500);
    if (!enrolment || !["active", "pending"].includes(enrolment.status)) return errorResponse("This scheme enrolment is not accepting contributions.", 409);
    if (!staff && enrolment.customer_id !== customerId) return errorResponse("You can only pay your own verified scheme enrolment.", 403);
    if (requestedCustomerId && requestedCustomerId !== enrolment.customer_id) return errorResponse("Customer does not match the scheme enrolment.", 400);
    if (staff && !elevatedBranchRoles && enrolment.branch_id !== branchId) return errorResponse("Your staff account cannot collect for this enrolment branch.", 403);
    if (requestedBranchId && enrolment.branch_id && requestedBranchId !== enrolment.branch_id && !elevatedBranchRoles) return errorResponse("Branch does not match the scheme enrolment.", 403);

    customerId = enrolment.customer_id;
    branchId = enrolment.branch_id ?? branchId;
    const agreedTerms = isObject(enrolment.agreed_terms) ? enrolment.agreed_terms : {};
    const { data: version, error: versionError } = await admin.from("scheme_versions")
      .select("scheme_id,terms").eq("tenant_id", tenantId).eq("id", enrolment.scheme_version_id).maybeSingle();
    if (versionError || !version) return errorResponse("The enrolment's accepted scheme version could not be verified.", 500);
    const { data: scheme, error: schemeError } = await admin.from("scheme_templates")
      .select("scheme_type").eq("tenant_id", tenantId).eq("id", version.scheme_id).maybeSingle();
    if (schemeError || !scheme) return errorResponse("The scheme configuration could not be verified.", 500);
    const versionTerms = isObject(version.terms) ? version.terms : {};
    const terms = { ...versionTerms, ...agreedTerms };
    const minContribution = num(terms.minimum_contribution_inr ?? terms.min_contribution_inr);
    const maxContribution = num(terms.maximum_contribution_inr ?? terms.max_contribution_inr);
    if (minContribution !== null && amount < minContribution) return errorResponse("The amount is below the minimum contribution permitted by this scheme.", 400);
    if (maxContribution !== null && amount > maxContribution) return errorResponse("The amount is above the maximum contribution permitted by this scheme.", 400);
    if (scheme.scheme_type === "fixed_monthly") {
      const monthlyAmount = num(terms.monthly_instalment_inr);
      const allowPartial = terms.allow_partial_payments === true;
      if (monthlyAmount !== null && monthlyAmount > 0 && !allowPartial && amount !== money(monthlyAmount)) {
        return errorResponse("This scheme requires the configured monthly instalment amount.", 400);
      }
    }

    orderMetadata = {
      ...orderMetadata,
      scheme_type: scheme.scheme_type,
      scheme_version_id: enrolment.scheme_version_id,
      purity_code: String(terms.purity_code ?? "22K"),
    };

    if (scheme.scheme_type === "flexible_gold_weight") {
      const purityCode = String(terms.purity_code ?? "22K");
      const [{ data: metal, error: metalError }, { data: purity, error: purityError }] = await Promise.all([
        admin.from("metals").select("id").eq("code", "gold").eq("is_active", true).maybeSingle(),
        admin.from("purity_definitions").select("id").eq("code", purityCode).eq("is_active", true).maybeSingle()
      ]);
      if (metalError || purityError || !metal || !purity) return errorResponse("The scheme's gold purity is not configured.", 409);
      const { data: candidates, error: rateError } = await admin.from("gold_rates")
        .select("id,branch_id,price_per_gram,effective_at,expires_at,status,source_label")
        .eq("tenant_id", tenantId).eq("metal_id", metal.id).eq("purity_id", purity.id).eq("status", "verified")
        .lte("effective_at", new Date().toISOString()).order("effective_at", { ascending: false }).limit(100);
      if (rateError) return errorResponse("Could not load a verified rate for this contribution.", 500);
      const now = Date.now();
      const validRates = (candidates ?? []).filter((rate) => !rate.expires_at || new Date(rate.expires_at).getTime() >= now);
      const selectedRate = validRates.find((rate) => rate.branch_id === branchId) ?? validRates.find((rate) => rate.branch_id === null);
      if (!selectedRate || now - new Date(selectedRate.effective_at).getTime() > 36 * 60 * 60 * 1000) {
        return errorResponse("No fresh, verified shop rate is available for this scheme purity. Ask the shop to publish a current rate before accepting the payment.", 409);
      }
      const rateValue = num(selectedRate.price_per_gram);
      if (rateValue === null || rateValue <= 0) return errorResponse("The selected gold rate is invalid.", 409);
      schemeRateSnapshot = { rate: rateValue, rateId: selectedRate.id, purityCode, effectiveAt: selectedRate.effective_at, sourceLabel: selectedRate.source_label };
      orderMetadata = {
        ...orderMetadata,
        gold_rate_snapshot: rateValue,
        gold_rate_id: selectedRate.id,
        gold_rate_effective_at: selectedRate.effective_at,
        gold_rate_source: selectedRate.source_label ?? "Authorised shop rate",
      };
    }
  } else if (purpose === "invoice") {
    const { data: invoice, error: invoiceError } = await admin.from("invoices")
      .select("id,tenant_id,branch_id,customer_id,status,total_amount,amount_paid,invoice_number")
      .eq("tenant_id", tenantId).eq("id", invoiceId).maybeSingle();
    if (invoiceError) return errorResponse("Could not verify the invoice.", 500);
    if (!invoice || !["issued", "partially_paid"].includes(invoice.status)) return errorResponse("Only issued invoices with an outstanding balance can be paid online.", 409);
    const outstanding = money(Number(invoice.total_amount) - Number(invoice.amount_paid));
    if (amount > outstanding) return errorResponse("Payment amount exceeds this invoice's outstanding balance.", 400);
    if (!staff && invoice.customer_id !== customerId) return errorResponse("You can only pay an invoice belonging to your verified customer profile.", 403);
    if (requestedCustomerId && requestedCustomerId !== invoice.customer_id) return errorResponse("Customer does not match the invoice.", 400);
    if (staff && !elevatedBranchRoles && invoice.branch_id !== branchId) return errorResponse("Your staff account cannot collect for this invoice branch.", 403);
    if (requestedBranchId && invoice.branch_id && requestedBranchId !== invoice.branch_id && !elevatedBranchRoles) return errorResponse("Branch does not match the invoice.", 403);
    customerId = invoice.customer_id;
    branchId = invoice.branch_id ?? branchId;
    orderMetadata = { ...orderMetadata, invoice_number: invoice.invoice_number, invoice_id: invoice.id };
  } else if (purpose === "order_advance" && !staff) {
    return errorResponse("Only authorised shop staff can initiate an order advance.", 403);
  } else if (customerId) {
    const { data: customer, error: customerError } = await admin.from("tenant_customers")
      .select("id,tenant_id").eq("tenant_id", tenantId).eq("id", customerId).maybeSingle();
    if (customerError) return errorResponse("Could not verify the customer profile.", 500);
    if (!customer) return errorResponse("Customer does not belong to this shop.", 400);
  }

  if (branchId) {
    const { data: branch, error: branchError } = await admin.from("branches")
      .select("id,tenant_id,is_active").eq("tenant_id", tenantId).eq("id", branchId).maybeSingle();
    if (branchError) return errorResponse("Could not verify the selected branch.", 500);
    if (!branch || branch.is_active !== true) return errorResponse("The selected branch is not active for this shop.", 400);
  }

  const { data: existing, error: existingError } = await admin.from("payment_orders")
    .select("id,tenant_id,branch_id,customer_id,enrolment_id,invoice_id,order_code,provider_order_ref,amount,currency,purpose,status,metadata")
    .eq("tenant_id", tenantId).eq("idempotency_key", idempotencyKey).maybeSingle();
  if (existingError) return errorResponse("Could not check payment retry state.", 500);
  if (existing) {
    if (money(Number(existing.amount)) !== amount || existing.purpose !== purpose ||
        (existing.enrolment_id ?? null) !== enrolmentId || (existing.invoice_id ?? null) !== invoiceId) {
      return errorResponse("This retry key was already used for a different payment. Start a new checkout.", 409);
    }
    if (!staff && existing.customer_id !== customerLink?.customer_id) return errorResponse("This payment order is not linked to your customer profile.", 403);
    if (!existing.provider_order_ref || !["created", "pending"].includes(existing.status)) return errorResponse("This payment retry key has already been consumed. Refresh the page to check the latest payment status.", 409);
    return NextResponse.json({
      orderId: existing.id, orderCode: existing.order_code, providerOrderRef: existing.provider_order_ref,
      keyId, amount: Number(existing.amount), amountPaise: Math.round(Number(existing.amount) * 100),
      currency: existing.currency, purpose: existing.purpose, shopName: tenant.display_name,
      goldRateSnapshot: schemeRateSnapshot?.rate ?? null,
      idempotent: true
    });
  }

  const orderCode = "PAY-" + new Date().toISOString().slice(0, 10).replaceAll("-", "") + "-" + randomUUID().replaceAll("-", "").slice(0, 8).toUpperCase();
  const { data: inserted, error: insertError } = await admin.from("payment_orders").insert({
    tenant_id: tenantId, branch_id: branchId, customer_id: customerId, enrolment_id: enrolmentId,
    invoice_id: invoiceId, order_code: orderCode, provider: "razorpay", amount, currency: "INR",
    purpose, status: "created", idempotency_key: idempotencyKey,
    metadata: { ...orderMetadata, created_by: user.id, gold_rate_snapshot: schemeRateSnapshot?.rate ?? orderMetadata.gold_rate_snapshot ?? null }
  }).select("id,order_code,amount,currency,purpose,status").single();

  if (insertError || !inserted) {
    const { data: concurrent } = await admin.from("payment_orders")
      .select("id,order_code,provider_order_ref,amount,currency,purpose,status")
      .eq("tenant_id", tenantId).eq("idempotency_key", idempotencyKey).maybeSingle();
    if (concurrent?.provider_order_ref && concurrent.status === "pending" && money(Number(concurrent.amount)) === amount && concurrent.purpose === purpose) {
      return NextResponse.json({ orderId: concurrent.id, orderCode: concurrent.order_code, providerOrderRef: concurrent.provider_order_ref,
        keyId, amount, amountPaise: Math.round(amount * 100), currency: concurrent.currency, purpose, shopName: tenant.display_name, idempotent: true });
    }
    return errorResponse("The payment order could not be stored. No checkout was started.", 500);
  }

  let providerResponse: Response;
  let providerBody: JsonObject;
  try {
    providerResponse = await fetch("https://api.razorpay.com/v1/orders", {
      method: "POST",
      headers: {
        Authorization: "Basic " + Buffer.from(keyId + ":" + keySecret).toString("base64"),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        amount: Math.round(amount * 100), currency: "INR", receipt: orderCode,
        notes: { gold_payment_order_id: inserted.id, gold_tenant_id: tenantId, purpose }
      }),
      cache: "no-store",
    });
    const parsed: unknown = await providerResponse.json();
    providerBody = isObject(parsed) ? parsed : {};
  } catch {
    await admin.from("payment_orders").update({ status: "failed", updated_at: new Date().toISOString() }).eq("id", inserted.id);
    return errorResponse("Razorpay could not be reached. Retry with a new checkout key after checking provider status.", 502);
  }

  const providerOrderRef = typeof providerBody.id === "string" ? providerBody.id : "";
  if (!providerResponse.ok || !providerOrderRef || providerBody.currency !== "INR" || Number(providerBody.amount) !== Math.round(amount * 100)) {
    await admin.from("payment_orders").update({
      status: "failed", metadata: { ...orderMetadata, provider_error_status: providerResponse.status, provider_error: String(providerBody.error && isObject(providerBody.error) ? providerBody.error.description ?? "Order creation rejected" : "Order creation rejected").slice(0, 240) },
      updated_at: new Date().toISOString()
    }).eq("id", inserted.id);
    return errorResponse("Razorpay did not confirm a matching payment order. No checkout was opened.", 502);
  }

  const { error: saveProviderRefError } = await admin.from("payment_orders")
    .update({ provider_order_ref: providerOrderRef, status: "pending", updated_at: new Date().toISOString() })
    .eq("tenant_id", tenantId).eq("id", inserted.id);
  if (saveProviderRefError) {
    return errorResponse("Razorpay created an order, but Gold could not store its reference. Do not collect payment until the order is reconciled.", 503);
  }

  return NextResponse.json({
    orderId: inserted.id, orderCode: inserted.order_code, providerOrderRef, keyId,
    amount: Number(inserted.amount), amountPaise: Math.round(Number(inserted.amount) * 100),
    currency: inserted.currency, purpose: inserted.purpose, shopName: tenant.display_name,
    goldRateSnapshot: schemeRateSnapshot?.rate ?? null, idempotent: false
  });
}
