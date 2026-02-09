import crypto from "node:crypto";
import type { IngramCredential } from "@prisma/client";
import { z } from "zod";
import prisma from "../db.server";
import { createTtlCache } from "../utils/ttl-cache.server";

const OAUTH_URL = "https://api.ingrammicro.com:443/oauth/oauth30/token";
const FREIGHT_URL =
  "https://api.ingrammicro.com:443/resellers/v6/freightestimate";
const SANDBOX_FREIGHT_URL =
  "https://api.ingrammicro.com:443/sandbox/resellers/v6/freightestimate";

const TOKEN_EXPIRY_BUFFER_SECONDS = 60;
const FREIGHT_CACHE_TTL_MS = 2 * 60 * 1000; // 2 minutes
const FREIGHT_CACHE_MAX_ENTRIES = 200;
const freightEstimateCache = createTtlCache<
  string,
  {
    ingramCorrelationId: string;
    response: unknown;
  }
>({
  ttlMs: FREIGHT_CACHE_TTL_MS,
  maxEntries: FREIGHT_CACHE_MAX_ENTRIES,
});
const inflightFreightRequests = new Map<
  string,
  Promise<{
    correlationId: string;
    response: unknown;
    cacheHit: boolean;
  }>
>();

export const credentialSchema = z.object({
  clientId: z.string().min(1),
  clientSecret: z.string().min(1),
  customerNumber: z.string().min(1),
  countryCode: z.string().min(2).max(2).default("US"),
  contactEmail: z.string().email(),
  senderId: z.string().optional(),
  billToAddressId: z.string().optional(),
  shipToAddressId: z.string().optional(),
  sandbox: z.union([z.string(), z.boolean()]).optional(),
});

export type CredentialInput = z.infer<typeof credentialSchema>;

const addressSchema = z.object({
  companyName: z.string().min(1),
  addressLine1: z.string().min(1),
  addressLine2: z.string().optional(),
  city: z.string().min(1),
  state: z.string().min(2),
  postalCode: z.string().min(3),
  countryCode: z.string().min(2).max(2),
});

const rateTestSchema = z.object({
  shipToAddress: addressSchema,
  lines: z.array(z.any()).min(1),
  billToAddressId: z.string().optional(),
  shipToAddressId: z.string().optional(),
});

export type RateTestInput = z.infer<typeof rateTestSchema>;

function normalizeString(value: unknown) {
  if (typeof value === "string") return value.trim();
  if (value === null || value === undefined) return "";
  return String(value).trim();
}

function buildFreightCacheKey(shopDomain: string, payload: RateTestInput) {
  const address = payload.shipToAddress;
  const destinationKey = [
    shopDomain.toLowerCase(),
    normalizeString(address.countryCode).toUpperCase(),
    normalizeString(address.state).toUpperCase(),
    normalizeString(address.postalCode),
    normalizeString(address.city).toLowerCase(),
    normalizeString(address.addressLine1).toLowerCase(),
  ].join("|");

  const lineKey = (payload.lines ?? [])
    .map((line) => {
      const partNumber =
        normalizeString((line as any).ingramPartNumber) ||
        normalizeString((line as any).itemNumber) ||
        normalizeString((line as any).customerLineNumber) ||
        normalizeString((line as any).sku);
      const qtyRaw = Number((line as any).quantity ?? 1);
      const qty = Number.isFinite(qtyRaw) && qtyRaw > 0 ? qtyRaw : 1;

      return partNumber ? `${partNumber}:${qty}` : "";
    })
    .filter(Boolean)
    .sort()
    .join("|");

  return [
    destinationKey,
    normalizeString(payload.billToAddressId),
    normalizeString(payload.shipToAddressId),
    lineKey,
  ].join("|");
}

export class IngramError extends Error {
  public readonly status?: number;
  public readonly details?: unknown;

  constructor(message: string, opts?: { status?: number; details?: unknown }) {
    super(message);
    this.name = "IngramError";
    this.status = opts?.status;
    this.details = opts?.details;
  }
}

export async function getCredentials(shopDomain: string) {
  return prisma.ingramCredential.findUnique({
    where: { shopDomain },
  });
}

export async function saveCredentials(
  shopDomain: string,
  data: CredentialInput,
) {
  const sandboxFlag =
    typeof data.sandbox === "boolean"
      ? data.sandbox
      : data.sandbox
        ? String(data.sandbox).toLowerCase() === "true" ||
          String(data.sandbox).toLowerCase() === "on" ||
          String(data.sandbox) === "1"
        : true;
  const normalizedCountry = data.countryCode.toUpperCase();
  const record = await prisma.ingramCredential.upsert({
    where: { shopDomain },
    create: {
      shopDomain,
      clientId: data.clientId,
      clientSecret: data.clientSecret,
      customerNumber: data.customerNumber,
      countryCode: normalizedCountry,
      contactEmail: data.contactEmail,
      senderId: data.senderId,
      billToAddressId: data.billToAddressId,
      shipToAddressId: data.shipToAddressId,
      sandbox: sandboxFlag,
      lastValidationStatus: "Never run",
    },
    update: {
      clientId: data.clientId,
      clientSecret: data.clientSecret,
      customerNumber: data.customerNumber,
      countryCode: normalizedCountry,
      contactEmail: data.contactEmail,
      senderId: data.senderId,
      billToAddressId: data.billToAddressId,
      shipToAddressId: data.shipToAddressId,
      sandbox: sandboxFlag,
    },
  });

  return record;
}

export async function testCredentials(shopDomain: string) {
  const credentials = await getCredentialsOrThrow(shopDomain);
  const token = await ensureAccessToken(credentials, {
    forceRefresh: true,
  });

  await prisma.ingramCredential.update({
    where: { shopDomain },
    data: {
      lastValidatedAt: new Date(),
      lastValidationStatus: token ? "Success" : "Failure",
    },
  });

  return token;
}

export async function prefetchIngramAuth(shopDomain: string) {
  const credentials = await getCredentialsOrThrow(shopDomain);
  const accessToken = await ensureAccessToken(credentials);
  return { credentials, accessToken };
}

export async function requestFreightEstimate(
  shopDomain: string,
  payload: RateTestInput,
  opts?: {
    credentials?: IngramCredential;
    accessToken?: string;
  },
) {
  const cacheKey = buildFreightCacheKey(shopDomain, payload);
  const cached = freightEstimateCache.get(cacheKey);

  if (cached) {
    return {
      correlationId: cached.ingramCorrelationId,
      response: cached.response,
      cacheHit: true,
    };
  }

  const inflight = inflightFreightRequests.get(cacheKey);
  if (inflight) {
    return inflight;
  }

  const requestPromise = (async () => {
    const credentials =
      opts?.credentials ?? (await getCredentialsOrThrow(shopDomain));
    if (!credentials.contactEmail) {
      throw new IngramError(
        "Missing contact email. Update the credentials form before testing rates.",
      );
    }
    const token = opts?.accessToken ?? (await ensureAccessToken(credentials));
    const correlationId = crypto.randomUUID();

    // Use configured address IDs or defaults that work with Ingram API
    const billToAddressId =
      payload.billToAddressId || credentials.billToAddressId || "000";
    const shipToAddressId =
      payload.shipToAddressId || credentials.shipToAddressId || "200";

    const body: Record<string, unknown> = {
      billToAddressId,
      shipToAddressId,
      shipToAddress: payload.shipToAddress,
      lines: payload.lines,
    };

    const response = await fetch(
      credentials.sandbox ? SANDBOX_FREIGHT_URL : FREIGHT_URL,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          "IM-CustomerNumber": credentials.customerNumber,
          "IM-CountryCode": credentials.countryCode,
          "IM-CorrelationID": correlationId,
          "IM-CustomerContact": credentials.contactEmail,
          ...(credentials.senderId
            ? { "IM-SenderID": credentials.senderId }
            : {}),
        },
        body: JSON.stringify(body),
      },
    );

    const json = await response.json().catch(() => ({}));

    if (!response.ok) {
      console.error(
        `[Ingram] Freight estimate failed: ${response.status} ${
          response.statusText
        }`,
        json,
      );
      throw new IngramError("Failed to fetch freight estimate", {
        status: response.status,
        details: json,
      });
    }

    const result = {
      correlationId,
      response: json,
      cacheHit: false,
    };

    freightEstimateCache.set(cacheKey, {
      ingramCorrelationId: correlationId,
      response: json,
    });

    return result;
  })();

  inflightFreightRequests.set(cacheKey, requestPromise);

  try {
    return await requestPromise;
  } finally {
    inflightFreightRequests.delete(cacheKey);
  }
}

async function ensureAccessToken(
  credentials: IngramCredential,
  { forceRefresh = false }: { forceRefresh?: boolean } = {},
) {
  if (
    !forceRefresh &&
    credentials.accessToken &&
    credentials.accessTokenExpiresAt &&
    credentials.accessTokenExpiresAt.getTime() >
      Date.now() + TOKEN_EXPIRY_BUFFER_SECONDS * 1000
  ) {
    return credentials.accessToken;
  }

  const params = new URLSearchParams();
  params.set("grant_type", "client_credentials");
  params.set("client_id", credentials.clientId);
  params.set("client_secret", credentials.clientSecret);

  const response = await fetch(OAUTH_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: params.toString(),
  });

  const json = await response.json().catch(() => ({}));

  if (!response.ok) {
    await prisma.ingramCredential.update({
      where: { shopDomain: credentials.shopDomain },
      data: {
        lastValidatedAt: new Date(),
        lastValidationStatus: "Failed",
      },
    });

    throw new IngramError("Failed to retrieve access token", {
      status: response.status,
      details: json,
    });
  }

  const expiresIn =
    typeof json.expires_in === "number" ? json.expires_in : 3600;
  const accessToken =
    typeof json.access_token === "string" ? json.access_token : "";

  if (!accessToken) {
    throw new IngramError("Access token missing from OAuth response", {
      details: json,
    });
  }

  const expiresAt = new Date(Date.now() + expiresIn * 1000);

  await prisma.ingramCredential.update({
    where: { shopDomain: credentials.shopDomain },
    data: {
      accessToken,
      accessTokenExpiresAt: expiresAt,
      lastValidatedAt: new Date(),
      lastValidationStatus: "Success",
    },
  });

  return accessToken;
}

async function getCredentialsOrThrow(shopDomain: string) {
  const credentials = await getCredentials(shopDomain);

  if (!credentials) {
    throw new IngramError("No Ingram Micro credentials configured for shop.");
  }

  return credentials;
}

export function parseCredentialFormData(formData: FormData) {
  return credentialSchema.safeParse({
    clientId: formData.get("clientId"),
    clientSecret: formData.get("clientSecret"),
    customerNumber: formData.get("customerNumber"),
    countryCode: formData.get("countryCode") ?? "US",
    contactEmail: formData.get("contactEmail"),
    senderId: formData.get("senderId") || undefined,
    billToAddressId: formData.get("billToAddressId") || undefined,
    shipToAddressId: formData.get("shipToAddressId") || undefined,
    sandbox: formData.get("sandbox") ?? "true",
  });
}

export function parseRateTestFormData(formData: FormData) {
  const linesJson = formData.get("linesJson");
  let lines: unknown;

  if (typeof linesJson !== "string" || !linesJson.trim()) {
    return {
      success: false as const,
      error: "Lines JSON is required",
    };
  }

  try {
    lines = JSON.parse(linesJson);
  } catch (error) {
    return {
      success: false as const,
      error: "Lines JSON is invalid",
    };
  }

  const parsed = rateTestSchema.safeParse({
    shipToAddress: {
      companyName: formData.get("companyName"),
      addressLine1: formData.get("addressLine1"),
      addressLine2: formData.get("addressLine2") || undefined,
      city: formData.get("city"),
      state: formData.get("state"),
      postalCode: formData.get("postalCode"),
      countryCode: String(formData.get("shipCountryCode") || "").toUpperCase(),
    },
    lines,
    billToAddressId: formData.get("testBillToAddressId") || undefined,
    shipToAddressId: formData.get("testShipToAddressId") || undefined,
  });

  if (!parsed.success) {
    return {
      success: false as const,
      error: parsed.error.flatten().formErrors.join(", "),
    };
  }

  return {
    success: true as const,
    data: parsed.data,
  };
}

// ============================================================================
// Carrier Configuration Functions
// ============================================================================

export type CarrierConfig = {
  carrierCode: string;
  carrierName: string;
  carrierMode: string;
  displayName: string | null;
  enabled: boolean;
  sortOrder: number;
};

/**
 * Get all carrier configurations for a shop
 */
export async function getCarrierConfigurations(
  shopDomain: string,
): Promise<CarrierConfig[]> {
  const configs = await prisma.carrierConfiguration.findMany({
    where: { shopDomain },
    orderBy: [{ sortOrder: "asc" }, { carrierName: "asc" }],
  });

  return configs.map((c) => ({
    carrierCode: c.carrierCode,
    carrierName: c.carrierName,
    carrierMode: c.carrierMode,
    displayName: c.displayName,
    enabled: c.enabled,
    sortOrder: c.sortOrder,
  }));
}

/**
 * Get only enabled carrier codes for a shop
 */
export async function getEnabledCarrierCodes(
  shopDomain: string,
): Promise<Set<string>> {
  const configs = await prisma.carrierConfiguration.findMany({
    where: { shopDomain, enabled: true },
    select: { carrierCode: true },
  });

  return new Set(configs.map((c) => c.carrierCode));
}

/**
 * Check if any carrier configurations exist for shop
 */
export async function hasCarrierConfigurations(
  shopDomain: string,
): Promise<boolean> {
  const count = await prisma.carrierConfiguration.count({
    where: { shopDomain },
  });
  return count > 0;
}

/**
 * Upsert a single carrier configuration
 */
export async function upsertCarrierConfiguration(
  shopDomain: string,
  config: {
    carrierCode: string;
    carrierName: string;
    carrierMode: string;
    displayName?: string | null;
    enabled?: boolean;
    sortOrder?: number;
  },
) {
  return prisma.carrierConfiguration.upsert({
    where: {
      shopDomain_carrierCode: {
        shopDomain,
        carrierCode: config.carrierCode,
      },
    },
    create: {
      shopDomain,
      carrierCode: config.carrierCode,
      carrierName: config.carrierName,
      carrierMode: config.carrierMode,
      displayName: config.displayName ?? null,
      enabled: config.enabled ?? true,
      sortOrder: config.sortOrder ?? 0,
    },
    update: {
      carrierName: config.carrierName,
      carrierMode: config.carrierMode,
      displayName: config.displayName ?? null,
      enabled: config.enabled ?? true,
      sortOrder: config.sortOrder ?? 0,
    },
  });
}

/**
 * Sync carriers from Ingram API response to database
 * This populates the carrier configuration table with available options
 */
export async function syncCarriersFromResponse(
  shopDomain: string,
  distributions: Array<{
    carrierList?: Array<{
      carrierCode?: string;
      shipVia?: string;
      carrierMode?: string;
    }>;
  }>,
) {
  const seenCarriers = new Map<
    string,
    { carrierName: string; carrierMode: string }
  >();

  // Collect unique carriers from all distributions
  for (const dist of distributions) {
    const carriers = dist.carrierList ?? [];
    for (const carrier of carriers) {
      const code = carrier.carrierCode?.trim();
      if (!code) continue;

      if (!seenCarriers.has(code)) {
        seenCarriers.set(code, {
          carrierName: carrier.shipVia?.trim() || code,
          carrierMode: carrier.carrierMode?.trim() || "",
        });
      }
    }
  }

  // Upsert each carrier (preserving existing enabled state)
  const existingConfigs = await getCarrierConfigurations(shopDomain);
  const existingMap = new Map(existingConfigs.map((c) => [c.carrierCode, c]));

  let sortOrder = 0;
  for (const [carrierCode, data] of seenCarriers) {
    const existing = existingMap.get(carrierCode);

    await upsertCarrierConfiguration(shopDomain, {
      carrierCode,
      carrierName: data.carrierName,
      carrierMode: data.carrierMode,
      enabled: existing?.enabled ?? true, // Default to enabled for new carriers
      sortOrder: existing?.sortOrder ?? sortOrder++,
    });
  }

  return seenCarriers.size;
}

/**
 * Update enabled status for multiple carriers at once
 */
export async function updateCarrierEnabledStatus(
  shopDomain: string,
  updates: Array<{ carrierCode: string; enabled: boolean }>,
) {
  const results = await Promise.all(
    updates.map(({ carrierCode, enabled }) =>
      prisma.carrierConfiguration.updateMany({
        where: { shopDomain, carrierCode },
        data: { enabled },
      }),
    ),
  );

  return results.reduce((sum, r) => sum + r.count, 0);
}
