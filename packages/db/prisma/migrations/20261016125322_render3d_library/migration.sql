-- CreateTable
CREATE TABLE "Render3DAsset" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT,
    "assetType" TEXT NOT NULL,
    "productId" TEXT,
    "brandId" TEXT,
    "category" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "license" TEXT NOT NULL,
    "fidelity" TEXT NOT NULL,
    "isDemoOnly" BOOLEAN NOT NULL,
    "isProductVerified" BOOLEAN NOT NULL,
    "structureVerified" BOOLEAN NOT NULL DEFAULT false,
    "engine" TEXT NOT NULL,
    "engineVersion" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "recipeHash" TEXT,
    "visualKey" TEXT,
    "approvalStatus" TEXT NOT NULL DEFAULT 'PENDING',
    "record" JSONB NOT NULL,
    "assetRowId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Render3DAsset_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RenderStation" (
    "id" TEXT NOT NULL,
    "lastSeenAt" TIMESTAMP(3) NOT NULL,
    "capabilities" JSONB NOT NULL,
    "activeJobs" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RenderStation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Render3DAsset_recipeHash_idx" ON "Render3DAsset"("recipeHash");

-- CreateIndex
CREATE INDEX "Render3DAsset_visualKey_idx" ON "Render3DAsset"("visualKey");

-- CreateIndex
CREATE INDEX "Render3DAsset_productId_assetType_idx" ON "Render3DAsset"("productId", "assetType");

-- CreateIndex
CREATE INDEX "Render3DAsset_approvalStatus_idx" ON "Render3DAsset"("approvalStatus");
