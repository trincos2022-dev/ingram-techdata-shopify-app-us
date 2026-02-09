import prisma from "../db.server";
import { getSupabaseClient } from "./supabase.server";
import { createTtlCache } from "../utils/ttl-cache.server";

export type IngramSkuMapping = {
  sku: string;
  ingramPartNumber: string;
  cost?: number | null;
  availability?: number | null;
};

const SKU_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes for positive hits
const SKU_CACHE_NEGATIVE_TTL_MS = 60 * 1000; // 1 minute for misses
const skuCache = createTtlCache<string, IngramSkuMapping | null>({
  ttlMs: SKU_CACHE_TTL_MS,
  maxEntries: 10000,
});

export async function getIngramMappingsForSkus(
  shopDomain: string,
  skus: string[],
  opts: { allowSupabaseFallback?: boolean } = {},
) {
  if (skus.length === 0) {
    return [];
  }

  const normalizedSkus = Array.from(
    new Set(
      skus
        .map((sku) => sku?.trim())
        .filter((sku): sku is string => Boolean(sku)),
    ),
  );

  const cachedResults: IngramSkuMapping[] = [];
  const skusToQuery: string[] = [];

  for (const sku of normalizedSkus) {
    const cacheKey = `${shopDomain}::${sku}`;
    const cached = skuCache.get(cacheKey);
    if (cached !== undefined) {
      if (cached) {
        cachedResults.push(cached);
      }
      continue;
    }
    skusToQuery.push(sku);
  }

  if (skusToQuery.length === 0) {
    return cachedResults;
  }

  // First try local Prisma cache (gracefully handle if table doesn't exist)
  let dbMappings: { sku: string; ingramPartNumber: string }[] = [];
  let prismaAvailable = true;
  try {
    dbMappings = await prisma.productMapping.findMany({
      where: {
        shopDomain,
        sku: { in: skusToQuery },
      },
    });
  } catch (err) {
    console.warn("ProductMapping table not available, falling back to Supabase only:", err);
    prismaAvailable = false;
  }

  const dbMap = new Map(dbMappings.map((m) => [m.sku, m]));

  for (const mapping of dbMappings) {
    const cacheKey = `${shopDomain}::${mapping.sku}`;
    const shaped: IngramSkuMapping = {
      sku: mapping.sku,
      ingramPartNumber: mapping.ingramPartNumber,
    };
    skuCache.set(cacheKey, shaped);
    cachedResults.push(shaped);
  }

  const missingSkus = skusToQuery.filter((sku) => !dbMap.has(sku));
  if (missingSkus.length === 0) {
    return cachedResults;
  }

  // Optionally fall back to Supabase for misses, then store locally.
  if (opts.allowSupabaseFallback === false) {
    for (const sku of missingSkus) {
      const cacheKey = `${shopDomain}::${sku}`;
      skuCache.set(cacheKey, null, SKU_CACHE_NEGATIVE_TTL_MS);
    }
    return cachedResults;
  }

  const supabase = getSupabaseClient();
  const { data, error } = await supabase
    .from("final_product_table_us")
    .select("price_vendor_part,price_part_nbr")
    .in("price_vendor_part", missingSkus);

  if (error) {
    console.error("Failed to query Supabase for SKU mappings", error);
    throw new Error("Unable to retrieve SKU mappings from Supabase");
  }

  const fetched = (data ?? []).map((row) => ({
    sku: row.price_vendor_part,
    ingramPartNumber: row.price_part_nbr,
  })) satisfies IngramSkuMapping[];

  const fetchedBySku = new Map(fetched.map((m) => [m.sku, m]));

  // Write-through to local DB (fire-and-forget, don't block checkout)
  if (fetched.length > 0 && prismaAvailable) {
    void prisma.$transaction(
      fetched.map((mapping) =>
        prisma.productMapping.upsert({
          where: {
            shopDomain_sku: {
              shopDomain,
              sku: mapping.sku,
            },
          },
          create: {
            shopDomain,
            sku: mapping.sku,
            ingramPartNumber: mapping.ingramPartNumber,
          },
          update: {
            ingramPartNumber: mapping.ingramPartNumber,
          },
        }),
      ),
    ).catch((err) => {
      console.error("Failed to cache mappings to local DB:", err);
    });
  }

  for (const sku of missingSkus) {
    const mapping = fetchedBySku.get(sku) ?? null;
    const cacheKey = `${shopDomain}::${sku}`;
    // Cache both hits and misses to avoid hammering Supabase on rapid requests.
    skuCache.set(cacheKey, mapping, mapping ? SKU_CACHE_TTL_MS : SKU_CACHE_NEGATIVE_TTL_MS);
    if (mapping) {
      cachedResults.push(mapping);
    }
  }

  return cachedResults;
}

export function mappingArrayToRecord(mappings: IngramSkuMapping[]) {
  return mappings.reduce<Record<string, IngramSkuMapping>>((acc, mapping) => {
    acc[mapping.sku] = mapping;
    return acc;
  }, {});
}
