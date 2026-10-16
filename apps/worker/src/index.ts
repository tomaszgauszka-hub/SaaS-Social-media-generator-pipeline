/**
 * Background worker: outbox dispatcher + BullMQ processors + periodic maintenance tick.
 *   pnpm worker                       all queues in one process
 *   WORKER_QUEUES=render pnpm worker  only the render queue (scale heavy queues separately)
 */
import { getEnv, QUEUE_NAMES, type QueueName } from "@cre/config";
import os from "node:os";
import {
  BullMqDispatcher,
  createPipelineContext,
  PrismaAssetLibrary3D,
  renderStationHeartbeat,
} from "@cre/pipeline";
import { createRender3D } from "@cre/render3d";
import { checkMediaProviders } from "@cre/providers";
import { createLogger, errorMessage, setRootLogger } from "@cre/shared";

async function main() {
  const env = getEnv();
  const logger = createLogger({ service: "worker", level: env.LOG_LEVEL });
  setRootLogger(logger);
  const ctx = createPipelineContext({ env, logger });

  // Safety report first: what can cost money or post publicly?
  logger.info(
    {
      mockAi: env.MOCK_AI,
      mockMedia: env.MOCK_MEDIA,
      mockSocial: env.MOCK_SOCIAL,
      publishingEnabled: env.PUBLISHING_ENABLED,
      hardDailyBudgetUsd: env.HARD_DAILY_BUDGET_USD,
      llm: `${ctx.llm.name}${ctx.llm.isMock ? " (mock)" : ""}`,
      storage: ctx.media.storage.driver,
    },
    "worker configuration",
  );
  for (const h of await checkMediaProviders(ctx.media)) {
    if (h.ok) logger.info(h, "provider ready");
    else logger.warn(h, "provider not ready");
  }

  const requested = (process.env.WORKER_QUEUES ?? "")
    .split(",")
    .map((q) => q.trim())
    .filter(Boolean);
  const unknown = requested.filter((q) => !(QUEUE_NAMES as readonly string[]).includes(q));
  if (unknown.length) throw new Error(`Unknown queue(s) in WORKER_QUEUES: ${unknown.join(", ")}`);

  const dispatcher = new BullMqDispatcher(ctx, {
    redisUrl: env.REDIS_URL,
    concurrency: env.WORKER_CONCURRENCY,
    renderConcurrency: env.RENDER_CONCURRENCY,
    pollMs: env.DISPATCHER_POLL_MS,
    ...(requested.length ? { queues: requested as QueueName[] } : {}),
  });
  await dispatcher.start();

  // render-station heartbeat: the panel and the 3D router tell "station offline" from a failure
  const servesRender3d = !requested.length || requested.includes("render_3d");
  let heartbeat: NodeJS.Timeout | null = null;
  if (servesRender3d) {
    const r3d = createRender3D(env, {
      library: new PrismaAssetLibrary3D(ctx.prisma, ctx.media.storage, null),
      storage: ctx.media.storage,
    });
    const beat = async () => {
      try {
        const caps = await r3d.worker.capabilities(true);
        await renderStationHeartbeat(ctx.prisma, os.hostname(), caps, 0);
      } catch (err) {
        logger.warn({ err: errorMessage(err) }, "render-station heartbeat failed");
      }
    };
    await beat();
    heartbeat = setInterval(() => void beat(), 30_000);
    heartbeat.unref();
  }

  let stopping = false;
  const shutdown = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    logger.info({ signal }, "shutting down — finishing running jobs");
    try {
      if (heartbeat) clearInterval(heartbeat);
      await dispatcher.stop({ graceMs: 25_000 });
      await ctx.prisma.$disconnect();
    } catch (err) {
      logger.error({ err: errorMessage(err) }, "shutdown error");
    }
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
