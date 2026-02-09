// Ingram Micro Integration - Admin Dashboard
import { useEffect, useMemo, useState } from "react";
import type {
  ActionFunctionArgs,
  HeadersFunction,
  LoaderFunctionArgs,
} from "react-router";
import {
  Form,
  useActionData,
  useLoaderData,
  useNavigation,
  useFetcher,
  useRouteError,
} from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";

import { authenticate, apiVersion } from "../shopify.server";
import prisma from "../db.server";
import {
  IngramError,
  getCredentials,
  parseCredentialFormData,
  parseRateTestFormData,
  requestFreightEstimate,
  saveCredentials,
  testCredentials,
  getCarrierConfigurations,
  updateCarrierEnabledStatus,
  type CarrierConfig,
} from "../services/ingram.server";
import { getLatestProductSyncJob } from "../services/product-sync.server";
import {
  getFallbackRateSettings,
  saveFallbackRateSettings,
  type FallbackRateSettings,
} from "../services/fallback-rate.server";
import {
  parseTd_CredentialFormData,
  requestTd_FreightEstimate,
  td_getCredentials,
  td_parseRateTestFormData,
  td_saveCredentials,
} from "app/services/tdsynnex.server";

const DEFAULT_LINES = JSON.stringify(
  [
    {
      lineNumber: 1,
      itemDescription: "Sample item",
      quantity: 1,
      unitOfMeasure: "EA",
      weight: 1,
    },
  ],
  null,
  2,
);

type CarrierServiceSummary = {
  id: number;
  name: string;
  callbackUrl: string;
  active: boolean;
  serviceDiscovery: boolean;
};

type RateRequestLogEntry = {
  id: string;
  correlationId: string;
  requestType: string;
  cartItemCount: number;
  cartSkus: string;
  ingramPartNums: string | null;
  shipToCity: string | null;
  shipToState: string | null;
  shipToZip: string | null;
  shipToCountry: string | null;
  status: string;
  distributionCount: number | null;
  ratesReturned: number | null;
  ratesData: string | null;
  errorMessage: string | null;
  errorDetails: string | null;
  ingramRawResponse: string | null;
  durationMs: number | null;
  createdAt: string;
};

type ProductSyncJobEntry = {
  id: string;
  shopDomain: string;
  status: string;
  processed: number;
  total: number;
  error: string | null;
  createdAt: string;
  updatedAt: string;
  finishedAt: string | null;
} | null;

type LoaderData = {
  tdcredentials: Awaited<ReturnType<typeof td_getCredentials>>;
  credentials: Awaited<ReturnType<typeof getCredentials>>;
  carrierService?: CarrierServiceSummary | null;
  carrierConfigs: CarrierConfig[];
  rateLogs: RateRequestLogEntry[];
  latestProductSyncJob: ProductSyncJobEntry;
  fallbackRateSettings: FallbackRateSettings;
};

const carrierCallbackPath = "/api/ingram/rates";

function getAppCallbackUrl() {
  const appUrl = process.env.SHOPIFY_APP_URL;
  if (!appUrl) {
    throw new Error("SHOPIFY_APP_URL is not configured");
  }
  return new URL(carrierCallbackPath, appUrl).toString();
}

function requireAccessToken(token?: string | null) {
  if (!token) {
    throw new Error("Missing admin access token");
  }
  return token;
}

async function fetchCarrierServices(shop: string, accessToken: string) {
  const response = await fetch(
    `https://${shop}/admin/api/${apiVersion}/carrier_services.json`,
    {
      method: "GET",
      headers: {
        "X-Shopify-Access-Token": accessToken,
        "Content-Type": "application/json",
      },
    },
  );

  if (!response.ok) {
    throw new Error(
      `Failed to fetch carrier services: ${response.status} ${await response.text()}`,
    );
  }

  const json = (await response.json()) as {
    carrier_services: Array<{
      id: number;
      name: string;
      callback_url: string;
      active: boolean;
      service_discovery: boolean;
    }>;
  };

  return json.carrier_services;
}

async function findExistingCarrierService(shop: string, accessToken: string) {
  const services = await fetchCarrierServices(shop, accessToken);
  const callbackUrl = getAppCallbackUrl();
  const match = services.find(
    (service) => service.callback_url === callbackUrl,
  );

  if (!match) return null;

  return {
    id: match.id,
    name: match.name,
    callbackUrl: match.callback_url,
    active: match.active,
    serviceDiscovery: match.service_discovery,
  } satisfies CarrierServiceSummary;
}

async function registerCarrierServiceForShop(
  shop: string,
  accessToken: string,
) {
  const callbackUrl = getAppCallbackUrl();
  const response = await fetch(
    `https://${shop}/admin/api/${apiVersion}/carrier_services.json`,
    {
      method: "POST",
      headers: {
        "X-Shopify-Access-Token": accessToken,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        carrier_service: {
          name: "Ingram Freight",
          callback_url: callbackUrl,
          service_discovery: true,
          carrier_service_type: "api",
        },
      }),
    },
  );

  if (!response.ok) {
    throw new Error(
      `Failed to register carrier service: ${response.status} ${await response.text()}`,
    );
  }
}

async function deleteCarrierServiceForShop(
  shop: string,
  accessToken: string,
  id: number,
) {
  const response = await fetch(
    `https://${shop}/admin/api/${apiVersion}/carrier_services/${id}.json`,
    {
      method: "DELETE",
      headers: {
        "X-Shopify-Access-Token": accessToken,
        "Content-Type": "application/json",
      },
    },
  );

  if (!response.ok) {
    throw new Error(
      `Failed to delete carrier service: ${response.status} ${await response.text()}`,
    );
  }
}

type ActionResult =
  | {
      ok: true;
      intent: "saveCredentials";
      message: string;
    }
  | {
      ok: true;
      intent: "td_SynnexCredentials";
      message: string;
    }
  | {
      ok: true;
      intent: "testConnection";
      message: string;
    }
  | {
      ok: true;
      intent: "testRate";
      message: string;
      data: { correlationId: string; response: unknown };
    }
  | {
      ok: true;
      intent: "td_SynnextestRate";
      message: string;
      data: { response: unknown };
    }
  | {
      ok: true;
      intent: "registerCarrierService";
      message: string;
    }
  | {
      ok: true;
      intent: "deleteCarrierService";
      message: string;
    }
  | {
      ok: true;
      intent: "saveCarrierConfig";
      message: string;
    }
  | {
      ok: true;
      intent: "saveFallbackRate";
      message: string;
    }
  | {
      ok: false;
      intent: string;
      message: string;
      errors?: Record<string, string>;
      details?: unknown;
    };

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);

  //Ingram micro credentials
  const credentials = await getCredentials(session.shop);
  //Td_Synnex credentials
  const tdcredentials = await td_getCredentials(session.shop);

  let carrierService: CarrierServiceSummary | null = null;
  try {
    carrierService = await findExistingCarrierService(
      session.shop,
      requireAccessToken(session.accessToken),
    );
  } catch (error) {
    console.error("Unable to fetch carrier services", error);
  }

  // Fetch carrier configurations
  const carrierConfigs = await getCarrierConfigurations(session.shop);

  // Fetch recent rate request logs (last 50)
  let serializedLogs: RateRequestLogEntry[] = [];
  try {
    const rateLogs = await prisma.rateRequestLog.findMany({
      where: { shopDomain: session.shop },
      orderBy: { createdAt: "desc" },
      take: 50,
    });

    // Convert dates to strings for serialization
    serializedLogs = rateLogs.map((log) => ({
      ...log,
      createdAt: log.createdAt.toISOString(),
    }));
  } catch (error) {
    console.error("Failed to fetch rate request logs:", error);
    // Continue without logs - don't crash the page
  }

  let latestProductSyncJob: ProductSyncJobEntry = null;
  try {
    const latestProductSyncJobRecord = await getLatestProductSyncJob(
      session.shop,
    );
    latestProductSyncJob = latestProductSyncJobRecord
      ? {
          ...latestProductSyncJobRecord,
          createdAt: latestProductSyncJobRecord.createdAt.toISOString(),
          updatedAt: latestProductSyncJobRecord.updatedAt.toISOString(),
          finishedAt: latestProductSyncJobRecord.finishedAt
            ? latestProductSyncJobRecord.finishedAt.toISOString()
            : null,
        }
      : null;
  } catch (error) {
    console.error("Failed to fetch product sync job:", error);
    // Continue without sync job - don't crash the page
  }

  // Fetch fallback rate settings
  const fallbackRateSettings = await getFallbackRateSettings(session.shop);

  return {
    tdcredentials,
    credentials,
    carrierService,
    carrierConfigs,
    rateLogs: serializedLogs,
    latestProductSyncJob,
    fallbackRateSettings,
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const formData = await request.formData();
  console.log("formData entries:", Object.fromEntries(formData.entries()));

  const intent = String(formData.get("_action") || "");

  try {
    switch (intent) {
      // td_SynnexCredentials
      case "saveCredentials": {
        const parsed = parseCredentialFormData(formData);

        if (!parsed.success) {
          const flattened = parsed.error.flatten();
          const errors: Record<string, string> = {};
          for (const [field, issues] of Object.entries(flattened.fieldErrors)) {
            if (issues && issues.length > 0) {
              errors[field] = issues[0]!;
            }
          }

          return {
            ok: false,
            intent,
            message: "Please fill out the missing fields.",
            errors,
          } satisfies ActionResult;
        }

        await saveCredentials(session.shop, parsed.data);
        return {
          ok: true,
          intent,
          message: "Credentials saved.",
        } satisfies ActionResult;
      }

      // td_SynnexCredentials
      case "td_SynnexCredentials": {
        const parsed = parseTd_CredentialFormData(formData);
        console.log(parsed);

        if (!parsed.success) {
          const flattened = parsed.error.flatten();
          const errors: Record<string, string> = {};
          for (const [field, issues] of Object.entries(flattened.fieldErrors)) {
            if (issues && issues.length > 0) {
              errors[field] = issues[0]!;
            }
          }

          return {
            ok: false,
            intent,
            message: "Please fill out the missing fields.",
            errors,
          } satisfies ActionResult;
        }

        await td_saveCredentials(session.shop, parsed.data);
        return {
          ok: true,
          intent,
          message: "Credentials saved.",
        } satisfies ActionResult;
      }
      case "testConnection": {
        await testCredentials(session.shop);
        return {
          ok: true,
          intent,
          message: "Successfully generated an OAuth token.",
        } satisfies ActionResult;
      }
      case "testRate": {
        const parsed = parseRateTestFormData(formData);

        if (!parsed.success) {
          return {
            ok: false,
            intent,
            message: parsed.error,
          } satisfies ActionResult;
        }

        const result = await requestFreightEstimate(session.shop, parsed.data);

        return {
          ok: true,
          intent,
          message: "Freight estimate successfully returned.",
          data: result,
        } satisfies ActionResult;
      }
      case "td_SynnextestRate": {
        const parsed = td_parseRateTestFormData(formData);
        console.log(parsed);

        if (!parsed.success) {
          return {
            ok: false,
            intent,
            message: parsed.error,
          } satisfies ActionResult;
        }

        const result = await requestTd_FreightEstimate(
          session.shop,
          parsed.data,
        );

        return {
          ok: true,
          intent,
          message: "Freight estimate successfully returned.",
          data: result,
        } satisfies ActionResult;
      }
      case "registerCarrierService": {
        await registerCarrierServiceForShop(
          session.shop,
          requireAccessToken(session.accessToken),
        );
        return {
          ok: true,
          intent,
          message:
            "Carrier service registered. Shopify will now call the app for rates.",
        } satisfies ActionResult;
      }
      case "deleteCarrierService": {
        const id = Number(formData.get("carrierServiceId"));
        if (!id) {
          return {
            ok: false,
            intent,
            message: "Carrier service ID missing.",
          } satisfies ActionResult;
        }

        await deleteCarrierServiceForShop(
          session.shop,
          requireAccessToken(session.accessToken),
          id,
        );

        return {
          ok: true,
          intent,
          message: "Carrier service removed.",
        } satisfies ActionResult;
      }
      case "saveCarrierConfig": {
        // Get all carrier codes from form data
        const carrierConfigs = await getCarrierConfigurations(session.shop);
        const updates: Array<{ carrierCode: string; enabled: boolean }> = [];

        for (const config of carrierConfigs) {
          const isEnabled =
            formData.get(`carrier_${config.carrierCode}`) === "on";
          updates.push({
            carrierCode: config.carrierCode,
            enabled: isEnabled,
          });
        }

        await updateCarrierEnabledStatus(session.shop, updates);

        return {
          ok: true,
          intent,
          message: `Updated ${updates.length} carrier configurations.`,
        } satisfies ActionResult;
      }
      case "saveFallbackRate": {
        const enabled = formData.get("fallbackEnabled") === "on";
        const priceStr = formData.get("fallbackPrice");
        const title = formData.get("fallbackTitle");
        const description = formData.get("fallbackDescription");

        const price = priceStr ? parseFloat(String(priceStr)) : 999;

        await saveFallbackRateSettings(session.shop, {
          enabled,
          price: isNaN(price) ? 999 : price,
          title: title ? String(title) : "Shipping Unavailable",
          description: description
            ? String(description)
            : "Please contact support before placing this order",
        });

        return {
          ok: true,
          intent,
          message: "Fallback rate settings saved.",
        } satisfies ActionResult;
      }
      default:
        return {
          ok: false,
          intent,
          message: "Unknown action requested.",
        } satisfies ActionResult;
    }
  } catch (error) {
    if (error instanceof IngramError) {
      return {
        ok: false,
        intent,
        message: error.message,
        details: error.details,
      } satisfies ActionResult;
    }

    console.error(error);
    return {
      ok: false,
      intent,
      message: "Unexpected error. Check the server logs for details.",
    } satisfies ActionResult;
  }
};

export default function Index() {
  const {
    tdcredentials,
    credentials,
    carrierService,
    carrierConfigs,
    rateLogs,
    latestProductSyncJob,
    fallbackRateSettings,
  } = useLoaderData<LoaderData>();
  const [expandedLogId, setExpandedLogId] = useState<string | null>(null);
  const actionData = useActionData<ActionResult>();
  const navigation = useNavigation();
  const syncFetcher = useFetcher<{ job: LoaderData["latestProductSyncJob"] }>();

  //Ingram micro credentials
  const [credentialsForm, setCredentialsForm] = useState(() => ({
    clientId: credentials?.clientId ?? "",
    clientSecret: credentials?.clientSecret ?? "",
    customerNumber: credentials?.customerNumber ?? "",
    countryCode: credentials?.countryCode ?? "US",
    contactEmail: credentials?.contactEmail ?? "",
    senderId: credentials?.senderId ?? "",
    billToAddressId: credentials?.billToAddressId ?? "",
    shipToAddressId: credentials?.shipToAddressId ?? "",
    sandbox: credentials?.sandbox ?? true,
  }));

  useEffect(() => {
    setCredentialsForm({
      clientId: credentials?.clientId ?? "",
      clientSecret: credentials?.clientSecret ?? "",
      customerNumber: credentials?.customerNumber ?? "",
      countryCode: credentials?.countryCode ?? "US",
      contactEmail: credentials?.contactEmail ?? "",
      senderId: credentials?.senderId ?? "",
      billToAddressId: credentials?.billToAddressId ?? "",
      shipToAddressId: credentials?.shipToAddressId ?? "",
      sandbox: credentials?.sandbox ?? true,
    });
  }, [credentials?.shopDomain, credentials?.clientId, credentials?.updatedAt]);

  //Td_synnex credentials
  const [tdCredentialsForm, setTdCredentialsForm] = useState(() => ({
    userName: tdcredentials?.userName,
    password: tdcredentials?.password,
    customerName: tdcredentials?.customerName,
    customerNumber: tdcredentials?.customerNumber ?? "",
    sandbox: tdcredentials?.sandbox ?? true,
  }));

  useEffect(() => {
    setTdCredentialsForm({
      userName: tdcredentials?.userName,
      password: tdcredentials?.password,
      customerName: tdcredentials?.customerName,
      customerNumber: tdcredentials?.customerNumber ?? "",
      sandbox: tdcredentials?.sandbox ?? true,
    });
  }, [tdcredentials?.shopDomain, tdcredentials?.updatedAt]);

  const [linesInput, setLinesInput] = useState(DEFAULT_LINES);

  const [fallbackForm, setFallbackForm] = useState(() => ({
    enabled: fallbackRateSettings.enabled,
    price: fallbackRateSettings.price,
    title: fallbackRateSettings.title,
    description: fallbackRateSettings.description,
  }));

  const [selectedApp, setSelectedApp] = useState<"ingrammicro" | "tdsynnex">(
    "ingrammicro",
  );

  useEffect(() => {
    setFallbackForm({
      enabled: fallbackRateSettings.enabled,
      price: fallbackRateSettings.price,
      title: fallbackRateSettings.title,
      description: fallbackRateSettings.description,
    });
  }, [fallbackRateSettings]);

  const isSaving = navigation.formData?.get("_action") === "saveCredentials";
  const tdisSaving =
    navigation.formData?.get("_action") === "td_SynnexCredentials";
  const isTestingConnection =
    navigation.formData?.get("_action") === "testConnection";
  const isTestingRate = navigation.formData?.get("_action") === "testRate";
  const isTdTestingRate =
    navigation.formData?.get("_action") === "td_SynnextestRate";
  const isRegisteringCarrier =
    navigation.formData?.get("_action") === "registerCarrierService";
  const isDeletingCarrier =
    navigation.formData?.get("_action") === "deleteCarrierService";
  const isSavingCarrierConfig =
    navigation.formData?.get("_action") === "saveCarrierConfig";
  const isSavingFallbackRate =
    navigation.formData?.get("_action") === "saveFallbackRate";
  const isStartingSync = syncFetcher.state === "submitting";

  const fieldErrors =
    actionData?.intent === "saveCredentials" && !actionData.ok
      ? actionData.errors
      : undefined;

  const tdfieldErrors =
    actionData?.intent === "td_SynnexCredentials" && !actionData.ok
      ? actionData.errors
      : undefined;

  const rateResult =
    actionData?.intent === "testRate" && actionData.ok ? actionData.data : null;
  const td_rateResult =
    actionData?.intent === "td_SynnextestRate" && actionData.ok
      ? actionData.data
      : null;

  const statusMessage = useMemo(() => {
    if (!actionData) return null;
    return actionData.message;
  }, [actionData]);

  function formatXml(xml) {
    const parsed = new DOMParser().parseFromString(xml, "application/xml");
    const serializer = new XMLSerializer();
    const formatted = serializer.serializeToString(parsed);

    // add indentation
    return formatted.replace(/(>)(<)(\/*)/g, "$1\n$2$3");
  }

  const readFieldValue = (event: any) => {
    const target = event?.currentTarget as { value?: string | null } | null;
    if (target && typeof target.value === "string") {
      return target.value;
    }

    if (typeof event?.target?.value === "string") {
      return event.target.value;
    }

    const detailValue = event?.detail?.value;
    if (typeof detailValue === "string") {
      return detailValue;
    }

    return "";
  };
  const showDetails =
    !!actionData &&
    !actionData.ok &&
    actionData.details !== undefined &&
    actionData.details !== null;
  const detailsJson = showDetails
    ? JSON.stringify(actionData.details, null, 2)
    : null;

  const currentSyncJob = syncFetcher.data?.job ?? latestProductSyncJob;
  const syncStatus = currentSyncJob?.status ?? "idle";
  const syncProcessed = currentSyncJob?.processed ?? 0;
  const syncTotal = currentSyncJob?.total ?? 0;
  const syncPercent =
    syncTotal > 0
      ? Math.min(100, Math.round((syncProcessed / syncTotal) * 100))
      : syncStatus === "success"
        ? 100
        : 0;
  const syncFinishedAt = currentSyncJob?.finishedAt
    ? new Date(currentSyncJob.finishedAt)
    : null;
  const syncIsRunning = syncStatus === "running";

  useEffect(() => {
    if (syncFetcher.state === "loading") {
      return;
    }
    if (currentSyncJob?.status === "running") {
      syncFetcher.load("/api/sync-products");
      const interval = setInterval(() => {
        syncFetcher.load("/api/sync-products");
      }, 2000);
      return () => clearInterval(interval);
    }
    return;
  }, [currentSyncJob?.status, syncFetcher]);

  return (
    <s-page heading="Ingram Micro freight rates | TD_Synnex freight quote ">
      {statusMessage && (
        <div
          style={{
            padding: "1rem",
            border: "1px solid var(--color-border, #d2d5d8)",
            borderRadius: "var(--border-radius, 8px)",
            background: "var(--color-bg-surface-hover, #f6f6f7)",
          }}
        >
          <s-text>{statusMessage}</s-text>
          {showDetails ? (
            <pre style={{ marginTop: "0.75rem" }}>
              <code>{detailsJson}</code>
            </pre>
          ) : null}
        </div>
      )}

      <div
        style={{
          marginBottom: "1rem",
          display: "flex",
          alignItems: "center",
          gap: "0.75rem",
        }}
      >
        <label htmlFor="platform-select">
          <s-text>Platform</s-text>
        </label>
        <select
          id="platform-select"
          value={selectedApp}
          onChange={(e) =>
            setSelectedApp(e.currentTarget.value as "ingrammicro" | "tdsynnex")
          }
        >
          <option value="ingrammicro">Ingram Micro</option>
          <option value="tdsynnex">TD_Synnex</option>
        </select>
      </div>

      {selectedApp === "ingrammicro" ? (
        <s-stack direction="block" gap="base">
          <s-section heading="API credentials">
            <s-paragraph>
              Provide the OAuth client data and the required header values from
              the Ingram Micro reseller portal. These credentials are stored per
              shop and used by checkout and the rate testing tools below.
            </s-paragraph>
            <Form method="post">
              <input type="hidden" name="_action" value="saveCredentials" />
              <s-stack direction="block" gap="base">
                <s-text-field
                  name="clientId"
                  label="Client ID"
                  value={credentialsForm.clientId}
                  onInput={(event) =>
                    setCredentialsForm((prev) => ({
                      ...prev,
                      clientId: readFieldValue(event),
                    }))
                  }
                  required
                  error={fieldErrors?.clientId}
                />
                <s-text-field
                  name="clientSecret"
                  label="Client secret"
                  value={credentialsForm.clientSecret}
                  onInput={(event) =>
                    setCredentialsForm((prev) => ({
                      ...prev,
                      clientSecret: readFieldValue(event),
                    }))
                  }
                  required
                  error={fieldErrors?.clientSecret}
                />
                <s-text-field
                  name="customerNumber"
                  label="IM-CustomerNumber"
                  value={credentialsForm.customerNumber}
                  onInput={(event) =>
                    setCredentialsForm((prev) => ({
                      ...prev,
                      customerNumber: readFieldValue(event),
                    }))
                  }
                  required
                  error={fieldErrors?.customerNumber}
                />
                <s-text-field
                  name="countryCode"
                  label="IM-CountryCode"
                  maxLength={2}
                  value={credentialsForm.countryCode}
                  onInput={(event) =>
                    setCredentialsForm((prev) => ({
                      ...prev,
                      countryCode: readFieldValue(event),
                    }))
                  }
                  required
                  error={fieldErrors?.countryCode}
                />
                <s-text-field
                  name="contactEmail"
                  label="Contact email (IM-CustomerContact)"
                  value={credentialsForm.contactEmail}
                  onInput={(event) =>
                    setCredentialsForm((prev) => ({
                      ...prev,
                      contactEmail: readFieldValue(event),
                    }))
                  }
                  required
                  error={fieldErrors?.contactEmail}
                />
                <s-text-field
                  name="senderId"
                  label="IM-SenderID (optional)"
                  value={credentialsForm.senderId}
                  onInput={(event) =>
                    setCredentialsForm((prev) => ({
                      ...prev,
                      senderId: readFieldValue(event),
                    }))
                  }
                />
                <s-text-field
                  name="billToAddressId"
                  label="Default bill-to address ID (optional)"
                  value={credentialsForm.billToAddressId}
                  onInput={(event) =>
                    setCredentialsForm((prev) => ({
                      ...prev,
                      billToAddressId: readFieldValue(event),
                    }))
                  }
                />
                <s-text-field
                  name="shipToAddressId"
                  label="Default ship-to address ID (optional)"
                  value={credentialsForm.shipToAddressId}
                  onInput={(event) =>
                    setCredentialsForm((prev) => ({
                      ...prev,
                      shipToAddressId: readFieldValue(event),
                    }))
                  }
                />
                <div>
                  <label htmlFor="sandbox-select">
                    <s-text>Environment</s-text>
                  </label>
                  <select
                    id="sandbox-select"
                    name="sandbox"
                    value={credentialsForm.sandbox ? "true" : "false"}
                    onChange={(event) =>
                      setCredentialsForm((prev) => ({
                        ...prev,
                        sandbox: readFieldValue(event) === "true",
                      }))
                    }
                  >
                    <option value="true">Sandbox (default)</option>
                    <option value="false">Production</option>
                  </select>
                </div>
                <s-button
                  type="submit"
                  {...(isSaving ? { loading: true } : {})}
                >
                  Save credentials
                </s-button>
              </s-stack>
            </Form>
          </s-section>

          <s-section heading="Connection health">
            <s-paragraph>
              Make sure Shopify can exchange the stored client credentials for
              an access token before wiring the checkout flow.
            </s-paragraph>
            <s-stack direction="inline" gap="base">
              <Form method="post">
                <input type="hidden" name="_action" value="testConnection" />
                <s-button
                  type="submit"
                  {...(isTestingConnection ? { loading: true } : {})}
                  disabled={!credentials}
                >
                  Test OAuth token
                </s-button>
              </Form>
              {credentials?.lastValidationStatus && (
                <s-text>
                  Last validation: {credentials.lastValidationStatus}
                  {credentials.lastValidatedAt &&
                    ` (${new Date(
                      credentials.lastValidatedAt,
                    ).toLocaleString()})`}
                </s-text>
              )}
            </s-stack>
          </s-section>

          <s-section heading="SKU → Ingram mapping sync">
            <s-paragraph>
              SKU → Ingram part number mappings are synced from Supabase for
              fast checkout lookups.{" "}
              <strong>Auto-syncs every Monday at 3:00 AM UTC.</strong>
            </s-paragraph>
            <s-stack direction="block" gap="base">
              <div
                style={{
                  display: "flex",
                  gap: "0.5rem",
                  alignItems: "center",
                  flexWrap: "wrap",
                }}
              >
                <syncFetcher.Form method="post" action="/api/sync-products">
                  <s-button
                    type="submit"
                    {...(isStartingSync ? { loading: true } : {})}
                    disabled={syncIsRunning}
                  >
                    {syncIsRunning
                      ? "Sync in progress..."
                      : "Sync now (manual)"}
                  </s-button>
                </syncFetcher.Form>
                <span style={{ fontSize: "0.875rem", color: "#6b7280" }}>
                  Next auto-sync: Monday 3:00 AM UTC
                </span>
              </div>
              <div
                style={{
                  border: "1px solid var(--color-border, #d2d5d8)",
                  borderRadius: "8px",
                  padding: "0.75rem",
                  background: "var(--color-bg-surface-hover, #f6f6f7)",
                }}
              >
                <div
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                  }}
                >
                  <s-text>
                    Status:{" "}
                    <span
                      style={{
                        color:
                          syncStatus === "success"
                            ? "#059669"
                            : syncStatus === "failed"
                              ? "#dc2626"
                              : syncStatus === "running"
                                ? "#2563eb"
                                : "#6b7280",
                        fontWeight: 500,
                      }}
                    >
                      {syncStatus}
                    </span>
                  </s-text>
                  {syncFinishedAt && (
                    <span style={{ fontSize: "0.75rem", color: "#6b7280" }}>
                      Last sync: {syncFinishedAt.toLocaleString()}
                    </span>
                  )}
                </div>
                {(syncStatus === "running" || syncTotal > 0) && (
                  <div style={{ marginTop: "0.5rem" }}>
                    <div
                      style={{
                        height: "10px",
                        background: "#e5e7eb",
                        borderRadius: "9999px",
                        overflow: "hidden",
                      }}
                    >
                      <div
                        style={{
                          width: `${syncPercent}%`,
                          height: "100%",
                          background:
                            syncStatus === "success" ? "#059669" : "#3b82f6",
                          transition: "width 0.2s ease",
                        }}
                      />
                    </div>
                    <div
                      style={{
                        display: "flex",
                        justifyContent: "space-between",
                        marginTop: "0.35rem",
                        fontSize: "0.875rem",
                      }}
                    >
                      <span>
                        {syncProcessed.toLocaleString()} /{" "}
                        {syncTotal.toLocaleString() || "?"} SKUs mapped
                      </span>
                      <span>{syncPercent}%</span>
                    </div>
                  </div>
                )}
                {currentSyncJob?.error ? (
                  <div
                    style={{
                      marginTop: "0.5rem",
                      padding: "0.5rem",
                      background: "#fef2f2",
                      borderRadius: "4px",
                      color: "#dc2626",
                      fontSize: "0.875rem",
                    }}
                  >
                    Error: {currentSyncJob.error}
                  </div>
                ) : null}
              </div>
            </s-stack>
          </s-section>

          <s-section heading="Checkout carrier service">
            <s-paragraph>
              Shopify calls this carrier service whenever a customer reaches the
              shipping step. Keep it registered so rates can be fetched from
              Ingram automatically.
            </s-paragraph>

            {carrierService ? (
              <s-stack direction="block" gap="base">
                <s-text>
                  Status: {carrierService.active ? "Active" : "Inactive"}
                </s-text>
                <s-text>Callback: {carrierService.callbackUrl}</s-text>
                <Form method="post">
                  <input
                    type="hidden"
                    name="_action"
                    value="deleteCarrierService"
                  />
                  <input
                    type="hidden"
                    name="carrierServiceId"
                    value={carrierService.id}
                  />
                  <s-button
                    tone="critical"
                    {...(isDeletingCarrier ? { loading: true } : {})}
                  >
                    Remove carrier service
                  </s-button>
                </Form>
              </s-stack>
            ) : (
              <Form method="post">
                <input
                  type="hidden"
                  name="_action"
                  value="registerCarrierService"
                />
                <s-button
                  type="submit"
                  {...(isRegisteringCarrier ? { loading: true } : {})}
                  disabled={!credentials}
                >
                  Register carrier service
                </s-button>
              </Form>
            )}
          </s-section>

          <s-section heading="Shipping method configuration">
            <s-paragraph>
              Select which shipping methods to show at checkout. Only carriers
              that are available for ALL items in the cart will be displayed.
              Carriers are automatically discovered when checkout requests are
              made.
            </s-paragraph>

            {carrierConfigs.length > 0 ? (
              <Form method="post">
                <input type="hidden" name="_action" value="saveCarrierConfig" />
                <s-stack direction="block" gap="base">
                  <div
                    style={{
                      display: "grid",
                      gridTemplateColumns:
                        "repeat(auto-fill, minmax(250px, 1fr))",
                      gap: "0.75rem",
                    }}
                  >
                    {carrierConfigs.map((config) => (
                      <label
                        key={config.carrierCode}
                        style={{
                          display: "flex",
                          alignItems: "center",
                          gap: "0.5rem",
                          padding: "0.5rem",
                          border: "1px solid var(--color-border, #d2d5d8)",
                          borderRadius: "var(--border-radius, 4px)",
                          cursor: "pointer",
                        }}
                      >
                        <input
                          type="checkbox"
                          name={`carrier_${config.carrierCode}`}
                          defaultChecked={config.enabled}
                        />
                        <span>
                          <strong>{config.carrierName}</strong>
                          <br />
                          <small
                            style={{
                              color: "var(--color-text-subdued, #6d7175)",
                            }}
                          >
                            {config.carrierCode} •{" "}
                            {config.carrierMode || "Standard"}
                          </small>
                        </span>
                      </label>
                    ))}
                  </div>
                  <s-button
                    type="submit"
                    {...(isSavingCarrierConfig ? { loading: true } : {})}
                  >
                    Save carrier configuration
                  </s-button>
                </s-stack>
              </Form>
            ) : (
              <s-box
                padding="base"
                borderWidth="base"
                borderRadius="base"
                background="subdued"
              >
                <s-text>
                  No carriers discovered yet. Carriers will appear here after a
                  checkout request is made with products that have Ingram
                  mappings. You can also use the freight estimate sandbox below
                  to populate available carriers.
                </s-text>
              </s-box>
            )}
          </s-section>

          <s-section heading="Fallback shipping rate">
            <s-paragraph>
              When Ingram cannot provide shipping rates (missing SKU mapping,
              API errors, etc.), this fallback rate will be shown at checkout
              instead of Shopify's default backup rate. Set a high price to
              prevent accidental orders.
            </s-paragraph>

            <Form method="post">
              <input type="hidden" name="_action" value="saveFallbackRate" />
              <s-stack direction="block" gap="base">
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: "0.75rem",
                    padding: "0.75rem",
                    border: "1px solid var(--color-border, #d2d5d8)",
                    borderRadius: "var(--border-radius, 4px)",
                    background: fallbackForm.enabled ? "#ecfdf5" : "#f9fafb",
                  }}
                >
                  <input
                    type="checkbox"
                    id="fallbackEnabled"
                    name="fallbackEnabled"
                    checked={fallbackForm.enabled}
                    onChange={(e) =>
                      setFallbackForm((prev) => ({
                        ...prev,
                        enabled: e.target.checked,
                      }))
                    }
                    style={{ width: "18px", height: "18px" }}
                  />
                  <label
                    htmlFor="fallbackEnabled"
                    style={{ cursor: "pointer" }}
                  >
                    <strong>Enable fallback rate</strong>
                    <br />
                    <small style={{ color: "#6b7280" }}>
                      When disabled, empty rates are returned and Shopify's
                      backup rate will be used
                    </small>
                  </label>
                </div>

                <div>
                  <label htmlFor="fallbackPrice">
                    <s-text>Fallback price ($)</s-text>
                  </label>
                  <input
                    id="fallbackPrice"
                    name="fallbackPrice"
                    type="number"
                    step="0.01"
                    min="0"
                    value={fallbackForm.price}
                    onChange={(event) =>
                      setFallbackForm((prev) => ({
                        ...prev,
                        price: parseFloat(event.target.value || "999"),
                      }))
                    }
                    style={{
                      width: "100%",
                      padding: "0.5rem",
                      marginTop: "0.25rem",
                    }}
                  />
                </div>

                <s-text-field
                  name="fallbackTitle"
                  label="Rate title (shown at checkout)"
                  value={fallbackForm.title}
                  onInput={(event: any) =>
                    setFallbackForm((prev) => ({
                      ...prev,
                      title:
                        event.target?.value || event.currentTarget?.value || "",
                    }))
                  }
                />

                <div>
                  <label htmlFor="fallbackDescription">
                    <s-text>Description (shown at checkout)</s-text>
                  </label>
                  <textarea
                    id="fallbackDescription"
                    name="fallbackDescription"
                    value={fallbackForm.description}
                    onChange={(event) =>
                      setFallbackForm((prev) => ({
                        ...prev,
                        description: event.currentTarget.value,
                      }))
                    }
                    rows={2}
                    style={{ width: "100%", marginTop: "0.25rem" }}
                  />
                </div>

                <div
                  style={{
                    padding: "0.75rem",
                    border: "1px solid #e5e7eb",
                    borderRadius: "4px",
                    background: "#f9fafb",
                  }}
                >
                  <small style={{ color: "#6b7280" }}>
                    Preview at checkout:
                  </small>
                  <div style={{ marginTop: "0.5rem", fontWeight: 500 }}>
                    {fallbackForm.title} - ${fallbackForm.price.toFixed(2)}
                  </div>
                  <div style={{ fontSize: "0.875rem", color: "#6b7280" }}>
                    {fallbackForm.description}
                  </div>
                </div>

                <s-button
                  type="submit"
                  {...(isSavingFallbackRate ? { loading: true } : {})}
                >
                  Save fallback rate settings
                </s-button>
              </s-stack>
            </Form>
          </s-section>

          <s-section heading="Freight estimate sandbox">
            <s-paragraph>
              Hit the freight endpoint manually to validate headers, addresses,
              and line payloads. Adjust the JSON structure to match the product
              data you plan to send from checkout.
            </s-paragraph>
            <Form method="post">
              <input type="hidden" name="_action" value="testRate" />
              <s-stack direction="block" gap="base">
                <s-text-field
                  name="companyName"
                  label="Ship-to company"
                  required
                />
                <s-text-field
                  name="addressLine1"
                  label="Ship-to address line 1"
                  required
                />
                <s-text-field
                  name="addressLine2"
                  label="Ship-to address line 2"
                />
                <s-text-field name="city" label="City" required />
                <s-text-field
                  name="state"
                  label="State / Province"
                  maxLength={2}
                  required
                />
                <s-text-field name="postalCode" label="Postal code" required />
                <s-text-field
                  name="shipCountryCode"
                  label="Country code"
                  maxLength={2}
                  defaultValue={credentials?.countryCode ?? "US"}
                  required
                />
                <s-text-field
                  name="testBillToAddressId"
                  label="Override bill-to address ID (optional)"
                />
                <s-text-field
                  name="testShipToAddressId"
                  label="Override ship-to address ID (optional)"
                />
                <div>
                  <label htmlFor="lines-json">
                    <s-text>Lines JSON</s-text>
                  </label>
                  <textarea
                    id="lines-json"
                    name="linesJson"
                    value={linesInput}
                    onChange={(event) =>
                      setLinesInput(event.currentTarget.value)
                    }
                    rows={10}
                    style={{ width: "100%" }}
                    required
                  />
                  <small>
                    Include the attributes required by the Ingram Micro Freight
                    Estimate API (for example, weights, SKUs, program codes, or
                    warehouse IDs).
                  </small>
                </div>
                <s-button
                  type="submit"
                  {...(isTestingRate ? { loading: true } : {})}
                  disabled={!credentials}
                >
                  Test freight estimate
                </s-button>
              </s-stack>
            </Form>

            {rateResult && (
              <s-section heading="Latest response">
                <s-text>Correlation ID: {rateResult.correlationId}</s-text>
                <s-box
                  padding="base"
                  borderWidth="base"
                  borderRadius="base"
                  background="subdued"
                >
                  <pre style={{ margin: 0 }}>
                    <code>{JSON.stringify(rateResult.response, null, 2)}</code>
                  </pre>
                </s-box>
              </s-section>
            )}
          </s-section>

          <s-section heading="Rate request history">
            <s-paragraph>
              Recent checkout and cart rate requests. Use this to troubleshoot
              issues with shipping rates not appearing at checkout.
            </s-paragraph>

            {rateLogs.length > 0 ? (
              <div style={{ overflowX: "auto" }}>
                <table
                  style={{
                    width: "100%",
                    borderCollapse: "collapse",
                    fontSize: "0.875rem",
                  }}
                >
                  <thead>
                    <tr
                      style={{
                        borderBottom: "2px solid var(--color-border, #d2d5d8)",
                        textAlign: "left",
                      }}
                    >
                      <th style={{ padding: "0.5rem" }}>Time</th>
                      <th style={{ padding: "0.5rem" }}>Status</th>
                      <th style={{ padding: "0.5rem" }}>Items</th>
                      <th style={{ padding: "0.5rem" }}>SKUs</th>
                      <th style={{ padding: "0.5rem" }}>Ship To</th>
                      <th style={{ padding: "0.5rem" }}>Rates</th>
                      <th style={{ padding: "0.5rem" }}>Duration</th>
                      <th style={{ padding: "0.5rem" }}></th>
                    </tr>
                  </thead>
                  <tbody>
                    {rateLogs.map((log) => {
                      const isExpanded = expandedLogId === log.id;
                      const skus = (() => {
                        try {
                          return JSON.parse(log.cartSkus);
                        } catch {
                          return [log.cartSkus];
                        }
                      })();

                      const statusColors: Record<string, string> = {
                        success: "#22c55e",
                        error: "#ef4444",
                        no_rates: "#f59e0b",
                        no_mapping: "#f97316",
                        api_error: "#dc2626",
                      };

                      return (
                        <>
                          <tr
                            key={log.id}
                            style={{
                              borderBottom:
                                "1px solid var(--color-border, #d2d5d8)",
                              cursor: "pointer",
                            }}
                            onClick={() =>
                              setExpandedLogId(isExpanded ? null : log.id)
                            }
                          >
                            <td style={{ padding: "0.5rem" }}>
                              {new Date(log.createdAt).toLocaleString()}
                            </td>
                            <td style={{ padding: "0.5rem" }}>
                              <span
                                style={{
                                  display: "inline-block",
                                  padding: "0.125rem 0.5rem",
                                  borderRadius: "9999px",
                                  fontSize: "0.75rem",
                                  fontWeight: 500,
                                  backgroundColor:
                                    statusColors[log.status] || "#6b7280",
                                  color: "white",
                                }}
                              >
                                {log.status}
                              </span>
                            </td>
                            <td style={{ padding: "0.5rem" }}>
                              {log.cartItemCount}
                            </td>
                            <td
                              style={{
                                padding: "0.5rem",
                                maxWidth: "150px",
                                overflow: "hidden",
                                textOverflow: "ellipsis",
                                whiteSpace: "nowrap",
                              }}
                              title={skus.join(", ")}
                            >
                              {skus.join(", ")}
                            </td>
                            <td style={{ padding: "0.5rem" }}>
                              {log.shipToCity && log.shipToState
                                ? `${log.shipToCity}, ${log.shipToState} ${log.shipToZip || ""}`
                                : "-"}
                            </td>
                            <td style={{ padding: "0.5rem" }}>
                              {log.ratesReturned ?? "-"}
                              {log.distributionCount != null && (
                                <small
                                  style={{
                                    color: "var(--color-text-subdued, #6d7175)",
                                  }}
                                >
                                  {" "}
                                  ({log.distributionCount} dist)
                                </small>
                              )}
                            </td>
                            <td style={{ padding: "0.5rem" }}>
                              {log.durationMs ? `${log.durationMs}ms` : "-"}
                            </td>
                            <td style={{ padding: "0.5rem" }}>
                              <span
                                style={{
                                  transform: isExpanded
                                    ? "rotate(180deg)"
                                    : "rotate(0deg)",
                                  display: "inline-block",
                                  transition: "transform 0.2s",
                                }}
                              >
                                ▼
                              </span>
                            </td>
                          </tr>
                          {isExpanded && (
                            <tr key={`${log.id}-details`}>
                              <td
                                colSpan={8}
                                style={{
                                  padding: "1rem",
                                  background:
                                    "var(--color-bg-surface-hover, #f6f6f7)",
                                }}
                              >
                                <div
                                  style={{
                                    display: "grid",
                                    gridTemplateColumns: "repeat(2, 1fr)",
                                    gap: "1rem",
                                  }}
                                >
                                  <div>
                                    <strong>Correlation ID:</strong>
                                    <br />
                                    <code
                                      style={{
                                        fontSize: "0.75rem",
                                        wordBreak: "break-all",
                                      }}
                                    >
                                      {log.correlationId}
                                    </code>
                                  </div>
                                  <div>
                                    <strong>Request Type:</strong>
                                    <br />
                                    {log.requestType}
                                  </div>
                                  {log.ingramPartNums && (
                                    <div>
                                      <strong>Ingram Part Numbers:</strong>
                                      <br />
                                      <code style={{ fontSize: "0.75rem" }}>
                                        {log.ingramPartNums}
                                      </code>
                                    </div>
                                  )}
                                  {log.errorMessage && (
                                    <div style={{ gridColumn: "1 / -1" }}>
                                      <strong style={{ color: "#ef4444" }}>
                                        Error:
                                      </strong>
                                      <br />
                                      {log.errorMessage}
                                    </div>
                                  )}
                                  {log.ratesData && (
                                    <div style={{ gridColumn: "1 / -1" }}>
                                      <strong>Rates Data:</strong>
                                      <pre
                                        style={{
                                          margin: "0.5rem 0 0 0",
                                          padding: "0.5rem",
                                          background: "#1f2937",
                                          color: "#e5e7eb",
                                          borderRadius: "4px",
                                          fontSize: "0.75rem",
                                          overflow: "auto",
                                          maxHeight: "200px",
                                        }}
                                      >
                                        {(() => {
                                          try {
                                            return JSON.stringify(
                                              JSON.parse(log.ratesData),
                                              null,
                                              2,
                                            );
                                          } catch {
                                            return log.ratesData;
                                          }
                                        })()}
                                      </pre>
                                    </div>
                                  )}
                                  {log.errorDetails && (
                                    <div style={{ gridColumn: "1 / -1" }}>
                                      <strong>Error Details:</strong>
                                      <pre
                                        style={{
                                          margin: "0.5rem 0 0 0",
                                          padding: "0.5rem",
                                          background: "#1f2937",
                                          color: "#e5e7eb",
                                          borderRadius: "4px",
                                          fontSize: "0.75rem",
                                          overflow: "auto",
                                          maxHeight: "200px",
                                        }}
                                      >
                                        {(() => {
                                          try {
                                            return JSON.stringify(
                                              JSON.parse(log.errorDetails),
                                              null,
                                              2,
                                            );
                                          } catch {
                                            return log.errorDetails;
                                          }
                                        })()}
                                      </pre>
                                    </div>
                                  )}
                                </div>
                              </td>
                            </tr>
                          )}
                        </>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            ) : (
              <s-box
                padding="base"
                borderWidth="base"
                borderRadius="base"
                background="subdued"
              >
                <s-text>
                  No rate requests logged yet. Logs will appear here after
                  checkout requests are made with products that have Ingram
                  mappings.
                </s-text>
              </s-box>
            )}
          </s-section>

          <s-section heading="References">
            <s-unordered-list>
              <s-list-item>
                <s-link
                  href="https://developer.ingrammicro.com/reseller/apidocumentation/United_States#tag/Freight-Estimate"
                  target="_blank"
                >
                  Ingram Micro Freight Estimate docs
                </s-link>
              </s-list-item>
              <s-list-item>
                <s-link
                  href="https://shopify.dev/docs/apps/build/checkout/delivery-shipping/delivery-methods/ux-for-delivery-methods"
                  target="_blank"
                >
                  Shopify checkout delivery UX guidelines
                </s-link>
              </s-list-item>
            </s-unordered-list>
          </s-section>
        </s-stack>
      ) : (
        <s-stack direction="block" gap="base">
          <s-section heading="TD_Synnex Api Credential">
            <Form method="post">
              <input
                type="hidden"
                name="_action"
                value="td_SynnexCredentials"
              />
              <s-stack direction="block" gap="base">
                <s-text-field
                  name="userName"
                  label="USER ID"
                  value={tdCredentialsForm.userName}
                  onInput={(event) =>
                    setTdCredentialsForm((prev) => ({
                      ...prev,
                      userName: readFieldValue(event),
                    }))
                  }
                  required
                  error={tdfieldErrors?.userName}
                />
                <s-text-field
                  name="password"
                  label="PASSWORD"
                  value={tdCredentialsForm.password}
                  onInput={(event) =>
                    setTdCredentialsForm((prev) => ({
                      ...prev,
                      password: readFieldValue(event),
                    }))
                  }
                  required
                  error={tdfieldErrors?.password}
                />
                <s-text-field
                  name="customerNumber"
                  label="Customer Number"
                  value={tdCredentialsForm.customerNumber}
                  onInput={(event) =>
                    setTdCredentialsForm((prev) => ({
                      ...prev,
                      customerNumber: readFieldValue(event),
                    }))
                  }
                  required
                  error={tdfieldErrors?.customerNumber}
                />
                <s-text-field
                  name="customerName"
                  label="Customer Name(optional)"
                  value={tdCredentialsForm.customerName}
                  onInput={(event) =>
                    setTdCredentialsForm((prev) => ({
                      ...prev,
                      customerName: readFieldValue(event),
                    }))
                  }
                  error={tdfieldErrors?.customerName}
                />
                {/* <s-text-field
                  name="RequestDateTime"
                  label="Request DateTime (ISO)"
                  placeholder="2026-01-27T14:37:11"
                  onInput={(event) =>
                    setTdCredentialsForm((prev) => ({
                      ...prev,
                      customerName: readFieldValue(event),
                    }))
                  }
                /> */}

                <div>
                  <label htmlFor="sandbox-select">
                    <s-text>Environment</s-text>
                  </label>
                  <select
                    id="sandbox-select"
                    name="sandbox"
                    value={tdCredentialsForm.sandbox ? "true" : "false"}
                    onChange={(event) =>
                      setTdCredentialsForm((prev) => ({
                        ...prev,
                        sandbox: readFieldValue(event) === "true",
                      }))
                    }
                  >
                    <option value="true">Sandbox (default)</option>
                    <option value="false">Production</option>
                  </select>
                </div>
                <s-button
                  type="submit"
                  {...(tdisSaving ? { loading: true } : {})}
                >
                  Save credentials
                </s-button>
              </s-stack>
            </Form>
          </s-section>
          <s-section heading="Freight estimate sandbox">
            <s-paragraph>
              Hit the freight endpoint manually to validate headers, addresses,
              and line payloads. Adjust the JSON structure to match the product
              data you plan to send from checkout.
            </s-paragraph>
            <Form method="post">
              <input type="hidden" name="_action" value="td_SynnextestRate" />
              <s-stack direction="block" gap="base">
                <s-text-field
                  name="shipFromWarehouse"
                  label="Ship From Warehouse"
                  required
                />
                <s-text-field
                  name="addressName1"
                  label="ShipTo - AddressName1"
                  required
                />
                <s-text-field
                  name="addressName2"
                  label="ShipTo - AddressName2(optional)"
                />
                <s-text-field
                  name="addressLine1"
                  label="ShipTo - AddressLine1"
                  required
                />
                <s-text-field name="city" label="ShipTo - City" required />
                <s-text-field
                  name="state"
                  label="ShipTo - State"
                  maxLength={2}
                  required
                />
                <s-text-field
                  name="zipCode"
                  label="ShipTo - ZipCode"
                  required
                />
                <s-text-field
                  name="country"
                  label="ShipTo - Country"
                  maxLength={2}
                  required
                />

                <s-text-field
                  name="shipMethodCode"
                  label="Ship Method Code(optional)"
                />
                <s-text-field
                  name="serviceLevel"
                  label="Service Level(optional)"
                />

                <s-paragraph>
                  Item (single-line fields). Add multiple items via CSV in the
                  Items JSON field if needed.
                </s-paragraph>
                <s-text-field name="itemSKU" label="Item - SKU" required />
                <s-text-field
                  name="itemMfgPartNumber"
                  label="Item - MfgPartNumber"
                  required
                />
                <s-text-field
                  name="itemDescription"
                  label="Item - Description(optional)"
                />
                <s-text-field
                  name="itemQuantity"
                  label="Item - Quantity"
                  required
                />
                <s-button
                  type="submit"
                  {...(isTdTestingRate ? { loading: true } : {})}
                  disabled={!tdcredentials}
                >
                  Test freight estimate
                </s-button>
              </s-stack>
            </Form>
            {td_rateResult && (
              <s-section heading="Latest response">
                <s-box
                  padding="base"
                  borderWidth="base"
                  borderRadius="base"
                  background="subdued"
                >
                  <pre
                    style={{
                      margin: 0,
                      maxHeight: "300px",
                      overflow: "auto",
                      whiteSpace: "pre-wrap",
                      fontFamily: "monospace",
                    }}
                  >
                    <code>{formatXml(td_rateResult.response, null, 2)}</code>
                  </pre>
                </s-box>
              </s-section>
            )}
          </s-section>
        </s-stack>
      )}
    </s-page>
  );
}

export function ErrorBoundary() {
  return boundary.error(useRouteError());
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
