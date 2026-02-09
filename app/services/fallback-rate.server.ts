import prisma from "../db.server";

export type FallbackRateSettings = {
  shopDomain: string;
  enabled: boolean;
  price: number;
  title: string;
  description: string;
};

const DEFAULT_SETTINGS: Omit<FallbackRateSettings, "shopDomain"> = {
  enabled: true,
  price: 999.0,
  title: "Shipping Unavailable",
  description: "Please contact support before placing this order",
};

export async function getFallbackRateSettings(
  shopDomain: string
): Promise<FallbackRateSettings> {
  try {
    const settings = await prisma.fallbackRateSettings.findUnique({
      where: { shopDomain },
    });

    if (!settings) {
      return {
        shopDomain,
        ...DEFAULT_SETTINGS,
      };
    }

    return {
      shopDomain: settings.shopDomain,
      enabled: settings.enabled,
      price: settings.price,
      title: settings.title,
      description: settings.description,
    };
  } catch (err) {
    console.warn("FallbackRateSettings table not available:", err);
    return {
      shopDomain,
      ...DEFAULT_SETTINGS,
    };
  }
}

export async function saveFallbackRateSettings(
  shopDomain: string,
  data: Partial<Omit<FallbackRateSettings, "shopDomain">>
): Promise<FallbackRateSettings> {
  const settings = await prisma.fallbackRateSettings.upsert({
    where: { shopDomain },
    create: {
      shopDomain,
      enabled: data.enabled ?? DEFAULT_SETTINGS.enabled,
      price: data.price ?? DEFAULT_SETTINGS.price,
      title: data.title ?? DEFAULT_SETTINGS.title,
      description: data.description ?? DEFAULT_SETTINGS.description,
    },
    update: {
      enabled: data.enabled,
      price: data.price,
      title: data.title,
      description: data.description,
      updatedAt: new Date(),
    },
  });

  return {
    shopDomain: settings.shopDomain,
    enabled: settings.enabled,
    price: settings.price,
    title: settings.title,
    description: settings.description,
  };
}

/**
 * Format fallback rate for Shopify carrier service response
 */
export function formatFallbackRateForShopify(
  settings: FallbackRateSettings,
  currency: string = "USD"
): {
  service_name: string;
  service_code: string;
  total_price: string;
  description: string;
  currency: string;
} {
  // Shopify expects price in cents
  const priceInCents = Math.round(settings.price * 100);

  return {
    service_name: settings.title,
    service_code: "FALLBACK_RATE",
    total_price: String(priceInCents),
    description: settings.description,
    currency,
  };
}
