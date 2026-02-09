-- Create Session table for Shopify session storage
CREATE TABLE IF NOT EXISTS "Session" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "isOnline" BOOLEAN NOT NULL DEFAULT false,
    "scope" TEXT,
    "expires" TIMESTAMP(3),
    "accessToken" TEXT NOT NULL,
    "userId" BIGINT,
    "firstName" TEXT,
    "lastName" TEXT,
    "email" TEXT,
    "accountOwner" BOOLEAN NOT NULL DEFAULT false,
    "locale" TEXT,
    "collaborator" BOOLEAN DEFAULT false,
    "emailVerified" BOOLEAN DEFAULT false,
    CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);

-- Create IngramCredential table for Ingram Micro API credentials
CREATE TABLE IF NOT EXISTS "IngramCredential" (
    "shopDomain" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "clientSecret" TEXT NOT NULL,
    "customerNumber" TEXT NOT NULL,
    "countryCode" TEXT NOT NULL DEFAULT 'US',
    "contactEmail" TEXT,
    "senderId" TEXT,
    "billToAddressId" TEXT,
    "shipToAddressId" TEXT,
    "sandbox" BOOLEAN NOT NULL DEFAULT true,
    "accessToken" TEXT,
    "accessTokenExpiresAt" TIMESTAMP(3),
    "lastValidatedAt" TIMESTAMP(3),
    "lastValidationStatus" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "IngramCredential_pkey" PRIMARY KEY ("shopDomain")
);

CREATE TABLE IF NOT EXISTS "Td_SynnexCredential" (
    "shopDomain" TEXT NOT NULL,
    "userName" TEXT NOT NULL,
    "password" TEXT NOT NULL,
    "customerNumber" TEXT NOT NULL,
    "customerName" TEXT,
    "sandbox" BOOLEAN NOT NULL DEFAULT true,
    "lastValidatedAt" TIMESTAMP(3),
    "lastValidationStatus" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "Td_SynnexCredential_pkey" PRIMARY KEY ("shopDomain")
);
