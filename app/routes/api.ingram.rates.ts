import crypto from "node:crypto";
import type { ActionFunctionArgs } from "react-router";

import prisma from "../db.server";
import {
  requestFreightEstimate,
  prefetchIngramAuth,
  syncCarriersFromResponse,
  getCarrierConfigurations,
  IngramError,
  type RateTestInput,
} from "../services/ingram.server";
import {
  getIngramMappingsForSkus,
  mappingArrayToRecord,
} from "../services/product-mapping.server";
import {
  getFallbackRateSettings,
  formatFallbackRateForShopify,
} from "../services/fallback-rate.server";
import {
  combineRates,
  formatRateForShopify,
  type IngramDistribution,
} from "../services/rate-combiner.server";

// Helper to get fallback rate response for carrier service
async function getFallbackRateResponse(
  shopDomain: string,
  currency: string = "USD"
): Promise<{ rates: Array<ReturnType<typeof formatFallbackRateForShopify>> }> {
  const settings = await getFallbackRateSettings(shopDomain);

  if (!settings.enabled) {
    return { rates: [] };
  }

  const fallbackRate = formatFallbackRateForShopify(settings, currency);
  return { rates: [fallbackRate] };
}

type RateRequestLine = {
  sku: string;
  quantity: number;
  unitOfMeasure?: string;
  title?: string;
  weight?: number;
  weightUnit?: "g" | "kg" | "lb";
  metadata?: Record<string, unknown>;
};

type RateRequestBody = {
  shopDomain: string;
  shipToAddress: {
    companyName?: string | null;
    firstName?: string | null;
    lastName?: string | null;
    addressLine1: string;
    addressLine2?: string | null;
    city: string;
    state: string;
    postalCode: string;
    countryCode: string;
  };
  lines: RateRequestLine[];
};

const WEIGHT_CONVERSIONS: Record<string, number> = {
  g: 0.00220462,
  kg: 2.20462,
  lb: 1,
};

function convertWeightToPounds(weight: number | undefined, unit?: string) {
  if (!weight || Number.isNaN(weight)) return 1;
  if (!unit) {
    return weight;
  }

  const normalizedUnit = unit.toLowerCase();
  const multiplier = WEIGHT_CONVERSIONS[normalizedUnit];

  if (!multiplier) {
    return weight;
  }

  return weight * multiplier;
}

function normalizeShipToAddress(body: RateRequestBody): RateTestInput["shipToAddress"] {
  const { shipToAddress } = body;
  const company =
    shipToAddress.companyName ||
    `${shipToAddress.firstName ?? ""} ${shipToAddress.lastName ?? ""}`.trim() ||
    "Shopify Customer";

  return {
    companyName: company,
    addressLine1: shipToAddress.addressLine1,
    addressLine2: shipToAddress.addressLine2 ?? undefined,
    city: shipToAddress.city,
    state: shipToAddress.state,
    postalCode: shipToAddress.postalCode,
    countryCode: shipToAddress.countryCode,
  };
}

function isCarrierServiceRequest(headers: Headers) {
  return headers.get("X-Shopify-Shop-Domain");
}

function verifyCarrierRequest(headers: Headers, rawBody: string) {
  const secret = process.env.SHOPIFY_API_SECRET;
  if (!secret) {
    throw new Error("SHOPIFY_API_SECRET missing for HMAC validation");
  }

  const hmac = headers.get("X-Shopify-Hmac-Sha256");
  if (!hmac) {
    throw new Error("Missing Shopify HMAC header");
  }

  const digest = crypto
    .createHmac("sha256", secret)
    .update(rawBody, "utf8")
    .digest("base64");

  if (!crypto.timingSafeEqual(Buffer.from(digest), Buffer.from(hmac))) {
    throw new Error("Invalid Shopify HMAC");
  }
}

function carrierRequestToInternalPayload(
  shopDomain: string,
  body: any,
): RateRequestBody {
  const destination = body?.rate?.destination || {};
  const items = Array.isArray(body?.rate?.items) ? body.rate.items : [];

  const lines: RateRequestLine[] = items.map((item: any) => ({
    sku: item.sku || item.product_id || item.title || item.name,
    quantity: item.quantity ?? 1,
    title: item.name,
    weight: item.grams,
    weightUnit: "g",
  }));

  return {
    shopDomain,
    shipToAddress: {
      companyName: destination.company,
      firstName: destination.name,
      lastName: destination.last_name,
      addressLine1: destination.address1,
      addressLine2: destination.address2,
      city: destination.city,
      state: destination.province || destination.province_code || "",
      postalCode: destination.postal_code || "",
      countryCode: destination.country_code || destination.country || "",
    },
    lines,
  };
}

function isValidInternalPayload(payload: RateRequestBody) {
  return (
    payload.shopDomain &&
    payload.shipToAddress?.addressLine1 &&
    payload.shipToAddress?.city &&
    payload.shipToAddress?.state &&
    payload.shipToAddress?.postalCode &&
    payload.shipToAddress?.countryCode &&
    payload.lines?.length > 0
  );
}

// Truncate string to max length for database storage
function truncateJson(obj: unknown, maxLength: number = 10000): string {
  const json = JSON.stringify(obj);
  if (json.length <= maxLength) return json;
  return json.slice(0, maxLength) + "...[truncated]";
}

// Save rate request log to database (fire-and-forget, don't block response)
function saveRateLog(data: {
  shopDomain: string;
  correlationId: string;
  requestType: "carrier_service" | "cart_estimate";
  cartItemCount: number;
  cartSkus: string[];
  ingramPartNums?: string[];
  shipToCity?: string;
  shipToState?: string;
  shipToZip?: string;
  shipToCountry?: string;
  status: "success" | "error" | "no_rates" | "no_mapping" | "api_error";
  distributionCount?: number;
  ratesReturned?: number;
  ratesData?: unknown;
  errorMessage?: string;
  errorDetails?: unknown;
  ingramRawResponse?: unknown;
  durationMs?: number;
}) {
  // Fire-and-forget: don't await, don't block the response
  prisma.rateRequestLog.create({
    data: {
      shopDomain: data.shopDomain,
      correlationId: data.correlationId,
      requestType: data.requestType,
      cartItemCount: data.cartItemCount,
      cartSkus: JSON.stringify(data.cartSkus),
      ingramPartNums: data.ingramPartNums ? JSON.stringify(data.ingramPartNums) : null,
      shipToCity: data.shipToCity,
      shipToState: data.shipToState,
      shipToZip: data.shipToZip,
      shipToCountry: data.shipToCountry,
      status: data.status,
      distributionCount: data.distributionCount,
      ratesReturned: data.ratesReturned,
      ratesData: data.ratesData ? truncateJson(data.ratesData, 5000) : null,
      errorMessage: data.errorMessage,
      errorDetails: data.errorDetails ? truncateJson(data.errorDetails, 2000) : null,
      ingramRawResponse: data.ingramRawResponse ? truncateJson(data.ingramRawResponse, 8000) : null,
      durationMs: data.durationMs,
    },
  }).catch(err => {
    console.error("Failed to save rate request log:", err);
  });
}

export const action = async ({ request }: ActionFunctionArgs) => {
  const startTime = Date.now();
  const correlationId = crypto.randomUUID();
  const rawBody = await request.text();

  const carrierShop = isCarrierServiceRequest(request.headers);
  let payload: RateRequestBody | null = null;
  let carrierCurrency = "USD";
  const expectedToken = process.env.APP_BACKEND_TOKEN;

  console.log(`[${correlationId}] Rate request received from: ${carrierShop || "direct"}`);

  // Log raw request for debugging (truncated to avoid huge logs)
  if (carrierShop) {
    try {
      const parsedRaw = JSON.parse(rawBody);
      const itemCount = parsedRaw?.rate?.items?.length ?? 0;
      const itemSkus = (parsedRaw?.rate?.items ?? []).map((i: any) => i.sku || i.name || "no-sku").join(", ");
      console.log(`[${correlationId}] Raw Shopify request: ${itemCount} items, SKUs: [${itemSkus}]`);
    } catch {
      console.log(`[${correlationId}] Raw body (first 500 chars): ${rawBody.slice(0, 500)}`);
    }
  }

  if (carrierShop) {
    try {
      verifyCarrierRequest(request.headers, rawBody);
    } catch (error) {
      console.error(`[${correlationId}] Carrier request validation failed`, error);
      return new Response("Unauthorized", { status: 401 });
    }

    try {
      const parsed = JSON.parse(rawBody);
      carrierCurrency = parsed?.rate?.currency ?? "USD";
      payload = carrierRequestToInternalPayload(carrierShop, parsed);
      console.log(`[${correlationId}] Parsed ${payload.lines.length} cart items`);
    } catch (error) {
      console.error(`[${correlationId}] Invalid carrier request payload`, error);
      return Response.json(
        { error: "Invalid carrier payload" },
        { status: 400 },
      );
    }
  } else {
    if (expectedToken) {
      const provided = request.headers.get("X-App-Token");
      if (provided !== expectedToken) {
        return new Response("Unauthorized", { status: 401 });
      }
    }

    try {
      payload = JSON.parse(rawBody) as RateRequestBody;
    } catch (error) {
      console.error(`[${correlationId}] Invalid JSON payload for rate route`, error);
      return Response.json(
        { error: "Invalid JSON payload" },
        { status: 400 },
      );
    }
  }

  if (!payload || !isValidInternalPayload(payload)) {
    console.error(`[${correlationId}] Missing or invalid payload data`);
    return Response.json(
      { error: "Missing or invalid payload data" },
      { status: 400 },
    );
  }

  const uniqueSkus = Array.from(
    new Set(
      payload.lines
        .map((line) => line.sku?.trim())
        .filter((sku): sku is string => Boolean(sku)),
    ),
  );

  console.log(`[${correlationId}] Cart SKUs: ${uniqueSkus.join(", ")}`);
  console.log(`[${correlationId}] Ship to: ${payload.shipToAddress.city}, ${payload.shipToAddress.state} ${payload.shipToAddress.postalCode}`);

  if (uniqueSkus.length === 0) {
    return Response.json({ error: "Lines missing SKU data" }, { status: 400 });
  }

  try {
    // Kick off token fetch + mapping in parallel
    const mappingStart = Date.now();
    const [mappings, auth] = await Promise.all([
      // Map all SKUs to Ingram part numbers
      getIngramMappingsForSkus(payload.shopDomain, uniqueSkus, {
        allowSupabaseFallback: false,
      }),
      prefetchIngramAuth(payload.shopDomain),
    ]);
    const mappingRecord = mappingArrayToRecord(mappings);
    console.log(`[${correlationId}] SKU mapping lookup took ${Date.now() - mappingStart}ms`);

    console.log(`[${correlationId}] SKU mapping results: ${mappings.length}/${uniqueSkus.length} mapped`);
    if (mappings.length > 0) {
      console.log(`[${correlationId}] Mapped: ${mappings.map(m => `${m.sku}->${m.ingramPartNumber}`).join(", ")}`);
    }

    const missingSkus = uniqueSkus.filter((sku) => !mappingRecord[sku]);
    if (missingSkus.length > 0) {
      console.warn(`[${correlationId}] Missing Ingram mappings for SKUs:`, missingSkus);

      // Log this as no_mapping
      saveRateLog({
        shopDomain: payload.shopDomain,
        correlationId,
        requestType: carrierShop ? "carrier_service" : "cart_estimate",
        cartItemCount: payload.lines.length,
        cartSkus: uniqueSkus,
        shipToCity: payload.shipToAddress.city,
        shipToState: payload.shipToAddress.state,
        shipToZip: payload.shipToAddress.postalCode,
        shipToCountry: payload.shipToAddress.countryCode,
        status: "no_mapping",
        errorMessage: `Missing Ingram mappings for: ${missingSkus.join(", ")}`,
        durationMs: Date.now() - startTime,
      });

      // For carrier service, return fallback rate if configured
      if (carrierShop) {
        const fallbackResponse = await getFallbackRateResponse(payload.shopDomain, carrierCurrency);
        return Response.json(fallbackResponse, { status: 200 });
      }
      return Response.json(
        {
          error: "Missing Ingram mapping for the provided SKUs",
          missingSkus,
        },
        { status: 422 },
      );
    }

    const shipToAddress = normalizeShipToAddress(payload);

    // Build lines for Ingram request - each cart item becomes a line
    const lines = payload.lines.map((line, index) => {
      const mapping = mappingRecord[line.sku];
      return {
        customerLineNumber: String(index + 1).padStart(3, "0"),
        ingramPartNumber: mapping.ingramPartNumber,
        quantity: String(line.quantity),
        carrierCode: "", // Let Ingram return all available options
      };
    });

    const ingramPartNums = lines.map(l => l.ingramPartNumber);
    console.log(`[${correlationId}] Requesting freight estimate for ${lines.length} line items`);
    console.log(`[${correlationId}] Ingram part numbers: ${ingramPartNums.join(", ")}`);

    const ingramStart = Date.now();
    const response = await requestFreightEstimate(
      payload.shopDomain,
      {
        shipToAddress,
        lines,
      },
      {
        credentials: auth.credentials,
        accessToken: auth.accessToken,
      },
    );
    console.log(
      `[${correlationId}] Ingram freight ${response.cacheHit ? "cache hit" : "API call"} completed in ${Date.now() - ingramStart}ms`,
    );

    if (carrierShop) {
      const freightSummary = response.response?.freightEstimateResponse ?? {};
      const currency = freightSummary.currencyCode || carrierCurrency || "USD";
      const distributions: IngramDistribution[] = freightSummary?.distribution ?? [];

      console.log(`[${correlationId}] Received ${distributions.length} distribution(s) from Ingram`);

      // Log distribution details
      if (distributions.length > 0) {
        distributions.forEach((dist, i) => {
          const carrierCount = dist.carrierList?.length ?? 0;
          console.log(`[${correlationId}] Distribution ${i + 1}: Branch ${dist.shipFromBranchNumber}, ${carrierCount} carriers`);
        });
      }

      // Check for Ingram API errors
      if (response.response?.errors) {
        console.error(`[${correlationId}] Ingram API errors:`, response.response.errors);

        saveRateLog({
          shopDomain: payload.shopDomain,
          correlationId,
          requestType: "carrier_service",
          cartItemCount: payload.lines.length,
          cartSkus: uniqueSkus,
          ingramPartNums,
          shipToCity: payload.shipToAddress.city,
          shipToState: payload.shipToAddress.state,
          shipToZip: payload.shipToAddress.postalCode,
          shipToCountry: payload.shipToAddress.countryCode,
          status: "api_error",
          errorMessage: "Ingram API returned errors",
          errorDetails: response.response.errors,
          ingramRawResponse: response.response,
          durationMs: Date.now() - startTime,
        });

        const fallbackResponse = await getFallbackRateResponse(payload.shopDomain, currency);
        return Response.json(fallbackResponse, { status: 200 });
      }

      // Sync available carriers to database (for admin configuration)
      if (distributions.length > 0) {
        void syncCarriersFromResponse(payload.shopDomain, distributions).catch((syncError) => {
          console.error(`[${correlationId}] Failed to sync carriers:`, syncError);
        });
      }

      // Combine rates across all distributions
      const combinedRates = combineRates(distributions);
      console.log(`[${correlationId}] Combined into ${combinedRates.length} unique carrier options`);

      // Log combined rate details
      if (combinedRates.length > 0) {
        console.log(`[${correlationId}] Combined rates:`, combinedRates.map(r =>
          `${r.carrierCode}: $${r.totalCharge.toFixed(2)} (${r.distributions.length} distributions, complete: ${r.isComplete})`
        ).join(", "));
      } else {
        console.warn(`[${correlationId}] No combined rates! Distributions had no common carriers.`);

        // Log each distribution's carriers for debugging
        distributions.forEach((dist, i) => {
          const carriers = dist.carrierList?.map(c => c.carrierCode).join(", ") || "none";
          console.log(`[${correlationId}] Distribution ${i + 1} carriers: ${carriers}`);
        });
      }

      if (combinedRates.length === 0) {
        // No rates available - return fallback rate if configured
        saveRateLog({
          shopDomain: payload.shopDomain,
          correlationId,
          requestType: "carrier_service",
          cartItemCount: payload.lines.length,
          cartSkus: uniqueSkus,
          ingramPartNums,
          shipToCity: payload.shipToAddress.city,
          shipToState: payload.shipToAddress.state,
          shipToZip: payload.shipToAddress.postalCode,
          shipToCountry: payload.shipToAddress.countryCode,
          status: "no_rates",
          distributionCount: distributions.length,
          ratesReturned: 0,
          errorMessage: distributions.length === 0
            ? "No distributions returned from Ingram"
            : "No common carriers across distributions",
          ingramRawResponse: response.response,
          durationMs: Date.now() - startTime,
        });

        // Return fallback rate if configured
        const fallbackResponse = await getFallbackRateResponse(payload.shopDomain, currency);
        return Response.json(fallbackResponse, { status: 200 });
      }

      const carrierConfigs = await getCarrierConfigurations(payload.shopDomain);
      const enabledCodes = new Set(
        carrierConfigs.filter((config) => config.enabled).map((config) => config.carrierCode),
      );
      const configMap = new Map(carrierConfigs.map((c) => [c.carrierCode, c]));
      const hasConfigs = carrierConfigs.length > 0;

      let shopifyRates;

      if (hasConfigs) {
        console.log(`[${correlationId}] Enabled carrier codes: ${Array.from(enabledCodes).join(", ")}`);

        shopifyRates = combinedRates
          .filter(rate => enabledCodes.has(rate.carrierCode))
          .map(rate => {
            const config = configMap.get(rate.carrierCode);
            return formatRateForShopify(rate, currency, config?.displayName);
          });

        console.log(`[${correlationId}] Filtered to ${shopifyRates.length} enabled carriers`);
      } else {
        // No configuration yet - show all available carriers
        shopifyRates = combinedRates.map(rate =>
          formatRateForShopify(rate, currency)
        );
        console.log(`[${correlationId}] No carrier config, showing all ${shopifyRates.length} carriers`);
      }

      // Sort by price (cheapest first) and limit to reasonable number
      shopifyRates.sort((a, b) =>
        parseInt(a.total_price, 10) - parseInt(b.total_price, 10)
      );

      // Optionally limit to top N options to avoid overwhelming checkout
      const maxOptions = 10;
      if (shopifyRates.length > maxOptions) {
        shopifyRates = shopifyRates.slice(0, maxOptions);
      }

      console.log(`[${correlationId}] Returning ${shopifyRates.length} rates to Shopify`);

      // Log successful request
      saveRateLog({
        shopDomain: payload.shopDomain,
        correlationId,
        requestType: "carrier_service",
        cartItemCount: payload.lines.length,
        cartSkus: uniqueSkus,
        ingramPartNums,
        shipToCity: payload.shipToAddress.city,
        shipToState: payload.shipToAddress.state,
        shipToZip: payload.shipToAddress.postalCode,
        shipToCountry: payload.shipToAddress.countryCode,
        status: "success",
        distributionCount: distributions.length,
        ratesReturned: shopifyRates.length,
        ratesData: shopifyRates,
        ingramRawResponse: response.response,
        durationMs: Date.now() - startTime,
      });

      return Response.json({ rates: shopifyRates }, { status: 200 });
    }

    // Non-carrier request - return full response for testing/debugging
    return Response.json(
      {
        success: true,
        data: response.response,
        correlationId: response.correlationId,
        lineCount: lines.length,
      },
      { status: 200 },
    );
  } catch (error) {
    console.error(`[${correlationId}] Failed to retrieve freight estimate`, error);

    // Log error
    const errorDetails =
      error instanceof IngramError
        ? {
            status: error.status,
            details: error.details,
            stack: error.stack,
          }
        : error instanceof Error
          ? { stack: error.stack }
          : error;

    saveRateLog({
      shopDomain: payload.shopDomain,
      correlationId,
      requestType: carrierShop ? "carrier_service" : "cart_estimate",
      cartItemCount: payload.lines.length,
      cartSkus: uniqueSkus,
      shipToCity: payload.shipToAddress.city,
      shipToState: payload.shipToAddress.state,
      shipToZip: payload.shipToAddress.postalCode,
      shipToCountry: payload.shipToAddress.countryCode,
      status: "error",
      errorMessage: error instanceof Error ? error.message : "Unknown error",
      errorDetails,
      durationMs: Date.now() - startTime,
    });

    if (carrierShop) {
      const fallbackResponse = await getFallbackRateResponse(payload.shopDomain, carrierCurrency);
      return Response.json(fallbackResponse, { status: 200 });
    }

    return Response.json(
      {
        error: "Unable to retrieve freight estimate",
      },
      { status: 500 },
    );
  }
};
