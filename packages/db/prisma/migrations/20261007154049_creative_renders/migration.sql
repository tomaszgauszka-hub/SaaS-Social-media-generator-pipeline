-- CreateEnum
CREATE TYPE "CreativeRenderStatus" AS ENUM ('RENDERED', 'FAILED');

-- CreateEnum
CREATE TYPE "QualityKind" AS ENUM ('TECHNICAL', 'CREATIVE', 'FACTUAL', 'COMPLIANCE', 'LOCALIZATION');

-- CreateTable
CREATE TABLE "CreativeRender" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "projectId" TEXT,
    "storyboardId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "structure" TEXT NOT NULL,
    "styleKit" TEXT NOT NULL,
    "locale" TEXT NOT NULL DEFAULT 'en-US',
    "benchmark" BOOLEAN NOT NULL DEFAULT false,
    "demoOnly" BOOLEAN NOT NULL DEFAULT false,
    "placeholderMedia" BOOLEAN NOT NULL DEFAULT false,
    "status" "CreativeRenderStatus" NOT NULL DEFAULT 'RENDERED',
    "durationMs" INTEGER NOT NULL,
    "beatCount" INTEGER NOT NULL,
    "width" INTEGER NOT NULL,
    "height" INTEGER NOT NULL,
    "fps" INTEGER NOT NULL,
    "storyboardHash" TEXT NOT NULL,
    "planHash" TEXT NOT NULL,
    "videoAssetId" TEXT,
    "posterAssetId" TEXT,
    "renderMs" INTEGER NOT NULL,
    "audioMs" INTEGER NOT NULL,
    "finishMs" INTEGER NOT NULL,
    "qaMs" INTEGER NOT NULL,
    "renderFps" DOUBLE PRECISION NOT NULL,
    "aiTokens" INTEGER NOT NULL DEFAULT 0,
    "aiCostUsd" DECIMAL(12,6) NOT NULL DEFAULT 0,
    "externalCostUsd" DECIMAL(12,6) NOT NULL DEFAULT 0,
    "rendererVersion" TEXT NOT NULL,
    "directorVersion" TEXT NOT NULL,
    "technicalStatus" TEXT NOT NULL,
    "technicalReport" JSONB NOT NULL,
    "storyboard" JSONB NOT NULL,
    "productionReady" BOOLEAN NOT NULL DEFAULT false,
    "verdictLabel" TEXT NOT NULL,
    "verdict" JSONB NOT NULL,
    "errorMessage" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CreativeRender_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CreativeQualityScore" (
    "id" TEXT NOT NULL,
    "renderId" TEXT NOT NULL,
    "kind" "QualityKind" NOT NULL,
    "score" INTEGER NOT NULL,
    "passed" BOOLEAN NOT NULL,
    "required" TEXT NOT NULL,
    "report" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CreativeQualityScore_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CreativeRender_workspaceId_benchmark_createdAt_idx" ON "CreativeRender"("workspaceId", "benchmark", "createdAt");

-- CreateIndex
CREATE INDEX "CreativeRender_storyboardId_createdAt_idx" ON "CreativeRender"("storyboardId", "createdAt");

-- CreateIndex
CREATE INDEX "CreativeRender_projectId_idx" ON "CreativeRender"("projectId");

-- CreateIndex
CREATE UNIQUE INDEX "CreativeQualityScore_renderId_kind_key" ON "CreativeQualityScore"("renderId", "kind");

-- AddForeignKey
ALTER TABLE "CreativeRender" ADD CONSTRAINT "CreativeRender_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CreativeRender" ADD CONSTRAINT "CreativeRender_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "ContentProject"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CreativeRender" ADD CONSTRAINT "CreativeRender_videoAssetId_fkey" FOREIGN KEY ("videoAssetId") REFERENCES "Asset"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CreativeRender" ADD CONSTRAINT "CreativeRender_posterAssetId_fkey" FOREIGN KEY ("posterAssetId") REFERENCES "Asset"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CreativeQualityScore" ADD CONSTRAINT "CreativeQualityScore_renderId_fkey" FOREIGN KEY ("renderId") REFERENCES "CreativeRender"("id") ON DELETE CASCADE ON UPDATE CASCADE;
