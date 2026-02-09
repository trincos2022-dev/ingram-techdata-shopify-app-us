/**
 * Rate Combiner Service
 *
 * Combines shipping rates from multiple Ingram distributions (warehouses)
 * into consolidated rates for Shopify checkout.
 *
 * When products ship from different warehouses, Ingram returns separate
 * rate sets per distribution. This service aggregates them into single
 * rates per carrier type.
 */

export type IngramCarrier = {
  carrierCode: string;
  shipVia: string;
  carrierMode: string;
  estimatedFreightCharge: string | number;
  daysInTransit: string | number;
};

export type IngramDistribution = {
  shipFromBranchNumber: string;
  carrierCode: string;
  shipVia: string;
  freightRate: number;
  totalWeight: number;
  transitDays: number;
  carrierList: IngramCarrier[];
};

export type CombinedRate = {
  carrierCode: string;
  shipVia: string;
  carrierMode: string;
  totalCharge: number;
  maxDaysInTransit: number;
  distributions: Array<{
    branchNumber: string;
    charge: number;
    daysInTransit: number;
  }>;
  isComplete: boolean; // true if carrier available in ALL distributions
};

/**
 * Combines shipping rates from multiple distributions into consolidated rates.
 *
 * Strategy:
 * 1. Build a map of carrier code -> charges per distribution
 * 2. For each unique carrier, sum charges across all distributions
 * 3. Mark carriers as "complete" if available in ALL distributions
 * 4. Use max transit days across distributions (worst case)
 * 5. Return sorted by total charge (cheapest first)
 *
 * @param distributions - Array of Ingram distribution objects
 * @returns Array of combined rates sorted by total charge
 */
export function combineRates(distributions: IngramDistribution[]): CombinedRate[] {
  if (!distributions || distributions.length === 0) {
    return [];
  }

  // If only one distribution, just return its carriers directly
  if (distributions.length === 1) {
    const dist = distributions[0];
    const carriers = dist.carrierList ?? [];

    return carriers
      .map((carrier) => ({
        carrierCode: carrier.carrierCode?.trim() || "",
        shipVia: carrier.shipVia?.trim() || "",
        carrierMode: carrier.carrierMode?.trim() || "",
        totalCharge: parseFloat(String(carrier.estimatedFreightCharge)) || 0,
        maxDaysInTransit: parseInt(String(carrier.daysInTransit), 10) || 0,
        distributions: [
          {
            branchNumber: dist.shipFromBranchNumber,
            charge: parseFloat(String(carrier.estimatedFreightCharge)) || 0,
            daysInTransit: parseInt(String(carrier.daysInTransit), 10) || 0,
          },
        ],
        isComplete: true,
      }))
      .filter((rate) => rate.carrierCode && rate.totalCharge > 0)
      .sort((a, b) => a.totalCharge - b.totalCharge);
  }

  // Build map: carrierCode -> { distributions data }
  const carrierMap = new Map<
    string,
    {
      shipVia: string;
      carrierMode: string;
      distributions: Map<
        string,
        {
          charge: number;
          daysInTransit: number;
        }
      >;
    }
  >();

  const distributionBranches = new Set<string>();

  for (const dist of distributions) {
    const branchNumber = dist.shipFromBranchNumber;
    distributionBranches.add(branchNumber);

    const carriers = dist.carrierList ?? [];

    for (const carrier of carriers) {
      const code = carrier.carrierCode?.trim();
      if (!code) continue;

      const charge = parseFloat(String(carrier.estimatedFreightCharge)) || 0;
      const transit = parseInt(String(carrier.daysInTransit), 10) || 0;

      if (!carrierMap.has(code)) {
        carrierMap.set(code, {
          shipVia: carrier.shipVia?.trim() || code,
          carrierMode: carrier.carrierMode?.trim() || "",
          distributions: new Map(),
        });
      }

      const carrierData = carrierMap.get(code)!;

      // If carrier appears multiple times in same distribution, take the lower charge
      const existing = carrierData.distributions.get(branchNumber);
      if (!existing || charge < existing.charge) {
        carrierData.distributions.set(branchNumber, {
          charge,
          daysInTransit: transit,
        });
      }
    }
  }

  // Build combined rates
  const combinedRates: CombinedRate[] = [];
  const totalDistributions = distributionBranches.size;

  for (const [carrierCode, data] of carrierMap) {
    const isComplete = data.distributions.size === totalDistributions;

    let totalCharge = 0;
    let maxDaysInTransit = 0;
    const distDetails: CombinedRate["distributions"] = [];

    for (const [branchNumber, distData] of data.distributions) {
      totalCharge += distData.charge;
      maxDaysInTransit = Math.max(maxDaysInTransit, distData.daysInTransit);
      distDetails.push({
        branchNumber,
        charge: distData.charge,
        daysInTransit: distData.daysInTransit,
      });
    }

    // Only include carriers that are available in ALL distributions
    // This ensures we don't show partial shipping options
    if (isComplete && totalCharge > 0) {
      combinedRates.push({
        carrierCode,
        shipVia: data.shipVia,
        carrierMode: data.carrierMode,
        totalCharge,
        maxDaysInTransit,
        distributions: distDetails,
        isComplete,
      });
    }
  }

  // Sort by total charge (cheapest first)
  return combinedRates.sort((a, b) => a.totalCharge - b.totalCharge);
}

/**
 * Get friendly display name for carrier
 */
export function getCarrierDisplayName(shipVia: string, carrierCode: string): string {
  const name = shipVia?.trim() || carrierCode?.trim() || "Standard Shipping";

  // Clean up common Ingram naming issues
  const cleanName = name
    .replace(/\s+/g, " ")
    .replace(/FEDX/g, "FedEx")
    .replace(/OVERNITE/g, "Overnight")
    .replace(/EXPRES\b/g, "Express")
    .replace(/NXT DAY/g, "Next Day")
    .replace(/2DAY INT/g, "2-Day")
    .replace(/STD OVR/g, "Standard Overnight")
    .replace(/PRTY 1/g, "Priority")
    .replace(/AIR SAT/g, "Saturday")
    .trim();

  return cleanName;
}

/**
 * Get transit time description
 */
export function getTransitDescription(days: number): string {
  if (days <= 0) return "";
  if (days === 1) return "Next business day";
  if (days === 2) return "2 business days";
  if (days === 3) return "3 business days";
  return `${days} business days`;
}

/**
 * Format combined rate for Shopify carrier service response
 */
export function formatRateForShopify(
  rate: CombinedRate,
  currency: string = "USD",
  customDisplayName?: string | null
): {
  service_name: string;
  service_code: string;
  total_price: string;
  currency: string;
  description: string;
} {
  const displayName =
    customDisplayName || getCarrierDisplayName(rate.shipVia, rate.carrierCode);

  const transitDesc = getTransitDescription(rate.maxDaysInTransit);

  // Build description showing transit time and multi-warehouse info
  const descParts: string[] = [];
  if (transitDesc) {
    descParts.push(transitDesc);
  }
  if (rate.distributions.length > 1) {
    descParts.push(`Ships from ${rate.distributions.length} locations`);
  }

  return {
    service_name: displayName,
    service_code: `INGRAM_${rate.carrierCode}`,
    total_price: Math.max(0, Math.round(rate.totalCharge * 100)).toString(),
    currency,
    description: descParts.join(" • ") || "Ingram Micro freight",
  };
}
