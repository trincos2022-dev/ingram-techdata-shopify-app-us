/**
 * Cart Estimate API Endpoint
 *
 * This endpoint provides shipping estimates for the cart page before checkout.
 * It can be called directly from the theme's JavaScript to show estimated
 * shipping costs based on the customer's address.
 *
 * Unlike the carrier service endpoint, this one:
 * - Accepts CORS requests from the storefront
 * - Returns a simplified response format
 * - Doesn't require HMAC verification (public endpoint)
 */

import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";

import {
  requestFreightEstimate,
  getEnabledCarrierCodes,
  hasCarrierConfigurations,
  getCarrierConfigurations,
  getCredentials,
} from "../services/ingram.server";
import {
  getIngramMappingsForSkus,
  mappingArrayToRecord,
} from "../services/product-mapping.server";
import {
  combineRates,
  formatRateForShopify,
  type IngramDistribution,
} from "../services/rate-combiner.server";

type CartEstimateRequest = {
  shop: string;
  address: {
    country: string;
    province?: string;
    city?: string;
    zip?: string;
  };
  items: Array<{
    sku: string;
    quantity: number;
    grams?: number;
  }>;
};

type CartEstimateResponse = {
  success: boolean;
  rates?: Array<{
    name: string;
    code: string;
    price: number;
    currency: string;
    description: string;
  }>;
  error?: string;
};

// CORS headers for storefront requests
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, X-Shop-Domain",
};

// Handle OPTIONS preflight
export const loader = async ({ request }: LoaderFunctionArgs) => {
  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: corsHeaders,
    });
  }

  // GET requests not supported for this endpoint
  return Response.json(
    { success: false, error: "Use POST to request cart estimates" },
    { status: 405, headers: corsHeaders }
  );
};

export const action = async ({ request }: ActionFunctionArgs) => {
  // Handle CORS preflight
  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: corsHeaders,
    });
  }

  try {
    const body: CartEstimateRequest = await request.json();

    // Validate required fields
    if (!body.shop) {
      return Response.json(
        { success: false, error: "Missing shop domain" } as CartEstimateResponse,
        { status: 400, headers: corsHeaders }
      );
    }

    if (!body.address || !body.address.country) {
      return Response.json(
        { success: false, error: "Missing address information" } as CartEstimateResponse,
        { status: 400, headers: corsHeaders }
      );
    }

    if (!body.items || body.items.length === 0) {
      return Response.json(
        { success: false, error: "No items in cart" } as CartEstimateResponse,
        { status: 400, headers: corsHeaders }
      );
    }

    // Check if credentials exist for this shop
    const credentials = await getCredentials(body.shop);
    if (!credentials) {
      return Response.json(
        { success: false, error: "Shop not configured" } as CartEstimateResponse,
        { status: 400, headers: corsHeaders }
      );
    }

    // Get unique SKUs
    const uniqueSkus = Array.from(
      new Set(
        body.items
          .map((item) => item.sku?.trim())
          .filter((sku): sku is string => Boolean(sku))
      )
    );

    if (uniqueSkus.length === 0) {
      return Response.json(
        { success: false, error: "No valid SKUs in cart" } as CartEstimateResponse,
        { status: 400, headers: corsHeaders }
      );
    }

    // Map SKUs to Ingram part numbers
    const mappings = await getIngramMappingsForSkus(body.shop, uniqueSkus, {
      allowSupabaseFallback: false,
    });
    const mappingRecord = mappingArrayToRecord(mappings);

    const missingSkus = uniqueSkus.filter((sku) => !mappingRecord[sku]);
    if (missingSkus.length > 0) {
      console.warn("Cart estimate: Missing Ingram mappings for SKUs:", missingSkus);
      return Response.json(
        {
          success: false,
          error: "Some products are not available for shipping estimate",
        } as CartEstimateResponse,
        { status: 200, headers: corsHeaders }
      );
    }

    // Build ship-to address
    const shipToAddress = {
      companyName: "Customer",
      addressLine1: body.address.city || "Unknown",
      city: body.address.city || "Unknown",
      state: body.address.province || body.address.country,
      postalCode: body.address.zip || "00000",
      countryCode: body.address.country,
    };

    // Build lines for Ingram request
    const lines = body.items.map((item, index) => {
      const mapping = mappingRecord[item.sku];
      return {
        customerLineNumber: String(index + 1).padStart(3, "0"),
        ingramPartNumber: mapping.ingramPartNumber,
        quantity: String(item.quantity),
        carrierCode: "",
      };
    });

    console.log(`Cart estimate: Requesting for ${lines.length} items to ${shipToAddress.postalCode}`);

    // Request freight estimate from Ingram
    const response = await requestFreightEstimate(body.shop, {
      shipToAddress,
      lines,
    });

    const freightSummary = response.response?.freightEstimateResponse ?? {};
    const currency = freightSummary.currencyCode || "USD";
    const distributions: IngramDistribution[] = freightSummary?.distribution ?? [];

    if (distributions.length === 0) {
      return Response.json(
        {
          success: false,
          error: "No shipping options available for this address",
        } as CartEstimateResponse,
        { status: 200, headers: corsHeaders }
      );
    }

    // Combine rates across distributions
    const combinedRates = combineRates(distributions);

    if (combinedRates.length === 0) {
      return Response.json(
        {
          success: false,
          error: "No common shipping options available",
        } as CartEstimateResponse,
        { status: 200, headers: corsHeaders }
      );
    }

    // Check if carrier configurations exist for filtering
    const hasConfigs = await hasCarrierConfigurations(body.shop);

    let filteredRates = combinedRates;

    if (hasConfigs) {
      const enabledCodes = await getEnabledCarrierCodes(body.shop);
      filteredRates = combinedRates.filter((rate) =>
        enabledCodes.has(rate.carrierCode)
      );
    }

    // Get carrier configs for display names
    const carrierConfigs = await getCarrierConfigurations(body.shop);
    const configMap = new Map(carrierConfigs.map((c) => [c.carrierCode, c]));

    // Format rates for response
    const rates = filteredRates
      .map((rate) => {
        const config = configMap.get(rate.carrierCode);
        const formatted = formatRateForShopify(rate, currency, config?.displayName);
        return {
          name: formatted.service_name,
          code: formatted.service_code,
          price: parseInt(formatted.total_price, 10) / 100, // Convert cents to dollars
          currency,
          description: formatted.description,
        };
      })
      .sort((a, b) => a.price - b.price)
      .slice(0, 5); // Limit to 5 options for cart page

    return Response.json(
      { success: true, rates } as CartEstimateResponse,
      { status: 200, headers: corsHeaders }
    );
  } catch (error) {
    console.error("Cart estimate error:", error);
    return Response.json(
      {
        success: false,
        error: "Unable to calculate shipping estimate",
      } as CartEstimateResponse,
      { status: 200, headers: corsHeaders }
    );
  }
};
