/**
 * Cron endpoint for automatic product sync
 *
 * This endpoint is called by Vercel Cron every Monday at 3:00 AM UTC
 * It syncs all product mappings from Supabase to the local database
 * for all shops that have Ingram credentials configured.
 */

import type { LoaderFunctionArgs } from "react-router";
import prisma from "../db.server";
import { getSupabaseClient } from "../services/supabase.server";

// Verify the request is from Vercel Cron
function verifyCronRequest(request: Request): boolean {
  const authHeader = request.headers.get("authorization");
  const cronSecret = process.env.CRON_SECRET;

  // If CRON_SECRET is set, verify it
  if (cronSecret) {
    return authHeader === `Bearer ${cronSecret}`;
  }

  // Also allow Vercel's internal cron requests
  const isVercelCron = request.headers.get("x-vercel-cron") === "true";
  return isVercelCron;
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  // Verify this is a legitimate cron request
  if (!verifyCronRequest(request)) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  console.log("[Cron] Starting weekly product sync...");

  try {
    // Get all shops with Ingram credentials
    const shops = await prisma.ingramCredential.findMany({
      select: { shopDomain: true },
    });

    if (shops.length === 0) {
      console.log("[Cron] No shops configured, skipping sync");
      return Response.json({ success: true, message: "No shops to sync" });
    }

    console.log(`[Cron] Found ${shops.length} shops to sync`);

    // Fetch all mappings from Supabase with pagination (default limit is 1000)
    const supabase = getSupabaseClient();
    const PAGE_SIZE = 5000;
    const allRows: { price_vendor_part: string; price_part_nbr: string }[] = [];
    let offset = 0;

    while (true) {
      const { data, error } = await supabase
        .from("final_product_table_us")
        .select("price_vendor_part,price_part_nbr")
        .range(offset, offset + PAGE_SIZE - 1);

      if (error) {
        console.error("[Cron] Failed to fetch from Supabase:", error);
        return Response.json(
          { success: false, error: "Failed to fetch from Supabase" },
          { status: 500 },
        );
      }

      const validRows = (data ?? []).filter(
        (row): row is { price_vendor_part: string; price_part_nbr: string } =>
          Boolean(row.price_vendor_part) && Boolean(row.price_part_nbr),
      );

      if (validRows.length === 0) {
        break;
      }

      allRows.push(...validRows);

      if (validRows.length < PAGE_SIZE) {
        break;
      }

      offset += PAGE_SIZE;
    }

    const rows = allRows;
    console.log(`[Cron] Fetched ${rows.length} mappings from Supabase`);

    // Dedupe by SKU (keep first occurrence)
    const uniqueMappings = new Map<string, string>();
    for (const row of rows) {
      if (!uniqueMappings.has(row.price_vendor_part)) {
        uniqueMappings.set(row.price_vendor_part, row.price_part_nbr);
      }
    }

    console.log(
      `[Cron] ${uniqueMappings.size} unique SKUs after deduplication`,
    );

    // Sync for each shop
    const results: { shop: string; synced: number; error?: string }[] = [];

    for (const { shopDomain } of shops) {
      try {
        // Delete existing mappings for this shop
        await prisma.productMapping.deleteMany({
          where: { shopDomain },
        });

        // Insert new mappings in batches
        const mappingsToInsert = Array.from(uniqueMappings.entries()).map(
          ([sku, ingramPartNumber]) => ({
            shopDomain,
            sku,
            ingramPartNumber,
          }),
        );

        // Insert in batches of 1000
        const BATCH_SIZE = 1000;
        let inserted = 0;

        for (let i = 0; i < mappingsToInsert.length; i += BATCH_SIZE) {
          const batch = mappingsToInsert.slice(i, i + BATCH_SIZE);
          await prisma.productMapping.createMany({
            data: batch,
            skipDuplicates: true,
          });
          inserted += batch.length;
        }

        // Update or create sync job record
        await prisma.productSyncJob.create({
          data: {
            shopDomain,
            status: "success",
            processed: inserted,
            total: inserted,
            finishedAt: new Date(),
          },
        });

        results.push({ shop: shopDomain, synced: inserted });
        console.log(`[Cron] Synced ${inserted} mappings for ${shopDomain}`);
      } catch (shopError) {
        const errorMessage =
          shopError instanceof Error ? shopError.message : "Unknown error";
        results.push({ shop: shopDomain, synced: 0, error: errorMessage });
        console.error(`[Cron] Failed to sync ${shopDomain}:`, shopError);
      }
    }

    console.log("[Cron] Weekly product sync completed");

    return Response.json({
      success: true,
      timestamp: new Date().toISOString(),
      shops: results,
    });
  } catch (error) {
    console.error("[Cron] Product sync failed:", error);
    return Response.json(
      {
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500 },
    );
  }
};
