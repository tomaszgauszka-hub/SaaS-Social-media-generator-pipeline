-- CreateEnum
CREATE TYPE "ReelJobStatus" AS ENUM ('QUEUED', 'RUNNING', 'DONE', 'FAILED', 'BUDGET_BLOCKED');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "UsageOperation" ADD VALUE 'MUSIC_GENERATION';
ALTER TYPE "UsageOperation" ADD VALUE 'TRANSCRIPTION';
ALTER TYPE "UsageOperation" ADD VALUE 'EMBEDDING';
ALTER TYPE "UsageOperation" ADD VALUE 'SFX_GENERATION';
ALTER TYPE "UsageOperation" ADD VALUE 'VISUAL_QA';
ALTER TYPE "UsageOperation" ADD VALUE 'RENDER_3D';

-- CreateTable
CREATE TABLE "ReelJobRecord" (
    "id" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "workspaceId" TEXT,
    "brandKey" TEXT NOT NULL,
    "productKey" TEXT NOT NULL,
    "platform" TEXT NOT NULL,
    "tier" TEXT NOT NULL,
    "status" "ReelJobStatus" NOT NULL DEFAULT 'QUEUED',
    "maxApiCostUsd" DECIMAL(12,6) NOT NULL DEFAULT 0,
    "totalApiCostUsd" DECIMAL(12,6) NOT NULL DEFAULT 0,
    "request" JSONB NOT NULL,
    "error" TEXT,
    "timings" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "ReelJobRecord_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReelVariant" (
    "id" TEXT NOT NULL,
    "jobRecordId" TEXT NOT NULL,
    "variantKey" TEXT NOT NULL,
    "locale" TEXT NOT NULL,
    "market" TEXT NOT NULL,
    "platform" TEXT NOT NULL,
    "tier" TEXT NOT NULL,
    "hookStrategy" TEXT NOT NULL,
    "directorProvider" TEXT NOT NULL,
    "directorModel" TEXT NOT NULL,
    "musicProvider" TEXT NOT NULL,
    "voiceProvider" TEXT NOT NULL,
    "sfxProvider" TEXT NOT NULL,
    "blenderProfile" TEXT NOT NULL,
    "durationMs" INTEGER NOT NULL,
    "totalApiCostUsd" DECIMAL(12,6) NOT NULL DEFAULT 0,
    "qaScore" INTEGER NOT NULL,
    "qaPassed" BOOLEAN NOT NULL,
    "visualHash" TEXT NOT NULL,
    "masterReused" BOOLEAN NOT NULL DEFAULT false,
    "videoPath" TEXT NOT NULL,
    "posterPath" TEXT NOT NULL,
    "videoAssetId" TEXT,
    "posterAssetId" TEXT,
    "contentVariantId" TEXT,
    "plan" JSONB NOT NULL,
    "manifest" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ReelVariant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReelOutcomeSnapshot" (
    "id" TEXT NOT NULL,
    "variantId" TEXT NOT NULL,
    "collectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "views" INTEGER,
    "watchTimeMs" BIGINT,
    "completionRate" DOUBLE PRECISION,
    "ctr" DOUBLE PRECISION,
    "conversions" INTEGER,
    "sales" INTEGER,
    "revenueUsd" DECIMAL(12,2),
    "likes" INTEGER,
    "comments" INTEGER,
    "shares" INTEGER,
    "raw" JSONB,

    CONSTRAINT "ReelOutcomeSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProductProfileCache" (
    "id" TEXT NOT NULL,
    "productKey" TEXT NOT NULL,
    "sourceHash" TEXT NOT NULL,
    "analyzerVersion" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "profile" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProductProfileCache_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ReelJobRecord_jobId_key" ON "ReelJobRecord"("jobId");

-- CreateIndex
CREATE INDEX "ReelJobRecord_productKey_idx" ON "ReelJobRecord"("productKey");

-- CreateIndex
CREATE INDEX "ReelJobRecord_status_createdAt_idx" ON "ReelJobRecord"("status", "createdAt");

-- CreateIndex
CREATE INDEX "ReelVariant_hookStrategy_idx" ON "ReelVariant"("hookStrategy");

-- CreateIndex
CREATE INDEX "ReelVariant_visualHash_idx" ON "ReelVariant"("visualHash");

-- CreateIndex
CREATE UNIQUE INDEX "ReelVariant_jobRecordId_variantKey_locale_platform_key" ON "ReelVariant"("jobRecordId", "variantKey", "locale", "platform");

-- CreateIndex
CREATE INDEX "ReelOutcomeSnapshot_variantId_collectedAt_idx" ON "ReelOutcomeSnapshot"("variantId", "collectedAt");

-- CreateIndex
CREATE UNIQUE INDEX "ProductProfileCache_productKey_sourceHash_analyzerVersion_key" ON "ProductProfileCache"("productKey", "sourceHash", "analyzerVersion");

-- AddForeignKey
ALTER TABLE "ReelJobRecord" ADD CONSTRAINT "ReelJobRecord_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReelVariant" ADD CONSTRAINT "ReelVariant_jobRecordId_fkey" FOREIGN KEY ("jobRecordId") REFERENCES "ReelJobRecord"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReelOutcomeSnapshot" ADD CONSTRAINT "ReelOutcomeSnapshot_variantId_fkey" FOREIGN KEY ("variantId") REFERENCES "ReelVariant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
