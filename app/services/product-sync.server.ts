import prisma from "../db.server";
import { getSupabaseClient } from "./supabase.server";

export type ProductSyncJobStatus = "queued" | "running" | "success" | "failed";

// Mark jobs stuck for more than 10 minutes as failed
const STALE_JOB_THRESHOLD_MS = 10 * 60 * 1000;

export async function getLatestProductSyncJob(shopDomain: string) {
  try {
    // First, mark any stale "running" jobs as failed
    await markStaleJobsAsFailed(shopDomain);

    return await prisma.productSyncJob.findFirst({
      where: { shopDomain },
      orderBy: { createdAt: "desc" },
    });
  } catch (err) {
    console.warn("ProductSyncJob table not available:", err);
    return null;
  }
}

async function markStaleJobsAsFailed(shopDomain: string) {
  const staleThreshold = new Date(Date.now() - STALE_JOB_THRESHOLD_MS);

  await prisma.productSyncJob.updateMany({
    where: {
      shopDomain,
      status: "running",
      createdAt: { lt: staleThreshold },
    },
    data: {
      status: "failed",
      error: "Sync timed out - job was running too long",
      finishedAt: new Date(),
    },
  });
}

export async function startProductSync(shopDomain: string) {
  try {
    // Mark any stale running jobs as failed first
    await markStaleJobsAsFailed(shopDomain);

    // Check for recent running job (not stale)
    const existing = await prisma.productSyncJob.findFirst({
      where: {
        shopDomain,
        status: "running",
      },
      orderBy: { createdAt: "desc" },
    });

    if (existing) {
      return existing;
    }

    // Create the job
    const job = await prisma.productSyncJob.create({
      data: {
        shopDomain,
        status: "running",
        processed: 0,
        total: 0,
      },
    });

    // Run sync synchronously (fast bulk insert completes in seconds)
    await runProductSyncFast(job.id, shopDomain);

    // Return the updated job
    return await prisma.productSyncJob.findUnique({
      where: { id: job.id },
    });
  } catch (err) {
    console.error("Failed to start product sync:", err);
    throw new Error(
      err instanceof Error ? err.message : "Product sync failed"
    );
  }
}

/**
 * Fast sync using bulk operations instead of individual upserts.
 * This completes in seconds instead of timing out.
 */
async function runProductSyncFast(jobId: string, shopDomain: string) {
  try {
    console.log(`[Product Sync] Starting fast sync for ${shopDomain}`);

    // Fetch all mappings from Supabase with pagination (default limit is 1000)
    const supabase = getSupabaseClient();
    const PAGE_SIZE = 5000;
    const allRows: { price_vendor_part: string; price_part_nbr: string }[] = [];
    let offset = 0;
    let totalCount = 0;

    // Paginate through all rows
    while (true) {
      const { data, error, count } = await supabase
        .from("final_product_table_us")
        .select("price_vendor_part,price_part_nbr", { count: "exact" })
        .range(offset, offset + PAGE_SIZE - 1);

      if (error) {
        throw new Error(`Supabase error: ${error.message}`);
      }

      if (count && count > 0) {
        totalCount = count;
      }

      const validRows = (data ?? []).filter(
        (row): row is { price_vendor_part: string; price_part_nbr: string } =>
          Boolean(row.price_vendor_part) && Boolean(row.price_part_nbr)
      );

      if (validRows.length === 0) {
        break;
      }

      allRows.push(...validRows);
      console.log(`[Product Sync] Fetched ${allRows.length}/${totalCount} rows from Supabase`);

      if (validRows.length < PAGE_SIZE) {
        break;
      }

      offset += PAGE_SIZE;
    }

    const rows = allRows;
    console.log(`[Product Sync] Total fetched: ${rows.length} rows from Supabase`);

    // Dedupe by SKU (keep first occurrence)
    const uniqueMappings = new Map<string, string>();
    for (const row of rows) {
      if (!uniqueMappings.has(row.price_vendor_part)) {
        uniqueMappings.set(row.price_vendor_part, row.price_part_nbr);
      }
    }

    const total = uniqueMappings.size;
    console.log(`[Product Sync] ${total} unique SKUs after deduplication`);

    // Update job with total count
    await prisma.productSyncJob.update({
      where: { id: jobId },
      data: { total },
    });

    // Delete existing mappings for this shop
    await prisma.productMapping.deleteMany({
      where: { shopDomain },
    });

    // Bulk insert in batches
    const BATCH_SIZE = 1000;
    const mappingsArray = Array.from(uniqueMappings.entries());
    let processed = 0;

    for (let i = 0; i < mappingsArray.length; i += BATCH_SIZE) {
      const batch = mappingsArray.slice(i, i + BATCH_SIZE).map(([sku, ingramPartNumber]) => ({
        shopDomain,
        sku,
        ingramPartNumber,
      }));

      await prisma.productMapping.createMany({
        data: batch,
        skipDuplicates: true,
      });

      processed += batch.length;

      // Update progress
      await prisma.productSyncJob.update({
        where: { id: jobId },
        data: { processed },
      });
    }

    // Mark as success
    await prisma.productSyncJob.update({
      where: { id: jobId },
      data: {
        status: "success",
        processed,
        total,
        finishedAt: new Date(),
      },
    });

    console.log(`[Product Sync] Completed: ${processed} mappings synced for ${shopDomain}`);
  } catch (error) {
    console.error("[Product Sync] Failed:", error);
    const message =
      error instanceof Error
        ? error.message
        : typeof error === "string"
          ? error
          : "Unknown error";

    await prisma.productSyncJob.update({
      where: { id: jobId },
      data: {
        status: "failed",
        error: message,
        finishedAt: new Date(),
      },
    });

    throw error;
  }
}
