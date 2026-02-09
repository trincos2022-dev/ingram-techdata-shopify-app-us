import z from "zod";
import prisma from "../db.server";
import { createTtlCache } from "app/utils/ttl-cache.server";
import { Td_SynnexCredential } from "@prisma/client";

const FREIGHT_URL = "https://ec.us.tdsynnex.com/SynnexXML/FreightQuote";
const SANDBOX_FREIGHT_URL =
  "https://ec.us.tdsynnex.com/sandbox/SynnexXML/FreightQuote";

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
// const inflightFreightRequests = new Map<
//   string,
//   Promise<{
//     correlationId: string;
//     response: unknown;
//     cacheHit: boolean;
//   }>
// >();

export const tdSynnex_credentialSchema = z.object({
  userName: z.string().min(1),
  password: z.string().min(1),
  customerNumber: z.string().min(1),
  customerName: z.string().optional(),
  sandbox: z.union([z.string(), z.boolean()]).optional(),
});

export type Td_CredentialInput = z.infer<typeof tdSynnex_credentialSchema>;

const tdSynnex_itemSchema = z.object({
  itemSKU: z.string().min(1),
  itemMfgPartNumber: z.string().min(1),
  itemQuantity: z.string().min(1),
});

const tdSynnex_rateTestSchema = z.object({
  addressName1: z.string().min(1),
  addressName2: z.string().optional().nullable(),
  addressLine1: z.string().min(1),
  city: z.string().min(1),
  state: z.string().min(2),
  zipCode: z.string().min(3),
  country: z.string().min(2).max(2),
  shipFromWarehouse: z.string().min(1),
  serviceLevel: z.string().optional().nullable(),
  shipMethodCode: z.string().optional().nullable(),
  Items: z.object({
    Item: z.union([z.array(tdSynnex_itemSchema), tdSynnex_itemSchema]),
  }),
});

export type Td_RateTestInput = z.infer<typeof tdSynnex_rateTestSchema>;

export class Td_synnexError extends Error {
  public readonly status?: number;
  public readonly details?: unknown;

  constructor(message: string, opts?: { status?: number; details?: unknown }) {
    super(message);
    this.name = "Td_synnexError";
    this.status = opts?.status;
    this.details = opts?.details;
  }
}

export async function td_getCredentials(shopDomain: string) {
  return prisma.td_SynnexCredential.findUnique({
    where: { shopDomain },
  });
}

export async function td_saveCredentials(
  shopDomain: string,
  data: Td_CredentialInput,
) {
  const sandboxFlag =
    typeof data.sandbox === "boolean"
      ? data.sandbox
      : data.sandbox
        ? String(data.sandbox).toLowerCase() === "true" ||
          String(data.sandbox).toLowerCase() === "on" ||
          String(data.sandbox) === "1"
        : true;
  const record = await prisma.td_SynnexCredential.upsert({
    where: { shopDomain },
    create: {
      shopDomain,
      userName: data.userName,
      password: data.password,
      customerNumber: data.customerNumber,
      customerName: data.customerName || "",
      sandbox: sandboxFlag,
      lastValidationStatus: "Never run",
    },
    update: {
      userName: data.userName,
      password: data.password,
      customerNumber: data.customerNumber,
      customerName: data.customerName,
      sandbox: sandboxFlag,
    },
  });

  return record;
}

async function getTd_CredentialsOrThrow(shopDomain: string) {
  const credentials = await td_getCredentials(shopDomain);

  if (!credentials) {
    throw new Td_synnexError(
      "No Ingram Micro credentials configured for shop.",
    );
  }

  return credentials;
}

export function parseTd_CredentialFormData(formData: FormData) {
  return tdSynnex_credentialSchema.safeParse({
    userName: formData.get("userName"),
    password: formData.get("password"),
    customerNumber: formData.get("customerNumber"),
    customerName: formData.get("customerName") ?? "",
    sandbox: formData.get("sandbox") ?? "true",
  });
}

//td_synnex parseRateTest
export function td_parseRateTestFormData(formData: FormData) {
  // Helper to get string value or empty string for required fields
  const getStringValue = (key: string): string => {
    const value = formData.get(key);
    return value ? String(value) : "";
  };

  // Helper to get optional string value (null/undefined if empty)
  const getOptionalStringValue = (key: string): string | null => {
    const value = formData.get(key);
    return value ? String(value) : null;
  };

  const dataToValidate = {
    addressName1: getStringValue("addressName1"),
    addressName2: getOptionalStringValue("addressName2"),
    addressLine1: getStringValue("addressLine1"),
    city: getStringValue("city"),
    state: getStringValue("state"),
    zipCode: getStringValue("zipCode"),
    country: getStringValue("country").toUpperCase(),
    shipFromWarehouse: getStringValue("shipFromWarehouse"),
    serviceLevel: getOptionalStringValue("serviceLevel"),
    shipMethodCode: getOptionalStringValue("shipMethodCode"),
    Items: {
      Item: {
        itemSKU: getStringValue("itemSKU"),
        itemMfgPartNumber: getStringValue("itemMfgPartNumber"),
        itemQuantity: getStringValue("itemQuantity"),
      },
    },
  };

  console.log("[TD SYNNEX] Form data received:", JSON.stringify(dataToValidate, null, 2));

  const parsed = tdSynnex_rateTestSchema.safeParse(dataToValidate);

  if (!parsed.success) {
    const flattened = parsed.error.flatten();
    const formErrors = flattened.formErrors.join(", ");
    const fieldErrors = Object.entries(flattened.fieldErrors)
      .map(([field, errors]) => `${field}: ${errors?.join(", ")}`)
      .join("; ");
    const errorMessage = [formErrors, fieldErrors].filter(Boolean).join("; ");

    console.error("[TD SYNNEX] Validation failed:", errorMessage);
    console.error("[TD SYNNEX] Raw error:", parsed.error);

    return {
      success: false as const,
      error: errorMessage || "Validation failed",
    };
  }

  return {
    success: true as const,
    data: parsed.data,
  };
}

//td_synnex freightEstimate api
export async function requestTd_FreightEstimate(
  shopDomain: string,
  payload: Td_RateTestInput,
  opts?: {
    credentials?: Td_SynnexCredential;
  },
) {
  try {
    const credentials =
      opts?.credentials ?? (await getTd_CredentialsOrThrow(shopDomain));

    if (!credentials.password) {
      throw new Td_synnexError(
        "Missing contact email. Update the credentials form before testing rates.",
      );
    }

    const xmlBody = buildTdFreightXml(credentials, payload);
    console.log(xmlBody);

    const response = await fetch(
      credentials.sandbox ? SANDBOX_FREIGHT_URL : FREIGHT_URL,
      {
        method: "POST",
        headers: {
          "Content-Type": "text/xml",
          Accept: "text/xml",
        },
        body: xmlBody,
      },
    );
    console.log(response);
    const responseText = await response.text();

    if (!response.ok) {
      console.error(
        `[TD SYNNEX] Freight estimate failed: ${response.status} ${response.statusText}`,
        responseText,
      );

      throw new Td_synnexError("Failed to fetch freight estimate", {
        status: response.status,
        details: responseText,
      });
    }

    return {
      response: responseText, // parse XML upstream if needed
      cacheHit: false,
    };
  } catch (e) {
    // Preserve original error if already a Td_synnexError
    if (e instanceof Td_synnexError) {
      throw e;
    }

    // Re-throw any other errors (network errors, etc.)
    console.error(
      "[TD SYNNEX] Unexpected error in requestTd_FreightEstimate:",
      e,
    );
    throw new Td_synnexError(
      `Unexpected error: ${e instanceof Error ? e.message : String(e)}`,
      { details: e },
    );
  }
}

function normalizeItems(items: Td_RateTestInput["Items"]["Item"]) {
  return Array.isArray(items) ? items : [items];
}

function buildTdFreightXml(
  credentials: Td_SynnexCredential,
  input: Td_RateTestInput,
) {
  const items = normalizeItems(input.Items.Item);

  return `<?xml version="1.0" encoding="UTF-8"?>
<SynnexB2B>
  <Credential>
    <UserID>${credentials.userName}</UserID>
    <Password>${credentials.password}</Password>
  </Credential>
  <FreightQuoteRequest version="2.0">
    <CustomerNumber>${credentials.customerNumber}</CustomerNumber>
    <RequestDateTime>${new Date().toISOString()}</RequestDateTime>
    <ShipFromWarehouse>${input.shipFromWarehouse ?? ""}</ShipFromWarehouse>
    <ShipTo>
      <AddressName1>${input.addressName1}</AddressName1>
      ${
        input.addressName2
          ? `<AddressName2>${input.addressName2}</AddressName2>`
          : ""
      }
      <AddressLine1>${input.addressLine1}</AddressLine1>
      <City>${input.city}</City>
      <State>${input.state}</State>
      <ZipCode>${input.zipCode}</ZipCode>
      <Country>${input.country}</Country>
    </ShipTo>
    ${input.serviceLevel ? `<ServiceLevel>${input.serviceLevel}</ServiceLevel>` : ""}
    <ShipMethodCode>${input.shipMethodCode ?? ""}</ShipMethodCode>
    <Items>
      ${items
        .map(
          (item, idx) => `
      <Item lineNumber="${item.lineNumber ?? idx + 1}">
        <SKU>${item.itemSKU}</SKU>
        <MfgPartNumber>${item.itemMfgPartNumber}</MfgPartNumber>
        <Quantity>${item.itemQuantity}</Quantity>
      </Item>`,
        )
        .join("")}
    </Items>
  </FreightQuoteRequest>
</SynnexB2B>`;
}
