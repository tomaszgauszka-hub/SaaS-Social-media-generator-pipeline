-- CreateEnum
CREATE TYPE "WorkspaceRole" AS ENUM ('OWNER', 'ADMIN', 'EDITOR', 'VIEWER');

-- CreateEnum
CREATE TYPE "BrandStatus" AS ENUM ('ACTIVE', 'PAUSED', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "Platform" AS ENUM ('INSTAGRAM', 'FACEBOOK', 'TIKTOK', 'YOUTUBE', 'PINTEREST', 'X', 'LINKEDIN', 'BLOG', 'NEWSLETTER');

-- CreateEnum
CREATE TYPE "SocialAccountStatus" AS ENUM ('MOCK', 'CONNECTED', 'NEEDS_REAUTH', 'DISCONNECTED');

-- CreateEnum
CREATE TYPE "MonetizationModel" AS ENUM ('AFFILIATE', 'LEAD_GENERATION', 'SERVICE', 'OWN_PRODUCT', 'DIGITAL_PRODUCT', 'SPONSORED', 'TRAFFIC_ARBITRAGE');

-- CreateEnum
CREATE TYPE "ProductKind" AS ENUM ('PRODUCT', 'SERVICE', 'DIGITAL_PRODUCT', 'OWN_PRODUCT', 'LEAD_MAGNET');

-- CreateEnum
CREATE TYPE "ProductStatus" AS ENUM ('ACTIVE', 'PAUSED', 'OUT_OF_STOCK', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "DataSource" AS ENUM ('MANUAL', 'CSV', 'API', 'FEED', 'SCRAPE', 'AFFILIATE_NETWORK', 'SEED');

-- CreateEnum
CREATE TYPE "RedirectPolicy" AS ENUM ('REDIRECT_ALLOWED', 'DIRECT_LINK_ONLY');

-- CreateEnum
CREATE TYPE "OfferStatus" AS ENUM ('ACTIVE', 'PAUSED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "ContentFormat" AS ENUM ('SHORT_VIDEO', 'STATIC_POST', 'CAROUSEL', 'TEXT_POST');

-- CreateEnum
CREATE TYPE "EconomicOutcome" AS ENUM ('AFFILIATE_CLICK', 'LEAD', 'SALE', 'SERVICE_INQUIRY', 'EMAIL_SIGNUP');

-- CreateEnum
CREATE TYPE "IdeaStatus" AS ENUM ('PROPOSED', 'SELECTED', 'DISCARDED');

-- CreateEnum
CREATE TYPE "ContentStatus" AS ENUM ('IDEA', 'RESEARCHING', 'SCRIPTING', 'ASSET_PLANNING', 'GENERATING_ASSETS', 'RENDERING', 'QA', 'WAITING_APPROVAL', 'APPROVED', 'REJECTED', 'SCHEDULED', 'PUBLISHING', 'PUBLISHED', 'FAILED', 'ANALYTICS_PENDING', 'BUDGET_BLOCKED', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "QualityLevel" AS ENUM ('DRAFT', 'STANDARD', 'PREMIUM');

-- CreateEnum
CREATE TYPE "GenerationTier" AS ENUM ('TIER_0', 'TIER_1', 'TIER_2', 'TIER_3');

-- CreateEnum
CREATE TYPE "SceneKind" AS ENUM ('HOOK', 'PROBLEM', 'PRODUCT', 'AI_SHOT', 'DEMO', 'BENEFITS', 'COMPARISON', 'OFFER', 'CTA', 'GENERIC');

-- CreateEnum
CREATE TYPE "AssetKind" AS ENUM ('IMAGE', 'PRODUCT_IMAGE', 'PRODUCT_CUTOUT', 'BACKGROUND', 'VIDEO_CLIP', 'VOICEOVER', 'MUSIC', 'SFX', 'SUBTITLES', 'RENDERED_VIDEO', 'RENDERED_IMAGE', 'THUMBNAIL', 'LOGO', 'SCREENSHOT');

-- CreateEnum
CREATE TYPE "AssetStatus" AS ENUM ('PENDING', 'GENERATING', 'READY', 'FAILED');

-- CreateEnum
CREATE TYPE "AssetOrigin" AS ENUM ('GENERATED', 'UPLOADED', 'PRODUCT_SOURCE', 'STOCK', 'PROGRAMMATIC', 'RENDERED', 'DERIVED');

-- CreateEnum
CREATE TYPE "VariantStatus" AS ENUM ('PENDING', 'READY', 'APPROVED', 'REJECTED', 'SKIPPED', 'SCHEDULED', 'PUBLISHING', 'PUBLISHED', 'FAILED', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "VariantPlacement" AS ENUM ('REEL', 'FEED', 'STORY', 'CAROUSEL', 'TEXT');

-- CreateEnum
CREATE TYPE "VariantMediaRole" AS ENUM ('VIDEO', 'COVER', 'IMAGE', 'SLIDE');

-- CreateEnum
CREATE TYPE "ExperimentVariable" AS ENUM ('HOOK', 'CTA', 'CAPTION', 'COVER', 'FIRST_3S');

-- CreateEnum
CREATE TYPE "ExperimentStatus" AS ENUM ('RUNNING', 'CONCLUDED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "JobStatus" AS ENUM ('QUEUED', 'DISPATCHED', 'RUNNING', 'SUCCEEDED', 'RETRYING', 'FAILED', 'DEAD_LETTER', 'BUDGET_BLOCKED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "JobEventType" AS ENUM ('DISPATCH', 'START', 'SUCCESS', 'FAILURE', 'RETRY', 'COST', 'INFO', 'WARN', 'BUDGET_BLOCKED');

-- CreateEnum
CREATE TYPE "RunTrigger" AS ENUM ('STRATEGY', 'MANUAL', 'REGENERATION', 'RETRY');

-- CreateEnum
CREATE TYPE "RunStatus" AS ENUM ('RUNNING', 'SUCCEEDED', 'FAILED', 'BUDGET_BLOCKED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "UsageOperation" AS ENUM ('LLM_COMPLETION', 'IMAGE_GENERATION', 'BACKGROUND_REMOVAL', 'VIDEO_GENERATION', 'TTS', 'OTHER');

-- CreateEnum
CREATE TYPE "UsageStatus" AS ENUM ('RESERVED', 'COMMITTED', 'RELEASED');

-- CreateEnum
CREATE TYPE "ApprovalDecision" AS ENUM ('APPROVED', 'REJECTED', 'REGENERATE', 'EDITED', 'AUTO_REJECTED');

-- CreateEnum
CREATE TYPE "RejectionReason" AS ENUM ('WEAK_HOOK', 'BAD_IMAGE', 'BAD_VIDEO', 'INCORRECT_PRODUCT', 'BAD_VOICE', 'BAD_CTA', 'FACTUAL_PROBLEM', 'QA_FAILED', 'OTHER');

-- CreateEnum
CREATE TYPE "RegenerationScope" AS ENUM ('ENTIRE', 'SCRIPT', 'HOOK', 'IMAGE', 'VIDEO_SCENE', 'VOICE', 'CAPTION');

-- CreateEnum
CREATE TYPE "PublicationStatus" AS ENUM ('SCHEDULED', 'PUBLISHING', 'PUBLISHED', 'FAILED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "MetricsSource" AS ENUM ('PLATFORM_API', 'MOCK', 'MANUAL');

-- CreateEnum
CREATE TYPE "ConversionType" AS ENUM ('LEAD', 'SALE', 'SIGNUP', 'INQUIRY', 'INSTALL', 'OTHER');

-- CreateEnum
CREATE TYPE "ConversionStatus" AS ENUM ('PENDING', 'APPROVED', 'REVERSED');

-- CreateEnum
CREATE TYPE "RevenueKind" AS ENUM ('COMMISSION', 'SALE', 'LEAD_FEE', 'SPONSORSHIP', 'ADJUSTMENT', 'OTHER');

-- CreateEnum
CREATE TYPE "ExpenseCategory" AS ENUM ('INFRASTRUCTURE', 'ADS', 'TOOLS', 'OTHER');

-- CreateEnum
CREATE TYPE "DisclosureKind" AS ENUM ('AFFILIATE', 'AD', 'SPONSORED', 'AI_GENERATED');

-- CreateEnum
CREATE TYPE "DisclosurePlacement" AS ENUM ('CAPTION_START', 'CAPTION_END', 'ON_SCREEN', 'CAPTION_AND_ON_SCREEN');

-- CreateEnum
CREATE TYPE "TemplateKind" AS ENUM ('VIDEO', 'STATIC', 'CAROUSEL');

-- CreateEnum
CREATE TYPE "CredentialKind" AS ENUM ('API_KEY', 'OAUTH_TOKEN');

-- CreateEnum
CREATE TYPE "CredentialStatus" AS ENUM ('ACTIVE', 'EXPIRED', 'REVOKED', 'ERROR');

-- CreateEnum
CREATE TYPE "AuditActor" AS ENUM ('USER', 'SYSTEM', 'WORKER');

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT,
    "passwordHash" TEXT NOT NULL,
    "lastLoginAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Session" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Workspace" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "timezone" TEXT NOT NULL DEFAULT 'UTC',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Workspace_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Membership" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "role" "WorkspaceRole" NOT NULL DEFAULT 'OWNER',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Membership_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Brand" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "description" TEXT,
    "niche" TEXT NOT NULL,
    "targetAudience" TEXT NOT NULL,
    "language" TEXT NOT NULL DEFAULT 'en',
    "countries" TEXT[],
    "toneOfVoice" TEXT NOT NULL,
    "timezone" TEXT NOT NULL DEFAULT 'UTC',
    "colors" JSONB NOT NULL,
    "typography" JSONB NOT NULL,
    "ctaStyles" TEXT[],
    "contentRules" TEXT[],
    "bannedWords" TEXT[],
    "complianceNotes" TEXT,
    "monetizationModels" "MonetizationModel"[],
    "targetPlatforms" "Platform"[],
    "status" "BrandStatus" NOT NULL DEFAULT 'ACTIVE',
    "logoAssetId" TEXT,
    "qaThreshold" INTEGER NOT NULL DEFAULT 70,
    "maxTier" "GenerationTier" NOT NULL DEFAULT 'TIER_1',
    "allowAiVideo" BOOLEAN NOT NULL DEFAULT true,
    "ttsEnabled" BOOLEAN NOT NULL DEFAULT false,
    "voiceId" TEXT,
    "experimentsEnabled" BOOLEAN NOT NULL DEFAULT false,
    "autoIdeationEnabled" BOOLEAN NOT NULL DEFAULT false,
    "ideasPerCycle" INTEGER NOT NULL DEFAULT 2,
    "defaultTemplateKey" TEXT NOT NULL DEFAULT 'vertical-bold',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Brand_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SocialAccount" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "brandId" TEXT NOT NULL,
    "platform" "Platform" NOT NULL,
    "handle" TEXT NOT NULL,
    "displayName" TEXT,
    "externalAccountId" TEXT,
    "credentialId" TEXT,
    "status" "SocialAccountStatus" NOT NULL DEFAULT 'MOCK',
    "isMock" BOOLEAN NOT NULL DEFAULT true,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SocialAccount_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PublishingSlot" (
    "id" TEXT NOT NULL,
    "brandId" TEXT NOT NULL,
    "platform" "Platform" NOT NULL,
    "socialAccountId" TEXT,
    "dayOfWeek" INTEGER,
    "timeOfDay" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PublishingSlot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DisclosureRule" (
    "id" TEXT NOT NULL,
    "brandId" TEXT NOT NULL,
    "platform" "Platform",
    "kind" "DisclosureKind" NOT NULL,
    "text" TEXT NOT NULL,
    "placement" "DisclosurePlacement" NOT NULL DEFAULT 'CAPTION_START',
    "isRequired" BOOLEAN NOT NULL DEFAULT true,
    "jurisdiction" TEXT,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DisclosureRule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Template" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT,
    "brandId" TEXT,
    "scope" TEXT NOT NULL DEFAULT 'system',
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "kind" "TemplateKind" NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "spec" JSONB NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Template_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BrandPerformanceProfile" (
    "id" TEXT NOT NULL,
    "brandId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "windowStart" TIMESTAMP(3) NOT NULL,
    "windowEnd" TIMESTAMP(3) NOT NULL,
    "sampleSize" INTEGER NOT NULL,
    "summary" JSONB NOT NULL,
    "promptText" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BrandPerformanceProfile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AffiliateProgram" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "network" TEXT NOT NULL,
    "website" TEXT,
    "defaultCommissionRate" DECIMAL(7,4),
    "cookieDays" INTEGER,
    "redirectPolicy" "RedirectPolicy" NOT NULL DEFAULT 'REDIRECT_ALLOWED',
    "subIdParam" TEXT,
    "disclosureText" TEXT,
    "postbackSecretHash" TEXT,
    "conversionFieldMap" JSONB,
    "termsNotes" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AffiliateProgram_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Product" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "brandId" TEXT NOT NULL,
    "kind" "ProductKind" NOT NULL DEFAULT 'PRODUCT',
    "title" TEXT NOT NULL,
    "description" TEXT,
    "manufacturer" TEXT,
    "sku" TEXT,
    "source" "DataSource" NOT NULL DEFAULT 'MANUAL',
    "sourceUrl" TEXT,
    "sourceRef" TEXT,
    "productUrl" TEXT,
    "imageUrls" TEXT[],
    "price" DECIMAL(12,2),
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "priceCheckedAt" TIMESTAMP(3),
    "category" TEXT,
    "commissionRate" DECIMAL(7,4),
    "commissionFixedUsd" DECIMAL(12,2),
    "affiliateUrl" TEXT,
    "trackingId" TEXT,
    "tags" TEXT[],
    "facts" JSONB NOT NULL DEFAULT '[]',
    "status" "ProductStatus" NOT NULL DEFAULT 'ACTIVE',
    "primaryImageAssetId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Product_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Offer" (
    "id" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "affiliateProgramId" TEXT,
    "title" TEXT,
    "price" DECIMAL(12,2),
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "commissionRate" DECIMAL(7,4),
    "commissionFixedUsd" DECIMAL(12,2),
    "landingUrl" TEXT NOT NULL,
    "validFrom" TIMESTAMP(3),
    "validTo" TIMESTAMP(3),
    "status" "OfferStatus" NOT NULL DEFAULT 'ACTIVE',
    "isPrimary" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Offer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AffiliateLink" (
    "id" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "offerId" TEXT,
    "affiliateProgramId" TEXT,
    "url" TEXT NOT NULL,
    "trackingId" TEXT,
    "subIdParam" TEXT,
    "region" TEXT,
    "status" "OfferStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AffiliateLink_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ContentIdea" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "brandId" TEXT NOT NULL,
    "productId" TEXT,
    "offerId" TEXT,
    "title" TEXT NOT NULL,
    "angle" TEXT NOT NULL,
    "hook" TEXT,
    "summary" TEXT,
    "format" "ContentFormat" NOT NULL DEFAULT 'SHORT_VIDEO',
    "economicOutcome" "EconomicOutcome" NOT NULL DEFAULT 'AFFILIATE_CLICK',
    "targetAudience" TEXT,
    "rationale" TEXT,
    "riskNotes" TEXT,
    "status" "IdeaStatus" NOT NULL DEFAULT 'PROPOSED',
    "source" TEXT NOT NULL DEFAULT 'strategy_engine',
    "promptVersionId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ContentIdea_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OpportunityScore" (
    "id" TEXT NOT NULL,
    "ideaId" TEXT NOT NULL,
    "totalScore" DOUBLE PRECISION NOT NULL,
    "expectedCtr" DOUBLE PRECISION NOT NULL,
    "expectedConversionRate" DOUBLE PRECISION NOT NULL,
    "expectedImpressions" INTEGER NOT NULL,
    "estimatedRevenueUsd" DECIMAL(18,6) NOT NULL,
    "estimatedCostUsd" DECIMAL(18,6) NOT NULL,
    "expectedProfitUsd" DECIMAL(18,6) NOT NULL,
    "novelty" DOUBLE PRECISION NOT NULL,
    "relevance" DOUBLE PRECISION NOT NULL,
    "similarity" DOUBLE PRECISION NOT NULL,
    "commissionScore" DOUBLE PRECISION NOT NULL,
    "confidence" DOUBLE PRECISION NOT NULL,
    "factors" JSONB NOT NULL,
    "model" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OpportunityScore_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ContentProject" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "brandId" TEXT NOT NULL,
    "ideaId" TEXT,
    "productId" TEXT,
    "offerId" TEXT,
    "templateId" TEXT,
    "format" "ContentFormat" NOT NULL DEFAULT 'SHORT_VIDEO',
    "status" "ContentStatus" NOT NULL DEFAULT 'IDEA',
    "statusChangedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resumeStatus" "ContentStatus",
    "failureReason" TEXT,
    "blockedReasons" JSONB,
    "economicOutcome" "EconomicOutcome" NOT NULL DEFAULT 'AFFILIATE_CLICK',
    "requestedQuality" "QualityLevel" NOT NULL DEFAULT 'STANDARD',
    "tier" "GenerationTier",
    "routerDecision" JSONB,
    "title" TEXT NOT NULL,
    "angle" TEXT,
    "language" TEXT NOT NULL DEFAULT 'en',
    "hook" TEXT,
    "hookStyle" TEXT,
    "cta" TEXT,
    "ctaType" TEXT,
    "caption" TEXT,
    "hashtags" TEXT[],
    "researchBrief" JSONB,
    "script" JSONB,
    "visualPlan" JSONB,
    "commercialIntent" TEXT,
    "confidence" DOUBLE PRECISION,
    "targetDurationMs" INTEGER,
    "durationMs" INTEGER,
    "renderSpec" JSONB,
    "masterAssetId" TEXT,
    "coverAssetId" TEXT,
    "qaScore" INTEGER,
    "qaPassed" BOOLEAN,
    "qaReport" JSONB,
    "costEstimateUsd" DECIMAL(18,6),
    "revision" INTEGER NOT NULL DEFAULT 1,
    "regenerationCount" INTEGER NOT NULL DEFAULT 0,
    "aiGenerated" BOOLEAN NOT NULL DEFAULT false,
    "scriptPromptVersionId" TEXT,
    "approvedAt" TIMESTAMP(3),
    "approvedById" TEXT,
    "publishedAt" TIMESTAMP(3),
    "archivedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ContentProject_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Scene" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "index" INTEGER NOT NULL,
    "kind" "SceneKind" NOT NULL,
    "durationMs" INTEGER NOT NULL,
    "onScreenText" TEXT,
    "voiceoverText" TEXT,
    "visualType" TEXT NOT NULL,
    "visualDescription" TEXT,
    "imagePrompt" TEXT,
    "motion" TEXT,
    "transition" TEXT,
    "primaryAssetId" TEXT,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Scene_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Asset" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "brandId" TEXT,
    "projectId" TEXT,
    "sceneId" TEXT,
    "productId" TEXT,
    "kind" "AssetKind" NOT NULL,
    "status" "AssetStatus" NOT NULL DEFAULT 'PENDING',
    "origin" "AssetOrigin" NOT NULL,
    "storageKey" TEXT,
    "mimeType" TEXT,
    "width" INTEGER,
    "height" INTEGER,
    "durationMs" INTEGER,
    "sizeBytes" INTEGER,
    "checksum" TEXT,
    "provider" TEXT,
    "model" TEXT,
    "prompt" TEXT,
    "negativePrompt" TEXT,
    "params" JSONB,
    "seed" INTEGER,
    "externalJobId" TEXT,
    "generationCostUsd" DECIMAL(18,6),
    "isMock" BOOLEAN NOT NULL DEFAULT false,
    "sourceUrl" TEXT,
    "license" TEXT,
    "licenseMetadata" JSONB,
    "metadata" JSONB,
    "idempotencyKey" TEXT NOT NULL,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "errorMessage" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Asset_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AssetInput" (
    "assetId" TEXT NOT NULL,
    "inputAssetId" TEXT NOT NULL,
    "role" TEXT NOT NULL,

    CONSTRAINT "AssetInput_pkey" PRIMARY KEY ("assetId","inputAssetId","role")
);

-- CreateTable
CREATE TABLE "ContentVariant" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "platform" "Platform" NOT NULL,
    "placement" "VariantPlacement" NOT NULL DEFAULT 'REEL',
    "status" "VariantStatus" NOT NULL DEFAULT 'PENDING',
    "armKey" TEXT NOT NULL DEFAULT 'A',
    "caption" TEXT,
    "hashtags" TEXT[],
    "disclosureText" TEXT,
    "firstComment" TEXT,
    "overrides" JSONB,
    "qaScore" INTEGER,
    "qaIssues" JSONB,
    "aiGenerated" BOOLEAN NOT NULL DEFAULT false,
    "trackedLinkId" TEXT,
    "experimentId" TEXT,
    "approvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ContentVariant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VariantMedia" (
    "id" TEXT NOT NULL,
    "variantId" TEXT NOT NULL,
    "assetId" TEXT NOT NULL,
    "role" "VariantMediaRole" NOT NULL,
    "position" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "VariantMedia_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Experiment" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "variable" "ExperimentVariable" NOT NULL,
    "status" "ExperimentStatus" NOT NULL DEFAULT 'RUNNING',
    "hypothesis" TEXT,
    "primaryPlatform" "Platform" NOT NULL,
    "metric" TEXT NOT NULL DEFAULT 'ctr',
    "arms" JSONB NOT NULL,
    "winnerArmKey" TEXT,
    "results" JSONB,
    "concludedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Experiment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PipelineRun" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "brandId" TEXT NOT NULL,
    "projectId" TEXT,
    "trigger" "RunTrigger" NOT NULL,
    "scope" "RegenerationScope",
    "status" "RunStatus" NOT NULL DEFAULT 'RUNNING',
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    "error" TEXT,

    CONSTRAINT "PipelineRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GenerationJob" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT,
    "brandId" TEXT,
    "projectId" TEXT,
    "variantId" TEXT,
    "assetId" TEXT,
    "publicationId" TEXT,
    "runId" TEXT,
    "queue" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "status" "JobStatus" NOT NULL DEFAULT 'QUEUED',
    "idempotencyKey" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "result" JSONB,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "maxAttempts" INTEGER NOT NULL DEFAULT 3,
    "priority" INTEGER NOT NULL DEFAULT 0,
    "timeoutMs" INTEGER NOT NULL DEFAULT 120000,
    "runAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "dispatchedAt" TIMESTAMP(3),
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "lastError" TEXT,
    "errorClass" TEXT,
    "dispatchCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GenerationJob_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "JobEvent" (
    "id" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "runId" TEXT,
    "type" "JobEventType" NOT NULL,
    "message" TEXT NOT NULL,
    "data" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "JobEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Approval" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "variantId" TEXT,
    "userId" TEXT,
    "decision" "ApprovalDecision" NOT NULL,
    "reasons" "RejectionReason"[],
    "note" TEXT,
    "scope" "RegenerationScope",
    "sceneId" TEXT,
    "edits" JSONB,
    "revision" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Approval_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PromptVersion" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "contentHash" TEXT NOT NULL,
    "system" TEXT NOT NULL,
    "template" TEXT NOT NULL,
    "schemaName" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PromptVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditLog" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT,
    "userId" TEXT,
    "actor" "AuditActor" NOT NULL,
    "action" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "data" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GenerationUsage" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "brandId" TEXT,
    "projectId" TEXT,
    "jobId" TEXT,
    "assetId" TEXT,
    "runId" TEXT,
    "provider" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "operation" "UsageOperation" NOT NULL,
    "status" "UsageStatus" NOT NULL DEFAULT 'RESERVED',
    "isMock" BOOLEAN NOT NULL DEFAULT false,
    "isAiVideo" BOOLEAN NOT NULL DEFAULT false,
    "inputTokens" INTEGER NOT NULL DEFAULT 0,
    "cachedInputTokens" INTEGER NOT NULL DEFAULT 0,
    "outputTokens" INTEGER NOT NULL DEFAULT 0,
    "imageCount" INTEGER NOT NULL DEFAULT 0,
    "videoSeconds" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "audioSeconds" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "characters" INTEGER NOT NULL DEFAULT 0,
    "estimatedCostUsd" DECIMAL(18,6) NOT NULL,
    "actualCostUsd" DECIMAL(18,6),
    "idempotencyKey" TEXT NOT NULL,
    "promptVersionId" TEXT,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "settledAt" TIMESTAMP(3),

    CONSTRAINT "GenerationUsage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Budget" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "brandId" TEXT,
    "scopeKey" TEXT NOT NULL,
    "dailyLimitUsd" DECIMAL(18,6),
    "weeklyLimitUsd" DECIMAL(18,6),
    "monthlyLimitUsd" DECIMAL(18,6),
    "maxContentCostUsd" DECIMAL(18,6),
    "maxAiVideoCostUsd" DECIMAL(18,6),
    "maxRegenerations" INTEGER,
    "isEnforced" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Budget_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Publication" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "brandId" TEXT NOT NULL,
    "variantId" TEXT NOT NULL,
    "socialAccountId" TEXT NOT NULL,
    "platform" "Platform" NOT NULL,
    "status" "PublicationStatus" NOT NULL DEFAULT 'SCHEDULED',
    "sequence" INTEGER NOT NULL DEFAULT 1,
    "scheduledAt" TIMESTAMP(3) NOT NULL,
    "publishedAt" TIMESTAMP(3),
    "externalPostId" TEXT,
    "externalUrl" TEXT,
    "externalContainerId" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "errorCode" TEXT,
    "isMock" BOOLEAN NOT NULL DEFAULT false,
    "analyticsUntil" TIMESTAMP(3),
    "nextAnalyticsAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Publication_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AnalyticsSnapshot" (
    "id" TEXT NOT NULL,
    "publicationId" TEXT NOT NULL,
    "capturedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "source" "MetricsSource" NOT NULL,
    "impressions" INTEGER,
    "reach" INTEGER,
    "plays" INTEGER,
    "views3s" INTEGER,
    "completionRate" DOUBLE PRECISION,
    "avgWatchTimeMs" INTEGER,
    "likes" INTEGER,
    "comments" INTEGER,
    "saves" INTEGER,
    "shares" INTEGER,
    "profileVisits" INTEGER,
    "outboundClicks" INTEGER,
    "follows" INTEGER,
    "raw" JSONB,

    CONSTRAINT "AnalyticsSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TrackedLink" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "brandId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "destinationUrl" TEXT NOT NULL,
    "affiliateLinkId" TEXT,
    "productId" TEXT,
    "projectId" TEXT,
    "platform" "Platform",
    "campaign" TEXT,
    "utmSource" TEXT,
    "utmMedium" TEXT,
    "utmCampaign" TEXT,
    "utmContent" TEXT,
    "utmTerm" TEXT,
    "appendUtm" BOOLEAN NOT NULL DEFAULT false,
    "subIdParam" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "expiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TrackedLink_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Click" (
    "id" TEXT NOT NULL,
    "clickId" TEXT NOT NULL,
    "trackedLinkId" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "brandId" TEXT NOT NULL,
    "projectId" TEXT,
    "variantId" TEXT,
    "publicationId" TEXT,
    "productId" TEXT,
    "platform" "Platform",
    "campaign" TEXT,
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "referrerHost" TEXT,
    "utmSource" TEXT,
    "utmMedium" TEXT,
    "utmCampaign" TEXT,
    "utmContent" TEXT,
    "utmTerm" TEXT,
    "deviceType" TEXT,
    "osFamily" TEXT,
    "browserFamily" TEXT,
    "country" TEXT,
    "isBot" BOOLEAN NOT NULL DEFAULT false,
    "visitorHash" TEXT,
    "isSimulated" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "Click_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Conversion" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "brandId" TEXT,
    "affiliateProgramId" TEXT,
    "clickRefId" TEXT,
    "clickIdRaw" TEXT,
    "trackedLinkId" TEXT,
    "productId" TEXT,
    "projectId" TEXT,
    "variantId" TEXT,
    "publicationId" TEXT,
    "platform" "Platform",
    "type" "ConversionType" NOT NULL DEFAULT 'SALE',
    "status" "ConversionStatus" NOT NULL DEFAULT 'PENDING',
    "externalId" TEXT,
    "source" TEXT NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "orderValue" DECIMAL(18,6),
    "commission" DECIMAL(18,6),
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "commissionUsd" DECIMAL(18,6),
    "isSimulated" BOOLEAN NOT NULL DEFAULT false,
    "raw" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Conversion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RevenueEntry" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "brandId" TEXT,
    "conversionId" TEXT,
    "projectId" TEXT,
    "variantId" TEXT,
    "productId" TEXT,
    "platform" "Platform",
    "kind" "RevenueKind" NOT NULL,
    "amount" DECIMAL(18,6) NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "fxRateToUsd" DECIMAL(18,8) NOT NULL DEFAULT 1,
    "amountUsd" DECIMAL(18,6) NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "source" TEXT NOT NULL,
    "isSimulated" BOOLEAN NOT NULL DEFAULT false,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RevenueEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Expense" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "brandId" TEXT,
    "category" "ExpenseCategory" NOT NULL,
    "amountUsd" DECIMAL(18,6) NOT NULL,
    "incurredOn" TIMESTAMP(3) NOT NULL,
    "periodDays" INTEGER NOT NULL DEFAULT 1,
    "description" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Expense_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProviderCredential" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "kind" "CredentialKind" NOT NULL,
    "label" TEXT NOT NULL,
    "ciphertext" TEXT NOT NULL,
    "iv" TEXT NOT NULL,
    "authTag" TEXT NOT NULL,
    "keyVersion" INTEGER NOT NULL DEFAULT 1,
    "scopes" TEXT[],
    "expiresAt" TIMESTAMP(3),
    "status" "CredentialStatus" NOT NULL DEFAULT 'ACTIVE',
    "lastUsedAt" TIMESTAMP(3),
    "lastError" TEXT,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProviderCredential_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE UNIQUE INDEX "Session_tokenHash_key" ON "Session"("tokenHash");

-- CreateIndex
CREATE INDEX "Session_userId_idx" ON "Session"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "Workspace_slug_key" ON "Workspace"("slug");

-- CreateIndex
CREATE INDEX "Membership_workspaceId_idx" ON "Membership"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "Membership_userId_workspaceId_key" ON "Membership"("userId", "workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "Brand_logoAssetId_key" ON "Brand"("logoAssetId");

-- CreateIndex
CREATE INDEX "Brand_workspaceId_status_idx" ON "Brand"("workspaceId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "Brand_workspaceId_slug_key" ON "Brand"("workspaceId", "slug");

-- CreateIndex
CREATE INDEX "SocialAccount_workspaceId_idx" ON "SocialAccount"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "SocialAccount_brandId_platform_handle_key" ON "SocialAccount"("brandId", "platform", "handle");

-- CreateIndex
CREATE INDEX "PublishingSlot_brandId_platform_idx" ON "PublishingSlot"("brandId", "platform");

-- CreateIndex
CREATE INDEX "DisclosureRule_brandId_idx" ON "DisclosureRule"("brandId");

-- CreateIndex
CREATE UNIQUE INDEX "Template_scope_key_version_key" ON "Template"("scope", "key", "version");

-- CreateIndex
CREATE UNIQUE INDEX "BrandPerformanceProfile_brandId_version_key" ON "BrandPerformanceProfile"("brandId", "version");

-- CreateIndex
CREATE UNIQUE INDEX "AffiliateProgram_workspaceId_name_key" ON "AffiliateProgram"("workspaceId", "name");

-- CreateIndex
CREATE INDEX "Product_workspaceId_status_idx" ON "Product"("workspaceId", "status");

-- CreateIndex
CREATE INDEX "Product_brandId_status_idx" ON "Product"("brandId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "Product_brandId_sku_key" ON "Product"("brandId", "sku");

-- CreateIndex
CREATE INDEX "Offer_productId_status_idx" ON "Offer"("productId", "status");

-- CreateIndex
CREATE INDEX "AffiliateLink_productId_idx" ON "AffiliateLink"("productId");

-- CreateIndex
CREATE INDEX "ContentIdea_brandId_createdAt_idx" ON "ContentIdea"("brandId", "createdAt");

-- CreateIndex
CREATE INDEX "ContentIdea_brandId_status_idx" ON "ContentIdea"("brandId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "OpportunityScore_ideaId_key" ON "OpportunityScore"("ideaId");

-- CreateIndex
CREATE INDEX "ContentProject_brandId_status_idx" ON "ContentProject"("brandId", "status");

-- CreateIndex
CREATE INDEX "ContentProject_workspaceId_status_updatedAt_idx" ON "ContentProject"("workspaceId", "status", "updatedAt");

-- CreateIndex
CREATE INDEX "ContentProject_status_statusChangedAt_idx" ON "ContentProject"("status", "statusChangedAt");

-- CreateIndex
CREATE UNIQUE INDEX "Scene_projectId_index_key" ON "Scene"("projectId", "index");

-- CreateIndex
CREATE UNIQUE INDEX "Asset_idempotencyKey_key" ON "Asset"("idempotencyKey");

-- CreateIndex
CREATE INDEX "Asset_projectId_kind_idx" ON "Asset"("projectId", "kind");

-- CreateIndex
CREATE INDEX "Asset_brandId_kind_idx" ON "Asset"("brandId", "kind");

-- CreateIndex
CREATE INDEX "Asset_productId_idx" ON "Asset"("productId");

-- CreateIndex
CREATE INDEX "AssetInput_inputAssetId_idx" ON "AssetInput"("inputAssetId");

-- CreateIndex
CREATE UNIQUE INDEX "ContentVariant_trackedLinkId_key" ON "ContentVariant"("trackedLinkId");

-- CreateIndex
CREATE INDEX "ContentVariant_status_idx" ON "ContentVariant"("status");

-- CreateIndex
CREATE UNIQUE INDEX "ContentVariant_projectId_platform_armKey_key" ON "ContentVariant"("projectId", "platform", "armKey");

-- CreateIndex
CREATE INDEX "VariantMedia_assetId_idx" ON "VariantMedia"("assetId");

-- CreateIndex
CREATE UNIQUE INDEX "VariantMedia_variantId_role_position_key" ON "VariantMedia"("variantId", "role", "position");

-- CreateIndex
CREATE INDEX "Experiment_projectId_idx" ON "Experiment"("projectId");

-- CreateIndex
CREATE INDEX "PipelineRun_projectId_startedAt_idx" ON "PipelineRun"("projectId", "startedAt");

-- CreateIndex
CREATE INDEX "PipelineRun_brandId_startedAt_idx" ON "PipelineRun"("brandId", "startedAt");

-- CreateIndex
CREATE UNIQUE INDEX "GenerationJob_idempotencyKey_key" ON "GenerationJob"("idempotencyKey");

-- CreateIndex
CREATE INDEX "GenerationJob_status_runAt_idx" ON "GenerationJob"("status", "runAt");

-- CreateIndex
CREATE INDEX "GenerationJob_projectId_createdAt_idx" ON "GenerationJob"("projectId", "createdAt");

-- CreateIndex
CREATE INDEX "GenerationJob_brandId_createdAt_idx" ON "GenerationJob"("brandId", "createdAt");

-- CreateIndex
CREATE INDEX "GenerationJob_runId_idx" ON "GenerationJob"("runId");

-- CreateIndex
CREATE INDEX "GenerationJob_type_status_idx" ON "GenerationJob"("type", "status");

-- CreateIndex
CREATE INDEX "JobEvent_jobId_createdAt_idx" ON "JobEvent"("jobId", "createdAt");

-- CreateIndex
CREATE INDEX "JobEvent_runId_createdAt_idx" ON "JobEvent"("runId", "createdAt");

-- CreateIndex
CREATE INDEX "Approval_projectId_createdAt_idx" ON "Approval"("projectId", "createdAt");

-- CreateIndex
CREATE INDEX "Approval_decision_createdAt_idx" ON "Approval"("decision", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "PromptVersion_key_version_key" ON "PromptVersion"("key", "version");

-- CreateIndex
CREATE INDEX "AuditLog_entityType_entityId_createdAt_idx" ON "AuditLog"("entityType", "entityId", "createdAt");

-- CreateIndex
CREATE INDEX "AuditLog_workspaceId_createdAt_idx" ON "AuditLog"("workspaceId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "GenerationUsage_idempotencyKey_key" ON "GenerationUsage"("idempotencyKey");

-- CreateIndex
CREATE INDEX "GenerationUsage_workspaceId_createdAt_idx" ON "GenerationUsage"("workspaceId", "createdAt");

-- CreateIndex
CREATE INDEX "GenerationUsage_brandId_createdAt_idx" ON "GenerationUsage"("brandId", "createdAt");

-- CreateIndex
CREATE INDEX "GenerationUsage_projectId_idx" ON "GenerationUsage"("projectId");

-- CreateIndex
CREATE INDEX "GenerationUsage_status_createdAt_idx" ON "GenerationUsage"("status", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "Budget_brandId_key" ON "Budget"("brandId");

-- CreateIndex
CREATE UNIQUE INDEX "Budget_scopeKey_key" ON "Budget"("scopeKey");

-- CreateIndex
CREATE INDEX "Publication_status_scheduledAt_idx" ON "Publication"("status", "scheduledAt");

-- CreateIndex
CREATE INDEX "Publication_brandId_publishedAt_idx" ON "Publication"("brandId", "publishedAt");

-- CreateIndex
CREATE INDEX "Publication_socialAccountId_scheduledAt_idx" ON "Publication"("socialAccountId", "scheduledAt");

-- CreateIndex
CREATE UNIQUE INDEX "Publication_variantId_socialAccountId_sequence_key" ON "Publication"("variantId", "socialAccountId", "sequence");

-- CreateIndex
CREATE INDEX "AnalyticsSnapshot_publicationId_capturedAt_idx" ON "AnalyticsSnapshot"("publicationId", "capturedAt");

-- CreateIndex
CREATE UNIQUE INDEX "TrackedLink_code_key" ON "TrackedLink"("code");

-- CreateIndex
CREATE INDEX "TrackedLink_brandId_createdAt_idx" ON "TrackedLink"("brandId", "createdAt");

-- CreateIndex
CREATE INDEX "TrackedLink_projectId_idx" ON "TrackedLink"("projectId");

-- CreateIndex
CREATE UNIQUE INDEX "Click_clickId_key" ON "Click"("clickId");

-- CreateIndex
CREATE INDEX "Click_brandId_occurredAt_idx" ON "Click"("brandId", "occurredAt");

-- CreateIndex
CREATE INDEX "Click_trackedLinkId_occurredAt_idx" ON "Click"("trackedLinkId", "occurredAt");

-- CreateIndex
CREATE INDEX "Click_projectId_occurredAt_idx" ON "Click"("projectId", "occurredAt");

-- CreateIndex
CREATE INDEX "Click_variantId_idx" ON "Click"("variantId");

-- CreateIndex
CREATE INDEX "Conversion_brandId_occurredAt_idx" ON "Conversion"("brandId", "occurredAt");

-- CreateIndex
CREATE INDEX "Conversion_projectId_idx" ON "Conversion"("projectId");

-- CreateIndex
CREATE INDEX "Conversion_workspaceId_occurredAt_idx" ON "Conversion"("workspaceId", "occurredAt");

-- CreateIndex
CREATE UNIQUE INDEX "Conversion_affiliateProgramId_externalId_key" ON "Conversion"("affiliateProgramId", "externalId");

-- CreateIndex
CREATE INDEX "RevenueEntry_workspaceId_occurredAt_idx" ON "RevenueEntry"("workspaceId", "occurredAt");

-- CreateIndex
CREATE INDEX "RevenueEntry_brandId_occurredAt_idx" ON "RevenueEntry"("brandId", "occurredAt");

-- CreateIndex
CREATE INDEX "RevenueEntry_projectId_idx" ON "RevenueEntry"("projectId");

-- CreateIndex
CREATE INDEX "RevenueEntry_productId_idx" ON "RevenueEntry"("productId");

-- CreateIndex
CREATE INDEX "Expense_workspaceId_incurredOn_idx" ON "Expense"("workspaceId", "incurredOn");

-- CreateIndex
CREATE INDEX "ProviderCredential_workspaceId_provider_idx" ON "ProviderCredential"("workspaceId", "provider");

-- AddForeignKey
ALTER TABLE "Session" ADD CONSTRAINT "Session_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Membership" ADD CONSTRAINT "Membership_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Membership" ADD CONSTRAINT "Membership_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Brand" ADD CONSTRAINT "Brand_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Brand" ADD CONSTRAINT "Brand_logoAssetId_fkey" FOREIGN KEY ("logoAssetId") REFERENCES "Asset"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SocialAccount" ADD CONSTRAINT "SocialAccount_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SocialAccount" ADD CONSTRAINT "SocialAccount_brandId_fkey" FOREIGN KEY ("brandId") REFERENCES "Brand"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SocialAccount" ADD CONSTRAINT "SocialAccount_credentialId_fkey" FOREIGN KEY ("credentialId") REFERENCES "ProviderCredential"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PublishingSlot" ADD CONSTRAINT "PublishingSlot_brandId_fkey" FOREIGN KEY ("brandId") REFERENCES "Brand"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PublishingSlot" ADD CONSTRAINT "PublishingSlot_socialAccountId_fkey" FOREIGN KEY ("socialAccountId") REFERENCES "SocialAccount"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DisclosureRule" ADD CONSTRAINT "DisclosureRule_brandId_fkey" FOREIGN KEY ("brandId") REFERENCES "Brand"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Template" ADD CONSTRAINT "Template_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Template" ADD CONSTRAINT "Template_brandId_fkey" FOREIGN KEY ("brandId") REFERENCES "Brand"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BrandPerformanceProfile" ADD CONSTRAINT "BrandPerformanceProfile_brandId_fkey" FOREIGN KEY ("brandId") REFERENCES "Brand"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AffiliateProgram" ADD CONSTRAINT "AffiliateProgram_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Product" ADD CONSTRAINT "Product_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Product" ADD CONSTRAINT "Product_brandId_fkey" FOREIGN KEY ("brandId") REFERENCES "Brand"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Product" ADD CONSTRAINT "Product_primaryImageAssetId_fkey" FOREIGN KEY ("primaryImageAssetId") REFERENCES "Asset"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Offer" ADD CONSTRAINT "Offer_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Offer" ADD CONSTRAINT "Offer_affiliateProgramId_fkey" FOREIGN KEY ("affiliateProgramId") REFERENCES "AffiliateProgram"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AffiliateLink" ADD CONSTRAINT "AffiliateLink_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AffiliateLink" ADD CONSTRAINT "AffiliateLink_offerId_fkey" FOREIGN KEY ("offerId") REFERENCES "Offer"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AffiliateLink" ADD CONSTRAINT "AffiliateLink_affiliateProgramId_fkey" FOREIGN KEY ("affiliateProgramId") REFERENCES "AffiliateProgram"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContentIdea" ADD CONSTRAINT "ContentIdea_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContentIdea" ADD CONSTRAINT "ContentIdea_brandId_fkey" FOREIGN KEY ("brandId") REFERENCES "Brand"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContentIdea" ADD CONSTRAINT "ContentIdea_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContentIdea" ADD CONSTRAINT "ContentIdea_offerId_fkey" FOREIGN KEY ("offerId") REFERENCES "Offer"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContentIdea" ADD CONSTRAINT "ContentIdea_promptVersionId_fkey" FOREIGN KEY ("promptVersionId") REFERENCES "PromptVersion"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OpportunityScore" ADD CONSTRAINT "OpportunityScore_ideaId_fkey" FOREIGN KEY ("ideaId") REFERENCES "ContentIdea"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContentProject" ADD CONSTRAINT "ContentProject_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContentProject" ADD CONSTRAINT "ContentProject_brandId_fkey" FOREIGN KEY ("brandId") REFERENCES "Brand"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContentProject" ADD CONSTRAINT "ContentProject_ideaId_fkey" FOREIGN KEY ("ideaId") REFERENCES "ContentIdea"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContentProject" ADD CONSTRAINT "ContentProject_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContentProject" ADD CONSTRAINT "ContentProject_offerId_fkey" FOREIGN KEY ("offerId") REFERENCES "Offer"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContentProject" ADD CONSTRAINT "ContentProject_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "Template"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContentProject" ADD CONSTRAINT "ContentProject_masterAssetId_fkey" FOREIGN KEY ("masterAssetId") REFERENCES "Asset"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContentProject" ADD CONSTRAINT "ContentProject_coverAssetId_fkey" FOREIGN KEY ("coverAssetId") REFERENCES "Asset"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContentProject" ADD CONSTRAINT "ContentProject_scriptPromptVersionId_fkey" FOREIGN KEY ("scriptPromptVersionId") REFERENCES "PromptVersion"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Scene" ADD CONSTRAINT "Scene_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "ContentProject"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Scene" ADD CONSTRAINT "Scene_primaryAssetId_fkey" FOREIGN KEY ("primaryAssetId") REFERENCES "Asset"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Asset" ADD CONSTRAINT "Asset_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Asset" ADD CONSTRAINT "Asset_brandId_fkey" FOREIGN KEY ("brandId") REFERENCES "Brand"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Asset" ADD CONSTRAINT "Asset_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "ContentProject"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Asset" ADD CONSTRAINT "Asset_sceneId_fkey" FOREIGN KEY ("sceneId") REFERENCES "Scene"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Asset" ADD CONSTRAINT "Asset_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AssetInput" ADD CONSTRAINT "AssetInput_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "Asset"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AssetInput" ADD CONSTRAINT "AssetInput_inputAssetId_fkey" FOREIGN KEY ("inputAssetId") REFERENCES "Asset"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContentVariant" ADD CONSTRAINT "ContentVariant_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "ContentProject"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContentVariant" ADD CONSTRAINT "ContentVariant_trackedLinkId_fkey" FOREIGN KEY ("trackedLinkId") REFERENCES "TrackedLink"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContentVariant" ADD CONSTRAINT "ContentVariant_experimentId_fkey" FOREIGN KEY ("experimentId") REFERENCES "Experiment"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VariantMedia" ADD CONSTRAINT "VariantMedia_variantId_fkey" FOREIGN KEY ("variantId") REFERENCES "ContentVariant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VariantMedia" ADD CONSTRAINT "VariantMedia_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "Asset"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Experiment" ADD CONSTRAINT "Experiment_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "ContentProject"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PipelineRun" ADD CONSTRAINT "PipelineRun_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PipelineRun" ADD CONSTRAINT "PipelineRun_brandId_fkey" FOREIGN KEY ("brandId") REFERENCES "Brand"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PipelineRun" ADD CONSTRAINT "PipelineRun_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "ContentProject"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GenerationJob" ADD CONSTRAINT "GenerationJob_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GenerationJob" ADD CONSTRAINT "GenerationJob_brandId_fkey" FOREIGN KEY ("brandId") REFERENCES "Brand"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GenerationJob" ADD CONSTRAINT "GenerationJob_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "ContentProject"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GenerationJob" ADD CONSTRAINT "GenerationJob_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "Asset"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GenerationJob" ADD CONSTRAINT "GenerationJob_publicationId_fkey" FOREIGN KEY ("publicationId") REFERENCES "Publication"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GenerationJob" ADD CONSTRAINT "GenerationJob_runId_fkey" FOREIGN KEY ("runId") REFERENCES "PipelineRun"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JobEvent" ADD CONSTRAINT "JobEvent_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "GenerationJob"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Approval" ADD CONSTRAINT "Approval_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "ContentProject"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Approval" ADD CONSTRAINT "Approval_variantId_fkey" FOREIGN KEY ("variantId") REFERENCES "ContentVariant"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Approval" ADD CONSTRAINT "Approval_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GenerationUsage" ADD CONSTRAINT "GenerationUsage_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GenerationUsage" ADD CONSTRAINT "GenerationUsage_brandId_fkey" FOREIGN KEY ("brandId") REFERENCES "Brand"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GenerationUsage" ADD CONSTRAINT "GenerationUsage_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "ContentProject"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GenerationUsage" ADD CONSTRAINT "GenerationUsage_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "GenerationJob"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GenerationUsage" ADD CONSTRAINT "GenerationUsage_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "Asset"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GenerationUsage" ADD CONSTRAINT "GenerationUsage_runId_fkey" FOREIGN KEY ("runId") REFERENCES "PipelineRun"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GenerationUsage" ADD CONSTRAINT "GenerationUsage_promptVersionId_fkey" FOREIGN KEY ("promptVersionId") REFERENCES "PromptVersion"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Budget" ADD CONSTRAINT "Budget_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Budget" ADD CONSTRAINT "Budget_brandId_fkey" FOREIGN KEY ("brandId") REFERENCES "Brand"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Publication" ADD CONSTRAINT "Publication_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Publication" ADD CONSTRAINT "Publication_brandId_fkey" FOREIGN KEY ("brandId") REFERENCES "Brand"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Publication" ADD CONSTRAINT "Publication_variantId_fkey" FOREIGN KEY ("variantId") REFERENCES "ContentVariant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Publication" ADD CONSTRAINT "Publication_socialAccountId_fkey" FOREIGN KEY ("socialAccountId") REFERENCES "SocialAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AnalyticsSnapshot" ADD CONSTRAINT "AnalyticsSnapshot_publicationId_fkey" FOREIGN KEY ("publicationId") REFERENCES "Publication"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TrackedLink" ADD CONSTRAINT "TrackedLink_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TrackedLink" ADD CONSTRAINT "TrackedLink_brandId_fkey" FOREIGN KEY ("brandId") REFERENCES "Brand"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TrackedLink" ADD CONSTRAINT "TrackedLink_affiliateLinkId_fkey" FOREIGN KEY ("affiliateLinkId") REFERENCES "AffiliateLink"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TrackedLink" ADD CONSTRAINT "TrackedLink_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TrackedLink" ADD CONSTRAINT "TrackedLink_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "ContentProject"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Click" ADD CONSTRAINT "Click_trackedLinkId_fkey" FOREIGN KEY ("trackedLinkId") REFERENCES "TrackedLink"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Click" ADD CONSTRAINT "Click_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Click" ADD CONSTRAINT "Click_brandId_fkey" FOREIGN KEY ("brandId") REFERENCES "Brand"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Click" ADD CONSTRAINT "Click_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "ContentProject"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Click" ADD CONSTRAINT "Click_variantId_fkey" FOREIGN KEY ("variantId") REFERENCES "ContentVariant"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Click" ADD CONSTRAINT "Click_publicationId_fkey" FOREIGN KEY ("publicationId") REFERENCES "Publication"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Click" ADD CONSTRAINT "Click_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Conversion" ADD CONSTRAINT "Conversion_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Conversion" ADD CONSTRAINT "Conversion_brandId_fkey" FOREIGN KEY ("brandId") REFERENCES "Brand"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Conversion" ADD CONSTRAINT "Conversion_affiliateProgramId_fkey" FOREIGN KEY ("affiliateProgramId") REFERENCES "AffiliateProgram"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Conversion" ADD CONSTRAINT "Conversion_clickRefId_fkey" FOREIGN KEY ("clickRefId") REFERENCES "Click"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Conversion" ADD CONSTRAINT "Conversion_trackedLinkId_fkey" FOREIGN KEY ("trackedLinkId") REFERENCES "TrackedLink"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Conversion" ADD CONSTRAINT "Conversion_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Conversion" ADD CONSTRAINT "Conversion_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "ContentProject"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Conversion" ADD CONSTRAINT "Conversion_variantId_fkey" FOREIGN KEY ("variantId") REFERENCES "ContentVariant"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Conversion" ADD CONSTRAINT "Conversion_publicationId_fkey" FOREIGN KEY ("publicationId") REFERENCES "Publication"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RevenueEntry" ADD CONSTRAINT "RevenueEntry_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RevenueEntry" ADD CONSTRAINT "RevenueEntry_brandId_fkey" FOREIGN KEY ("brandId") REFERENCES "Brand"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RevenueEntry" ADD CONSTRAINT "RevenueEntry_conversionId_fkey" FOREIGN KEY ("conversionId") REFERENCES "Conversion"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RevenueEntry" ADD CONSTRAINT "RevenueEntry_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "ContentProject"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RevenueEntry" ADD CONSTRAINT "RevenueEntry_variantId_fkey" FOREIGN KEY ("variantId") REFERENCES "ContentVariant"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RevenueEntry" ADD CONSTRAINT "RevenueEntry_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Expense" ADD CONSTRAINT "Expense_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Expense" ADD CONSTRAINT "Expense_brandId_fkey" FOREIGN KEY ("brandId") REFERENCES "Brand"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProviderCredential" ADD CONSTRAINT "ProviderCredential_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
