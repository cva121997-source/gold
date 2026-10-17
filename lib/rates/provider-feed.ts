export type ProviderRate = {
  state: string;
  district: string | null;
  city: string | null;
  locality: string | null;
  metal_code: string;
  purity_code: string;
  price_per_gram: number;
  effective_at: string;
  expires_at: string | null;
  source_label: string | null;
};

export type RateLocation = {
  state: string | null;
  district: string | null;
  city: string | null;
  locality: string | null;
};

export function normalizeLocation(value: unknown): string {
  return typeof value === "string"
    ? value.trim().toLocaleLowerCase("en-IN").normalize("NFKC").replace(/\s+/g, " ")
    : "";
}

function parseTimestamp(value: unknown): Date | null {
  if (typeof value !== "string" || !/(Z|[+-]\d{2}:?\d{2})$/i.test(value)) return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
}

export function validateProviderRate(value: unknown): ProviderRate | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const state = typeof row.state === "string" ? row.state.trim() : "";
  const metalCode = typeof row.metal_code === "string" ? row.metal_code.trim() : "";
  const purityCode = typeof row.purity_code === "string" ? row.purity_code.trim() : "";
  const rawPrice = typeof row.price_per_gram === "number" || typeof row.price_per_gram === "string" ? Number(row.price_per_gram) : NaN;
  const effective = parseTimestamp(row.effective_at);
  const expiry = row.expires_at == null || row.expires_at === "" ? null : parseTimestamp(row.expires_at);
  if (!state || !metalCode || !purityCode || !Number.isFinite(rawPrice) || rawPrice <= 0 || rawPrice > 10_000_000 || !effective) return null;
  if (row.expires_at != null && row.expires_at !== "" && !expiry) return null;
  if (expiry && expiry.getTime() <= effective.getTime()) return null;
  return {
    state, district: typeof row.district === "string" && row.district.trim() ? row.district.trim() : null,
    city: typeof row.city === "string" && row.city.trim() ? row.city.trim() : null,
    locality: typeof row.locality === "string" && row.locality.trim() ? row.locality.trim() : null,
    metal_code: metalCode, purity_code: purityCode,
    price_per_gram: Math.round((rawPrice + Number.EPSILON) * 10000) / 10000,
    effective_at: effective.toISOString(), expires_at: expiry?.toISOString() ?? null,
    source_label: typeof row.source_label === "string" ? row.source_label.trim().slice(0, 160) || null : null
  };
}

export function rateMatchesLocation(rate: ProviderRate, target: RateLocation): boolean {
  if (normalizeLocation(rate.state) !== normalizeLocation(target.state)) return false;
  for (const field of ["district", "city", "locality"] as const) {
    const feedValue = normalizeLocation(rate[field]);
    if (feedValue && feedValue !== normalizeLocation(target[field])) return false;
  }
  return true;
}

export function locationSpecificity(rate: ProviderRate): number {
  return Number(Boolean(normalizeLocation(rate.district))) +
    Number(Boolean(normalizeLocation(rate.city))) +
    Number(Boolean(normalizeLocation(rate.locality)));
}

export function chooseLocationRate(rates: ProviderRate[], target: RateLocation): ProviderRate | null {
  const matching = rates.filter((rate) => rateMatchesLocation(rate, target));
  if (!matching.length) return null;
  const max = Math.max(...matching.map(locationSpecificity));
  const mostSpecific = matching.filter((rate) => locationSpecificity(rate) === max);
  const fingerprints = new Set(mostSpecific.map((rate) => [rate.price_per_gram, rate.effective_at, rate.expires_at].join("|")));
  if (fingerprints.size > 1) return null; // Ambiguous source data must fail closed.
  return mostSpecific[0] ?? null;
}
