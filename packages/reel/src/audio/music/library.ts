import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import type { CallContext, MusicProvider } from "../../capabilities/types.ts";
import { MusicGenre, MusicMood } from "../../contracts/ids.ts";
import type { MusicIntent } from "../../contracts/plan.ts";
import { cacheKey, FileCache, fileSha256 } from "../../util/cache.ts";
import { fitMusicToTimeline, MUSIC_FIT_VERSION } from "./fit.ts";
import { musicIntentKey } from "./local.ts";

/**
 * The "cached music" step: a local library of music the factory already has (API songs it paid for, licensed
 * tracks dropped in by an operator) under <cacheDir>/music/library. One JSON sidecar per track (no shared index →
 * no write races). A reel reuses a track of the same genre and mood within ±6 BPM: it is time-stretched to the
 * reel's BPM and fitted to the timeline (bar-aligned window, final hit aligned when possible).
 */

export const MUSIC_LIBRARY_PROVIDER = "music-library";
export const MUSIC_BPM_TOLERANCE = 6;

export interface MusicLibraryEntry {
  /** sha256 of the audio file (also its file name stem) */
  id: string;
  /** file name inside the library directory (never a path) */
  file: string;
  genre: MusicGenre;
  mood: MusicMood;
  bpm: number;
  durationMs: number;
  provider: string;
  model: string;
  license: string;
  commercialUse: boolean;
  addedAt: string;
}

const FILE_NAME = /^[a-f0-9]{16,64}\.[a-z0-9]{2,5}$/;

export class MusicLibrary {
  readonly dir: string;

  constructor(cacheDir: string) {
    this.dir = path.join(cacheDir, "music", "library");
  }

  /** copy a track into the library (idempotent: the same bytes are stored once) */
  async add(
    file: string,
    meta: Omit<MusicLibraryEntry, "id" | "file" | "addedAt">,
  ): Promise<MusicLibraryEntry> {
    const id = (await fileSha256(file)).slice(0, 32);
    const ext = (path.extname(file).slice(1).toLowerCase() || "wav").replace(/[^a-z0-9]/g, "").slice(0, 5);
    const entry: MusicLibraryEntry = {
      ...meta,
      genre: MusicGenre.parse(meta.genre),
      mood: MusicMood.parse(meta.mood),
      id,
      file: `${id}.${ext || "wav"}`,
      addedAt: new Date().toISOString(),
    };
    await fsp.mkdir(this.dir, { recursive: true });
    const target = path.join(this.dir, entry.file);
    if (!fs.existsSync(target)) {
      const tmp = `${target}.tmp-${process.pid}`;
      await fsp.copyFile(file, tmp);
      await fsp.rename(tmp, target);
    }
    const sidecar = path.join(this.dir, `${id}.json`);
    const tmpJson = `${sidecar}.tmp-${process.pid}`;
    await fsp.writeFile(tmpJson, JSON.stringify(entry, null, 1));
    await fsp.rename(tmpJson, sidecar);
    return entry;
  }

  /** valid entries whose audio file exists */
  async list(): Promise<MusicLibraryEntry[]> {
    let names: string[];
    try {
      names = await fsp.readdir(this.dir);
    } catch {
      return [];
    }
    const out: MusicLibraryEntry[] = [];
    for (const name of names.filter((n) => n.endsWith(".json")).sort()) {
      try {
        const e = JSON.parse(await fsp.readFile(path.join(this.dir, name), "utf8")) as MusicLibraryEntry;
        if (
          !FILE_NAME.test(e.file) ||
          !MusicGenre.safeParse(e.genre).success ||
          !MusicMood.safeParse(e.mood).success
        )
          continue;
        if (!(e.bpm > 0) || !fs.existsSync(path.join(this.dir, e.file))) continue;
        out.push(e);
      } catch {
        /* a broken sidecar is skipped */
      }
    }
    return out;
  }

  /** best match: same genre + mood, |Δbpm| ≤ 6; closest BPM, then a long-enough track, then the id */
  async find(
    intent: MusicIntent,
    opts: { requireCommercial?: boolean } = {},
  ): Promise<MusicLibraryEntry | undefined> {
    const all = await this.list();
    return all
      .filter(
        (e) =>
          e.genre === intent.genre &&
          e.mood === intent.mood &&
          Math.abs(e.bpm - intent.bpm) <= MUSIC_BPM_TOLERANCE &&
          (!(opts.requireCommercial ?? true) || e.commercialUse),
      )
      .sort(
        (a, b) =>
          Math.abs(a.bpm - intent.bpm) - Math.abs(b.bpm - intent.bpm) ||
          Number(b.durationMs >= intent.durationMs) - Number(a.durationMs >= intent.durationMs) ||
          a.id.localeCompare(b.id),
      )[0];
  }

  pathOf(entry: MusicLibraryEntry): string {
    if (!FILE_NAME.test(entry.file)) throw new Error(`music library: invalid file name ${entry.file}`);
    return path.join(this.dir, entry.file);
  }
}

/**
 * MusicProvider over the library. `available()` only says whether the library has any track; `compose` throws
 * when nothing matches the intent, so the chain moves on to the local composer / an API.
 */
export class CachedMusicProvider implements MusicProvider {
  readonly name = MUSIC_LIBRARY_PROVIDER;
  readonly capability = "music" as const;
  readonly local = true;
  readonly model = MUSIC_FIT_VERSION;
  readonly commercialUse: boolean;
  readonly library: MusicLibrary;

  constructor(opts: { cacheDir: string; allowNonCommercial?: boolean }) {
    this.library = new MusicLibrary(opts.cacheDir);
    this.commercialUse = !opts.allowNonCommercial;
  }

  available(): Promise<{ ok: boolean; reason?: string }> {
    const has =
      fs.existsSync(this.library.dir) && fs.readdirSync(this.library.dir).some((n) => n.endsWith(".json"));
    return Promise.resolve(has ? { ok: true } : { ok: false, reason: "music library is empty" });
  }

  estimateMicros(_intent: MusicIntent): number {
    return 0;
  }

  async compose(
    intent: MusicIntent,
    ctx: CallContext,
  ): Promise<{ path: string; durationMs: number; bpm: number; license: string; cached: boolean }> {
    const entry = await this.library.find(intent, { requireCommercial: this.commercialUse });
    if (!entry)
      throw new Error(
        `no library track for ${intent.genre}/${intent.mood} ${intent.bpm}±${MUSIC_BPM_TOLERANCE} bpm`,
      );
    const started = Date.now();
    const ns = "music.fit";
    const key = cacheKey(ns, MUSIC_FIT_VERSION, {
      track: entry.id,
      bpm: entry.bpm,
      intent: musicIntentKey(intent),
    });
    const res = await new FileCache(ctx.cacheDir).getOrCreate(ns, key, "music.wav", async (tmp) => {
      await fitMusicToTimeline(this.library.pathOf(entry), intent, intent.durationMs, {
        outPath: tmp,
        sourceBpm: entry.bpm,
        ...(ctx.signal ? { signal: ctx.signal } : {}),
      });
    });
    ctx.tracker.compute({
      stage: "ffmpeg",
      label: `music library fit ${entry.id.slice(0, 8)} → ${intent.durationMs} ms`,
      wallMs: Date.now() - started,
      cached: res.hit,
      scope: ctx.scope,
    });
    return {
      path: res.path,
      durationMs: intent.durationMs,
      bpm: intent.bpm,
      license: entry.license,
      cached: true,
    };
  }
}
