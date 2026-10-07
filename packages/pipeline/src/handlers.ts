import type { JobType } from "@cre/core";
import type { JobHandler } from "./job-types.ts";
import { analyticsCollectHandler, analyticsProfileHandler } from "./steps/analytics.ts";
import {
  ensureAssetsHandler,
  imageAssetHandler,
  musicAssetHandler,
  planAssetsHandler,
  productImageAssetHandler,
  ttsAssetHandler,
  videoAssetHandler,
} from "./steps/assets.ts";
import { ideationHandler } from "./steps/ideation.ts";
import { maintenanceTickHandler } from "./steps/maintenance.ts";
import { publishHandler } from "./steps/publish.ts";
import { qaHandler } from "./steps/qa.ts";
import { renderHandler } from "./steps/render.ts";
import { researchHandler } from "./steps/research.ts";
import { scriptHandler } from "./steps/script.ts";

export type HandlerMap = Partial<Record<JobType, JobHandler>>;

/** Job type → step executor. Every handler is idempotent: re-delivery of the same job is a no-op. */
export const HANDLERS: Record<JobType, JobHandler> = {
  "strategy.ideate": ideationHandler,
  "pipeline.research": researchHandler,
  "pipeline.script": scriptHandler,
  "pipeline.plan_assets": planAssetsHandler,
  "pipeline.assets": ensureAssetsHandler,
  "asset.image": imageAssetHandler,
  "asset.product_image": productImageAssetHandler,
  "asset.video": videoAssetHandler,
  "asset.tts": ttsAssetHandler,
  "asset.music": musicAssetHandler,
  "pipeline.render": renderHandler,
  "pipeline.qa": qaHandler,
  "publish.publication": publishHandler,
  "analytics.collect": analyticsCollectHandler,
  "analytics.profile": analyticsProfileHandler,
  "maintenance.tick": maintenanceTickHandler,
};
