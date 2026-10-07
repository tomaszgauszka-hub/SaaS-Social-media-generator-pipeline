import {
  resolveFromRoot,
  resolveModelCatalog,
  resolveProviderSelection,
  type Env,
  type ModelCatalog,
  type ProviderSelection,
} from "@cre/config";
import { FalClient } from "./fal/client.ts";
import { FalBackgroundRemovalProvider, FalImageProvider, FalVideoProvider } from "./fal/providers.ts";
import {
  LocalSpeechProvider,
  MockBackgroundRemovalProvider,
  MockImageProvider,
  MockVideoProvider,
  ProceduralMusicProvider,
} from "./mock/media.ts";
import { LocalStorageProvider } from "./storage/local.ts";
import { S3StorageProvider } from "./storage/s3.ts";
import type { StorageProvider } from "./storage/types.ts";
import { ElevenLabsTTSProvider, OpenAITTSProvider } from "./tts/remote.ts";
import type {
  BackgroundRemovalProvider,
  ImageProvider,
  MusicProvider,
  ProviderHealth,
  TTSProvider,
  VideoGenerationProvider,
} from "./types.ts";

/**
 * Configuration-driven provider construction — the only place that maps provider names to classes.
 * Nothing else in the codebase branches on "fal" / "openai" / "mock".
 */
export interface MediaProviders {
  selection: ProviderSelection;
  models: ModelCatalog;
  image: ImageProvider;
  video: VideoGenerationProvider;
  tts: TTSProvider;
  bgRemoval: BackgroundRemovalProvider;
  music: MusicProvider;
  storage: StorageProvider;
}

export function createStorageProvider(env: Env): StorageProvider {
  if (env.STORAGE_DRIVER === "s3") {
    if (!env.S3_BUCKET || !env.S3_ACCESS_KEY_ID || !env.S3_SECRET_ACCESS_KEY) {
      throw new Error("STORAGE_DRIVER=s3 requires S3_BUCKET, S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY");
    }
    return new S3StorageProvider({
      bucket: env.S3_BUCKET,
      region: env.S3_REGION,
      ...(env.S3_ENDPOINT ? { endpoint: env.S3_ENDPOINT } : {}),
      accessKeyId: env.S3_ACCESS_KEY_ID,
      secretAccessKey: env.S3_SECRET_ACCESS_KEY,
      forcePathStyle: env.S3_FORCE_PATH_STYLE,
      cacheDir: resolveFromRoot(".data/cache/s3"),
    });
  }
  return new LocalStorageProvider(resolveFromRoot(env.STORAGE_LOCAL_DIR));
}

export function createMediaProviders(
  env: Env,
  overrides: Partial<Omit<MediaProviders, "selection" | "models">> = {},
): MediaProviders {
  const selection = resolveProviderSelection(env);
  const models = resolveModelCatalog(env, selection);
  const mockOpts = { costMode: env.MOCK_COST_MODE, models };
  const fal = new FalClient({ apiKey: env.FAL_KEY });

  const image: ImageProvider =
    selection.image === "mock" ? new MockImageProvider(mockOpts) : new FalImageProvider(fal, models);
  const video: VideoGenerationProvider =
    selection.video === "mock" ? new MockVideoProvider(mockOpts) : new FalVideoProvider(fal, models);
  const bgRemoval: BackgroundRemovalProvider =
    selection.bgRemoval === "mock"
      ? new MockBackgroundRemovalProvider(mockOpts)
      : new FalBackgroundRemovalProvider(fal, models.bgRemoval);
  let tts: TTSProvider;
  switch (selection.tts) {
    case "mock":
      tts = new LocalSpeechProvider({ ...mockOpts, mode: "mock" });
      break;
    case "flite":
      tts = new LocalSpeechProvider({ ...mockOpts, mode: "flite" });
      break;
    case "openai":
      tts = new OpenAITTSProvider({
        apiKey: env.OPENAI_API_KEY,
        baseUrl: env.OPENAI_BASE_URL,
        model: models.tts,
      });
      break;
    case "elevenlabs":
      tts = new ElevenLabsTTSProvider({
        apiKey: env.ELEVENLABS_API_KEY,
        voiceId: env.ELEVENLABS_VOICE_ID,
        model: models.tts,
      });
      break;
  }

  return {
    selection,
    models,
    image: overrides.image ?? image,
    video: overrides.video ?? video,
    tts: overrides.tts ?? tts,
    bgRemoval: overrides.bgRemoval ?? bgRemoval,
    music: overrides.music ?? new ProceduralMusicProvider(),
    storage: overrides.storage ?? createStorageProvider(env),
  };
}

export async function checkMediaProviders(p: MediaProviders): Promise<ProviderHealth[]> {
  return Promise.all([
    p.image.healthCheck(),
    p.video.healthCheck(),
    p.tts.healthCheck(),
    p.bgRemoval.healthCheck(),
    p.music.healthCheck(),
    p.storage.healthCheck(),
  ]);
}
