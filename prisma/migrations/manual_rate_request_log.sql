-- Create RateRequestLog table for tracking checkout rate requests
-- Run this in Supabase SQL Editor if Prisma migrations don't work

CREATE TABLE IF NOT EXISTS "RateRequestLog" (
    "id" TEXT NOT NULL,
    "shopDomain" TEXT NOT NULL,
    "correlationId" TEXT NOT NULL,
    "requestType" TEXT NOT NULL,
    "cartItemCount" INTEGER NOT NULL,
    "cartSkus" TEXT NOT NULL,
    "ingramPartNums" TEXT,
    "shipToCity" TEXT,
    "shipToState" TEXT,
    "shipToZip" TEXT,
    "shipToCountry" TEXT,
    "status" TEXT NOT NULL,
    "distributionCount" INTEGER,
    "ratesReturned" INTEGER,
    "ratesData" TEXT,
    "errorMessage" TEXT,
    "errorDetails" TEXT,
    "ingramRawResponse" TEXT,
    "durationMs" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RateRequestLog_pkey" PRIMARY KEY ("id")
);

-- Create indexes for efficient querying
CREATE UNIQUE INDEX IF NOT EXISTS "RateRequestLog_correlationId_key" ON "RateRequestLog"("correlationId");
CREATE INDEX IF NOT EXISTS "RateRequestLog_shopDomain_idx" ON "RateRequestLog"("shopDomain");
CREATE INDEX IF NOT EXISTS "RateRequestLog_createdAt_idx" ON "RateRequestLog"("createdAt");
CREATE INDEX IF NOT EXISTS "RateRequestLog_status_idx" ON "RateRequestLog"("status");
