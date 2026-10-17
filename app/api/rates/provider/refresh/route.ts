import { timingSafeEqual } from "node:crypto";
import { createClient as createSupabaseClient } from "@supabase/supabase-js";
import { NextRequest, NextResponse } from "next/server";
import { chooseLocationRate, validateProviderRate, type ProviderRate, type RateLocation } from "@/lib/rates/provider-feed";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

type Shop = { id: string; display_name: string; status: string; state: string | null; district: string | null; city: string | null; locality: string | null };
type Branch = { id: string; tenant_id: string; state: string | null; district: string | null; city: string | null; locality: string | null; is_active: boolean };
type Metal = { id: number; code: string };
type Purity = { id: number; metal_id: number; code: string };
type JsonObject = Record<string, unknown>;

function equalSecret(got: string, expected: string) {
  const a = Buffer.from(got);
  const b = Buffer.from(expected);
  return a.length === b.length && a.length > 0 && timingSafeEqual(a, b);
}

function adminClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("SERVER_SUPABASE_NOT_CONFIGURED");
  return createSupabaseClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });
}

async function saveRun(
  admin: ReturnType<typeof adminClient>, tenantId: string, provider: string, startedAt: string,
  status: "succeeded" | "partial" | "failed", imported: number, safeError: string | null, metadata: JsonObject
) {
  const { error } = await admin.from("rate_provider_runs").insert({
    tenant_id: tenantId, provider_name: provider, started_at: startedAt, completed_at: new Date().toISOString(),
    status, rates_imported: imported, safe_error: safeError, metadata
  });
  if (error) console.error("Gold rate run log write failed", { code: error.code });
}

async function refresh(request: NextRequest) {
  const secrets = [process.env.GOLD_RATE_REFRESH_SECRET, process.env.CRON_SECRET]
    .map((value) => value?.trim()).filter((value): value is string => Boolean(value));
  const authorization = request.headers.get("authorization") ?? "";
  const provided = authorization.replace(/^Bearer\s+/i, "").trim();
  const authorised = secrets.some((secret) => {
    const a = Buffer.from(provided); const b = Buffer.from(secret);
    return a.length > 0 && a.length === b.length && timingSafeEqual(a, b);
  });
  if (!authorised) return NextResponse.json({ error: "Unauthorized rate refresh request." }, { status: 401 });

  const providerUrl = process.env.GOLD_RATE_PROVIDER_URL?.trim() ?? "";
  const providerHost = (process.env.GOLD_RATE_PROVIDER_HOST?.trim() ?? "").toLowerCase();
  const providerKey = process.env.GOLD_RATE_PROVIDER_API_KEY?.trim() ?? "";
  const providerName = (process.env.GOLD_RATE_PROVIDER_NAME?.trim() || "Configured rate feed").slice(0, 120);
  if (!providerUrl || !providerHost || !providerKey) {
    return NextResponse.json({ error: "Configure GOLD_RATE_PROVIDER_URL, GOLD_RATE_PROVIDER_HOST, GOLD_RATE_PROVIDER_API_KEY and GOLD_RATE_REFRESH_SECRET on the server." }, { status: 503 });
  }

  let endpoint: URL;
  try {
    endpoint = new URL(providerUrl);
    if (endpoint.protocol !== "https:" || endpoint.username || endpoint.password || endpoint.hostname.toLowerCase() !== providerHost) {
      throw new Error("Rate provider URL must be HTTPS and match the explicitly allowed provider host.");
    }
  } catch {
    return NextResponse.json({ error: "Rate provider URL must be valid HTTPS and match GOLD_RATE_PROVIDER_HOST." }, { status: 503 });
  }

  let admin: ReturnType<typeof adminClient>;
  try { admin = adminClient(); }
  catch { return NextResponse.json({ error: "Gold server database access is not configured." }, { status: 503 }); }

  const startedAt = new Date().toISOString();
  const [shopsResult, branchesResult, metalsResult, puritiesResult] = await Promise.all([
    admin.from("tenants").select("id,display_name,status,state,district,city,locality").in("status", ["active", "trial"]).limit(5000),
    admin.from("branches").select("id,tenant_id,state,district,city,locality,is_active").eq("is_active", true).limit(20000),
    admin.from("metals").select("id,code").eq("is_active", true),
    admin.from("purity_definitions").select("id,metal_id,code").eq("is_active", true)
  ]);
  if (shopsResult.error || branchesResult.error || metalsResult.error || puritiesResult.error) {
    return NextResponse.json({ error: "Could not load shop locations and configured metal/purity definitions." }, { status: 500 });
  }
  const shops = (shopsResult.data ?? []) as Shop[];
  const branches = (branchesResult.data ?? []) as Branch[];
  const metals = (metalsResult.data ?? []) as Metal[];
  const purities = (puritiesResult.data ?? []) as Purity[];
  if (!shops.length) return NextResponse.json({ ok: true, shops: 0, imported: 0, message: "No active or trial shops were found." });

  let feedRows: unknown[];
  let feedFetchedAt: string | null = null;
  try {
    const response = await fetch(endpoint, {
      method: "GET", cache: "no-store", redirect: "error", signal: AbortSignal.timeout(15000),
      headers: { accept: "application/json", authorization: "Bearer " + providerKey }
    });
    if (!response.ok) {
      const safeError = "Provider returned HTTP " + response.status;
      await Promise.all(shops.map((shop) => saveRun(admin, shop.id, providerName, startedAt, "failed", 0, safeError, { http_status: response.status })));
      return NextResponse.json({ error: "Rate provider returned an unsuccessful HTTP status.", shops: shops.length }, { status: 502 });
    }
    const body = await response.text();
    if (body.length > 5_000_000) throw new Error("Provider response exceeded the 5 MB limit.");
    const parsed: unknown = JSON.parse(body);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || !Array.isArray((parsed as JsonObject).rates)) {
      throw new Error("Provider response must be a JSON object with a rates array.");
    }
    const feed = parsed as JsonObject;
    feedRows = feed.rates as unknown[];
    const stamp = typeof feed.fetched_at === "string" ? new Date(feed.fetched_at) : null;
    feedFetchedAt = stamp && Number.isFinite(stamp.getTime()) ? stamp.toISOString() : null;
    if (!feedRows.length || feedRows.length > 25000) throw new Error("Provider rates array must contain between 1 and 25,000 rows.");
  } catch (e) {
    const reason = e instanceof Error ? e.message.slice(0, 180) : "Provider request failed.";
    await Promise.all(shops.map((shop) => saveRun(admin, shop.id, providerName, startedAt, "failed", 0, reason, {})));
    return NextResponse.json({ error: "Could not fetch and validate the rate provider feed.", details: reason }, { status: 502 });
  }

  const validRates = feedRows.map(validateProviderRate).filter((rate): rate is ProviderRate => rate !== null);
  const rejectedRows = feedRows.length - validRates.length;
  if (!validRates.length) {
    await Promise.all(shops.map((shop) => saveRun(admin, shop.id, providerName, startedAt, "failed", 0, "No feed rows passed schema validation.", { rows_received: feedRows.length })));
    return NextResponse.json({ error: "No rate rows passed validation. Each row needs state, metal_code, purity_code, price_per_gram and timezone-aware effective_at." }, { status: 502 });
  }

  const byCode = (rows: { code: string; id: number; metal_id?: number }[], code: string, metalId?: number) =>
    rows.find((row) => row.code.trim().toLowerCase() === code.trim().toLowerCase() && (metalId === undefined || row.metal_id === metalId));
  const branchesByShop = new Map<string, Branch[]>();
  for (const branch of branches) branchesByShop.set(branch.tenant_id, [...(branchesByShop.get(branch.tenant_id) ?? []), branch]);
  let importedTotal = 0;
  let matchedTotal = 0;
  let skippedTotal = rejectedRows;
  const staleThreshold = Date.now() - 36 * 60 * 60 * 1000;

  for (const shop of shops) {
    const sourceLookup = await admin.from("rate_sources").select("id")
      .eq("tenant_id", shop.id).eq("source_type", "provider").eq("provider_name", providerName).limit(1).maybeSingle();
    if (sourceLookup.error) {
      await saveRun(admin, shop.id, providerName, startedAt, "failed", 0, "Could not read configured rate source.", {});
      continue;
    }
    let sourceId = sourceLookup.data?.id as string | undefined;
    if (!sourceId) {
      const createdSource = await admin.from("rate_sources").insert({
        tenant_id: shop.id, name: providerName, source_type: "provider", provider_name: providerName, is_active: true
      }).select("id").single();
      if (createdSource.error || !createdSource.data) {
        await saveRun(admin, shop.id, providerName, startedAt, "failed", 0, "Could not create the rate source record.", {});
        continue;
      }
      sourceId = createdSource.data.id as string;
    }

    const localBranches = branchesByShop.get(shop.id) ?? [];
    const targets: Array<{ branchId: string | null; location: RateLocation }> = localBranches.length
      ? localBranches.map((b) => ({ branchId: b.id, location: {
          state: b.state || shop.state, district: b.district || shop.district, city: b.city || shop.city, locality: b.locality || shop.locality
        }}))
      : [{ branchId: null, location: { state: shop.state, district: shop.district, city: shop.city, locality: shop.locality } }];

    const toInsert: JsonObject[] = [];
    const minimumEffective = Math.min(...validRates.map((r) => Date.parse(r.effective_at)));
    const maximumEffective = Math.max(...validRates.map((r) => Date.parse(r.effective_at)));
    const existingQuery = await admin.from("gold_rates")
      .select("branch_id,metal_id,purity_id,effective_at").eq("tenant_id", shop.id).eq("rate_source_id", sourceId)
      .eq("source_type", "provider").gte("effective_at", new Date(minimumEffective - 1000).toISOString())
      .lte("effective_at", new Date(maximumEffective + 1000).toISOString()).limit(20000);
    if (existingQuery.error) {
      await saveRun(admin, shop.id, providerName, startedAt, "failed", 0, "Could not inspect existing provider rate snapshots.", {});
      continue;
    }
    const existing = new Set((existingQuery.data ?? []).map((row) =>
      [row.branch_id ?? "tenant", row.metal_id, row.purity_id, new Date(row.effective_at).toISOString()].join("|")
    ));
    let matched = 0;
    let skipped = 0;
    let stale = 0;

    for (const target of targets) {
      if (!target.location.state) { skipped++; continue; }
      for (const metal of metals) {
        const metalRows = validRates.filter((r) => r.metal_code.trim().toLowerCase() === metal.code.trim().toLowerCase());
        if (!metalRows.length) continue;
        for (const purity of purities.filter((p) => p.metal_id === metal.id)) {
          const purityRows = metalRows.filter((r) => r.purity_code.trim().toLowerCase() === purity.code.trim().toLowerCase());
          const best = chooseLocationRate(purityRows, target.location);
          if (!best) { continue; }
          matched++;
          const expiry = best.expires_at ?? new Date(Date.parse(best.effective_at) + 24 * 60 * 60 * 1000).toISOString();
          const isStale = Date.parse(best.effective_at) < staleThreshold || Date.parse(expiry) <= Date.now();
          if (isStale) stale++;
          const key = [target.branchId ?? "tenant", metal.id, purity.id, new Date(best.effective_at).toISOString()].join("|");
          if (existing.has(key)) { skipped++; continue; }
          existing.add(key);
          toInsert.push({
            tenant_id: shop.id, branch_id: target.branchId, metal_id: metal.id, purity_id: purity.id,
            state: target.location.state, district: target.location.district, city: target.location.city, locality: target.location.locality,
            price_per_gram: best.price_per_gram, currency: "INR", source_type: "provider", rate_source_id: sourceId,
            source_label: best.source_label || providerName, status: isStale ? "stale" : "indicative",
            effective_at: best.effective_at, expires_at: expiry, updated_by: null, is_public: false
          });
        }
      }
    }
    const insertResult = toInsert.length ? await admin.from("gold_rates").insert(toInsert) : { error: null };
    const insertFailed = Boolean(insertResult.error);
    const imported = insertFailed ? 0 : toInsert.length;
    importedTotal += imported; matchedTotal += matched; skippedTotal += skipped;
    await Promise.all([
      admin.from("gold_rates").update({ status: "stale" }).eq("tenant_id", shop.id)
        .eq("rate_source_id", sourceId).eq("source_type", "provider").eq("status", "indicative")
        .lt("effective_at", new Date(staleThreshold).toISOString()),
      admin.from("gold_rates").update({ status: "stale" }).eq("tenant_id", shop.id)
        .eq("rate_source_id", sourceId).eq("source_type", "provider").eq("status", "indicative")
        .lt("expires_at", new Date().toISOString())
    ]);
    const status = insertFailed ? "failed" : (rejectedRows > 0 || skipped > 0 || stale > 0 || imported < matched ? "partial" : "succeeded");
    await saveRun(admin, shop.id, providerName, startedAt, status, imported,
      insertFailed ? "Provider rows could not be saved." : null,
      { rows_received: feedRows.length, rows_valid: validRates.length, rows_rejected: rejectedRows,
        matched, skipped, stale, feed_fetched_at: feedFetchedAt });
  }

  return NextResponse.json({
    ok: true, provider: providerName, checkedAt: new Date().toISOString(), shops: shops.length,
    acceptedFeedRows: validRates.length, matchedRows: matchedTotal, importedSnapshots: importedTotal,
    skippedRows: skippedTotal, requiresShopVerification: true,
    message: "Imported rate rows remain indicative and private until a shop reviews them. They are not silently treated as verified or published prices."
  });
}

export async function GET(request: NextRequest) {
  return refresh(request);
}

export async function POST(request: NextRequest) {
  return refresh(request);
}
