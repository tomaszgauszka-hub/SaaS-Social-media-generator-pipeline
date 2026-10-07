import fs from "node:fs";
import path from "node:path";
import { z } from "zod";

/**
 * Environment configuration. The single place where process.env is read.
 * Empty strings are treated as "unset" so `.env` files can list keys without values.
 */
const bool = (def: boolean) => z.stringbool().default(def);

export const EnvSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
  APP_URL: z.url().default("http://localhost:3000"),

  DATABASE_URL: z.string().min(1).default("postgresql://cre:cre@localhost:5432/cre"),
  DATABASE_URL_TEST: z.string().optional(),
  REDIS_URL: z.string().default("redis://localhost:6379"),

  MOCK_AI: bool(true),
  MOCK_MEDIA: bool(true),
  MOCK_SOCIAL: bool(true),
  MOCK_COST_MODE: z.enum(["simulate", "zero"]).default("simulate"),
  PUBLISHING_ENABLED: bool(false),
  HARD_DAILY_BUDGET_USD: z.coerce.number().nonnegative().default(5),

  CREDENTIALS_ENCRYPTION_KEY: z.string().optional(),
  TRACKING_HASH_SECRET: z.string().optional(),
  /** FX rates to USD for webhook conversions, e.g. "EUR=1.08,GBP=1.27" */
  FX_RATES_USD: z.string().optional(),
  SEED_OWNER_EMAIL: z.email().default("owner@example.com"),
  SEED_OWNER_PASSWORD: z.string().min(8).default("change-me-now"),

  LLM_PROVIDER: z.enum(["deepseek", "openai", "mock"]).default("deepseek"),
  DEEPSEEK_API_KEY: z.string().optional(),
  DEEPSEEK_BASE_URL: z.url().default("https://api.deepseek.com"),
  DEEPSEEK_MODEL: z.string().default("deepseek-chat"),
  OPENAI_API_KEY: z.string().optional(),
  OPENAI_BASE_URL: z.url().default("https://api.openai.com/v1"),
  OPENAI_MODEL: z.string().default("gpt-4o-mini"),

  IMAGE_PROVIDER: z.enum(["fal", "mock"]).default("fal"),
  VIDEO_PROVIDER: z.enum(["fal", "mock"]).default("fal"),
  BG_REMOVAL_PROVIDER: z.enum(["fal", "mock"]).default("fal"),
  TTS_PROVIDER: z.enum(["openai", "elevenlabs", "flite", "mock"]).default("openai"),
  FAL_KEY: z.string().optional(),
  ELEVENLABS_API_KEY: z.string().optional(),
  ELEVENLABS_VOICE_ID: z.string().optional(),
  IMAGE_MODEL_CHEAP: z.string().optional(),
  IMAGE_MODEL_STANDARD: z.string().optional(),
  IMAGE_MODEL_PREMIUM: z.string().optional(),
  VIDEO_MODEL_CHEAP: z.string().optional(),
  VIDEO_MODEL_STANDARD: z.string().optional(),
  VIDEO_MODEL_PREMIUM: z.string().optional(),

  STORAGE_DRIVER: z.enum(["local", "s3"]).default("local"),
  STORAGE_LOCAL_DIR: z.string().default(".data/storage"),
  S3_ENDPOINT: z.string().optional(),
  S3_REGION: z.string().default("auto"),
  S3_BUCKET: z.string().optional(),
  S3_ACCESS_KEY_ID: z.string().optional(),
  S3_SECRET_ACCESS_KEY: z.string().optional(),
  S3_FORCE_PATH_STYLE: bool(false),

  META_APP_ID: z.string().optional(),
  META_APP_SECRET: z.string().optional(),
  META_GRAPH_API_VERSION: z.string().default("v23.0"),
  TIKTOK_CLIENT_KEY: z.string().optional(),
  TIKTOK_CLIENT_SECRET: z.string().optional(),

  FFMPEG_PATH: z.string().default("ffmpeg"),
  FFPROBE_PATH: z.string().default("ffprobe"),
  RENDER_PRESET: z
    .enum(["ultrafast", "superfast", "veryfast", "faster", "fast", "medium", "slow", "slower", "veryslow"])
    .default("veryfast"),
  RENDER_CONCURRENCY: z.coerce.number().int().min(1).max(16).default(1),
  WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(64).default(4),
  DISPATCHER_POLL_MS: z.coerce.number().int().min(100).max(60_000).default(1000),
  WORK_DIR: z.string().default(".data/work"),
});

export type Env = z.infer<typeof EnvSchema>;

let cached: Env | undefined;
let rootDirCache: string | undefined;

/** Monorepo root = nearest ancestor containing pnpm-workspace.yaml (falls back to cwd). */
export function findRepoRoot(start = process.cwd()): string {
  if (rootDirCache) return rootDirCache;
  let dir = path.resolve(/*turbopackIgnore: true*/ start);
  for (;;) {
    if (fs.existsSync(/*turbopackIgnore: true*/ path.join(dir, "pnpm-workspace.yaml"))) {
      rootDirCache = dir;
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) return path.resolve(/*turbopackIgnore: true*/ start);
    dir = parent;
  }
}

/** Resolve a possibly-relative path against the repo root (not the process cwd). */
export function resolveFromRoot(p: string): string {
  return path.isAbsolute(p) ? p : path.join(/*turbopackIgnore: true*/ findRepoRoot(), p);
}

/**
 * Load `<repo root>/.env` into process.env (existing variables win — matches Node's --env-file semantics).
 * Safe to call multiple times.
 */
export function loadRootEnvFile(): void {
  const file = process.env.ENV_FILE ?? path.join(/*turbopackIgnore: true*/ findRepoRoot(), ".env");
  if (fs.existsSync(/*turbopackIgnore: true*/ file)) {
    try {
      process.loadEnvFile(file);
    } catch {
      // A malformed .env must not crash library imports; validation below reports missing values.
    }
  }
}

function blankToUndefined(
  source: Readonly<Record<string, string | undefined>>,
): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(source)) out[k] = v === undefined || v.trim() === "" ? undefined : v;
  return out;
}

export function parseEnv(source: NodeJS.ProcessEnv | Record<string, string | undefined>): Env {
  const result = EnvSchema.safeParse(blankToUndefined(source));
  if (!result.success) {
    const issues = result.error.issues.map((i) => `  - ${i.path.join(".")}: ${i.message}`).join("\n");
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  return result.data;
}

export function getEnv(): Env {
  if (!cached) {
    loadRootEnvFile();
    cached = parseEnv(process.env);
  }
  return cached;
}

/** Test helper: override env values for the current process. */
export function setEnvForTesting(overrides: Partial<Record<keyof Env, string>>): Env {
  loadRootEnvFile();
  cached = parseEnv({ ...process.env, ...overrides });
  return cached;
}

/** Parse FX_RATES_USD ("EUR=1.08,GBP=1.27") into { EUR: 1.08, GBP: 1.27 }. */
export function parseFxRates(value: string | undefined): Record<string, number> {
  const out: Record<string, number> = {};
  for (const part of (value ?? "").split(/[\s,;]+/)) {
    const [code, rate] = part.split("=");
    const n = Number(rate);
    if (code && /^[A-Za-z]{3}$/.test(code) && Number.isFinite(n) && n > 0) out[code.toUpperCase()] = n;
  }
  return out;
}

export function resetEnvCache(): void {
  cached = undefined;
}
