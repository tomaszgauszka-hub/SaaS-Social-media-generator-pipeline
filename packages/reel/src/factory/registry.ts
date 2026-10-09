import type { Env } from "@cre/config";
import type { GoogleAI } from "@cre/providers";
import type { Logger } from "@cre/shared";
import { DeterministicProductAnalyzer, GeminiProductAnalyzer } from "../analysis/index.ts";
import {
  CachedMusicProvider,
  CachedSfxProvider,
  ElevenLabsSfxProvider,
  ElevenLabsVoiceProvider,
  FliteVoiceProvider,
  LocalMusicProvider,
  LocalSfxProvider,
  PiperVoiceProvider,
} from "../audio/index.ts";
import type {
  DirectorProvider,
  EmbeddingProvider,
  GenerativeVideoProvider,
  ImageGenProvider,
  MusicProvider,
  ProductAnalyzer,
  SfxProvider,
  TranscreationProvider,
  TranscriptionProvider,
  VisualQaProvider,
  VoiceProvider,
} from "../capabilities/types.ts";
import type { Capability } from "../contracts/ids.ts";
import type { ReelJob } from "../contracts/job.ts";
import type { TierProfile } from "../contracts/profiles.ts";
import { GeminiDirector, TemplateDirector } from "../director/index.ts";
import { GeminiTranscreation, TemplateTranscreation } from "../localize/index.ts";
import { createGoogleProviders } from "../providers/google/index.ts";
import { DeterministicVisualQaProvider, GeminiVisualQaProvider } from "../qa/index.ts";
import type { ReelTools } from "../util/tools.ts";

/**
 * Capability chains for one job, ordered by the hierarchy CACHE → LOCAL → CHEAP API → LLM → GENERATION, and
 * trimmed by the quality tier (ECONOMY never reaches an API; PREMIUM may use premium voices / API SFX).
 * Every chain ends in a local provider, so a missing key or an exhausted budget makes a reel cheaper, never
 * impossible. `forceProviders` (ops / tests) moves a named provider to the head of its chain.
 */
export interface ProviderRegistry {
  analysis: ProductAnalyzer[];
  director: DirectorProvider[];
  transcreation: TranscreationProvider[];
  music: MusicProvider[];
  voice: VoiceProvider[];
  transcription: TranscriptionProvider[];
  sfx: SfxProvider[];
  visualQa: VisualQaProvider[];
  embedding: EmbeddingProvider[];
  image: ImageGenProvider[];
  video: GenerativeVideoProvider[];
  /** chain head per capability (plan.providers) */
  planned: Partial<Record<Capability, string>>;
  /** full ordered chain per capability (plan.fallbacks) */
  chains: Partial<Record<Capability, string[]>>;
}

function force<P extends { name: string }>(chain: P[], name: string | undefined): P[] {
  if (!name) return chain;
  const hit = chain.find((p) => p.name === name);
  return hit ? [hit, ...chain.filter((p) => p !== hit)] : chain;
}

export function buildRegistry(a: {
  env: Env;
  tier: TierProfile;
  googleAI: GoogleAI | null;
  tools: ReelTools;
  job: ReelJob;
  logger?: Logger;
}): ProviderRegistry {
  const { env, tier, googleAI } = a;
  const g = googleAI ? createGoogleProviders(env, googleAI) : null;
  const api = (want: boolean) => Boolean(googleAI) && want;

  const analysis: ProductAnalyzer[] = [
    ...(api(tier.productAnalysis === "llm")
      ? [new GeminiProductAnalyzer(googleAI!, env.GOOGLE_DIRECTOR_MODEL)]
      : []),
    new DeterministicProductAnalyzer(),
  ];
  const director: DirectorProvider[] = [
    ...(api(tier.director === "llm")
      ? [
          new GeminiDirector(googleAI!, env.GOOGLE_DIRECTOR_MODEL, "gemini"),
          new GeminiDirector(googleAI!, env.GOOGLE_DIRECTOR_FALLBACK_MODEL, "gemini-fallback"),
        ]
      : []),
    new TemplateDirector(),
  ];
  const transcreation: TranscreationProvider[] = [
    ...(api(tier.transcreation === "llm")
      ? [new GeminiTranscreation(googleAI!, env.GOOGLE_DIRECTOR_MODEL)]
      : []),
    new TemplateTranscreation(),
  ];
  const localMusic = new LocalMusicProvider();
  const music: MusicProvider[] = [
    new CachedMusicProvider({ cacheDir: a.tools.cacheDir }),
    ...(g && tier.music === "api" ? [g.music] : []),
    localMusic,
  ];
  const piper = new PiperVoiceProvider({ bin: a.tools.piperBin, voicesDir: a.tools.piperVoicesDir });
  const voice: VoiceProvider[] = [
    ...(g && (tier.voice === "api" || tier.voice === "premium") ? [g.cloudTts, g.geminiTts] : []),
    ...(tier.voice === "premium" ? [new ElevenLabsVoiceProvider(env)] : []),
    piper,
    new FliteVoiceProvider(),
  ];
  const transcription: TranscriptionProvider[] = g && tier.voice !== "local" ? [g.transcription] : [];
  const localSfx = new LocalSfxProvider();
  // cache (library hits only) → local synthesis (always works, cached itself) → ElevenLabs (PREMIUM, read-through)
  const sfx: SfxProvider[] = [
    new CachedSfxProvider(localSfx, { cacheDir: a.tools.cacheDir }),
    localSfx,
    ...(tier.sfx === "api"
      ? [
          new CachedSfxProvider(new ElevenLabsSfxProvider(env), {
            cacheDir: a.tools.cacheDir,
            readThrough: true,
          }),
        ]
      : []),
  ];
  const visualQa: VisualQaProvider[] = [
    ...(api(tier.visualQa === "ai")
      ? [new GeminiVisualQaProvider(googleAI!, env.GOOGLE_DIRECTOR_MODEL)]
      : []),
    new DeterministicVisualQaProvider(),
  ];
  const embedding: EmbeddingProvider[] = g && tier.tier !== "ECONOMY" ? [g.embeddingQuery] : [];
  const image: ImageGenProvider[] = g && tier.aiImages ? [g.image] : [];
  const video: GenerativeVideoProvider[] = g && tier.maxGenerativeVideoSeconds > 0 ? [g.video] : [];

  const fp = a.job.forceProviders;
  const reg = {
    analysis: force(analysis, fp.product_analysis),
    director: force(director, fp.director),
    transcreation: force(transcreation, fp.transcreation),
    music: force(music, fp.music),
    voice: force(voice, fp.voice),
    transcription: force(transcription, fp.transcription),
    sfx: force(sfx, fp.sfx),
    visualQa: force(visualQa, fp.visual_qa),
    embedding,
    image,
    video,
  };
  const chains: Partial<Record<Capability, string[]>> = {
    product_analysis: reg.analysis.map((p) => p.name),
    director: reg.director.map((p) => p.name),
    transcreation: reg.transcreation.map((p) => p.name),
    music: reg.music.map((p) => p.name),
    voice: reg.voice.map((p) => p.name),
    transcription: [...reg.transcription.map((p) => p.name), "local-alignment"],
    sfx: reg.sfx.map((p) => p.name),
    visual_qa: reg.visualQa.map((p) => p.name),
    embedding: reg.embedding.map((p) => p.name),
    image: reg.image.map((p) => p.name),
    generative_video: reg.video.map((p) => p.name),
    render_3d: ["blender"],
    compose: ["ffmpeg"],
  };
  const planned = Object.fromEntries(
    Object.entries(chains)
      .filter(([, c]) => c && c.length)
      .map(([k, c]) => [k, c[0]!]),
  ) as Partial<Record<Capability, string>>;
  return { ...reg, planned, chains };
}
