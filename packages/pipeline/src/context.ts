import { createLlmProvider, type LLMProvider } from "@cre/ai";
import { getEnv, resolveFromRoot, VIDEO_DEFAULTS, type Env } from "@cre/config";
import { BudgetGuard, CostLedger } from "@cre/core";
import { getPrisma, type PrismaClient } from "@cre/db";
import { configureFfmpeg } from "@cre/media";
import { createMediaProviders, type MediaProviders } from "@cre/providers";
import {
  createSocialPublishers,
  MockSocialPublisher,
  type PublisherMap,
  type SocialPublisher,
} from "@cre/publishing";
import { createLogger, usdToMicros, type Logger } from "@cre/shared";

/** Injectable clock: the demo and tests fast-forward time to run scheduled publishing and analytics. */
export interface Clock {
  now(): Date;
}

export const systemClock: Clock = { now: () => new Date() };

export class ManualClock implements Clock {
  private t: number;

  constructor(start: Date = new Date()) {
    this.t = start.getTime();
  }

  now(): Date {
    return new Date(this.t);
  }

  set(date: Date): void {
    this.t = Math.max(this.t, date.getTime());
  }

  advance(ms: number): void {
    this.t += ms;
  }
}

export interface RenderSettings {
  width: number;
  height: number;
  fps: number;
  preset: string;
  oversample: number;
}

export interface PipelineContext {
  prisma: PrismaClient;
  env: Env;
  llm: LLMProvider;
  media: MediaProviders;
  publishers: PublisherMap;
  /** always available: accounts flagged isMock never reach a real platform */
  mockPublisher: SocialPublisher;
  guard: BudgetGuard;
  ledger: CostLedger;
  logger: Logger;
  clock: Clock;
  workRoot: string;
  cacheDir: string;
  render: RenderSettings;
}

export interface CreateContextOptions {
  env?: Env;
  prisma?: PrismaClient;
  llm?: LLMProvider;
  media?: MediaProviders;
  publishers?: PublisherMap;
  clock?: Clock;
  logger?: Logger;
  render?: Partial<RenderSettings>;
}

export function createPipelineContext(opts: CreateContextOptions = {}): PipelineContext {
  const env = opts.env ?? getEnv();
  configureFfmpeg({ ffmpegPath: env.FFMPEG_PATH, ffprobePath: env.FFPROBE_PATH });
  const prisma = opts.prisma ?? getPrisma();
  const logger = opts.logger ?? createLogger({ service: "pipeline", level: env.LOG_LEVEL });
  const clock = opts.clock ?? systemClock;
  const guard = new BudgetGuard(prisma, {
    hardDailyMicros: usdToMicros(env.HARD_DAILY_BUDGET_USD),
    now: () => clock.now(),
  });
  return {
    prisma,
    env,
    llm: opts.llm ?? createLlmProvider(env),
    media: opts.media ?? createMediaProviders(env),
    publishers: opts.publishers ?? createSocialPublishers(env),
    mockPublisher: new MockSocialPublisher(),
    guard,
    ledger: new CostLedger(guard, logger),
    logger,
    clock,
    workRoot: resolveFromRoot(env.WORK_DIR),
    cacheDir: resolveFromRoot(".data/cache"),
    render: {
      width: VIDEO_DEFAULTS.width,
      height: VIDEO_DEFAULTS.height,
      fps: VIDEO_DEFAULTS.fps,
      preset: env.RENDER_PRESET,
      oversample: 2,
      ...opts.render,
    },
  };
}
