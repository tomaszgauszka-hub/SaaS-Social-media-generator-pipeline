import { createHash } from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import * as fontkit from "fontkit";
import { CreativeBrief, type CreativeBriefInput } from "./brief.ts";
import { directCreative, type DirectorOptions } from "./director.ts";
import type {
  CreativeStoryboard,
  FontAsset,
  FontSpec,
  LocalePack,
  RenderPlan,
  StyleTokens,
} from "./model.ts";
import { resolveRenderPlan, type ResolveIssue } from "./resolve.ts";
import { kitFontFaces } from "./style-kits.ts";
import type { TextMeasurer } from "./text-fit.ts";

/**
 * Node-only part of the Creative Engine: font files and measurement. The fonts are OFL-licensed `@fontsource`
 * packages; the same woff2 files are measured here and loaded by the renderer, which is why measurement and
 * rendering agree to <0.01 %.
 */
const require = createRequire(import.meta.url);

const SUBSET_ORDER = ["latin", "latin-ext", "greek", "greek-ext", "cyrillic", "cyrillic-ext", "vietnamese"];

export interface FontFile {
  family: string;
  weight: number;
  style: "normal" | "italic";
  subset: string;
  /** absolute path of the woff2 file */
  path: string;
  /** file name used by the renderer */
  file: string;
  unicodeRange: string;
}

const fontFileCache = new Map<string, FontFile[]>();

function familySlug(family: string): string {
  return family.toLowerCase().replace(/\s+/g, "-");
}

/** All subset files of one face, parsed from the fontsource CSS (latin first). */
export function fontFiles(spec: Pick<FontSpec, "family" | "weight" | "style">): FontFile[] {
  const key = `${spec.family}|${spec.weight}|${spec.style}`;
  const hit = fontFileCache.get(key);
  if (hit) return hit;
  const slug = familySlug(spec.family);
  let cssPath: string;
  try {
    cssPath = require.resolve(
      `@fontsource/${slug}/${spec.weight}${spec.style === "italic" ? "-italic" : ""}.css`,
    );
  } catch {
    throw new Error(
      `Font ${spec.family} ${spec.weight} ${spec.style} is not installed (@fontsource/${slug})`,
    );
  }
  const css = fs.readFileSync(cssPath, "utf8");
  const files: FontFile[] = [];
  for (const block of css.split("@font-face").slice(1)) {
    const url = /url\(\.\/files\/([^)]+?\.woff2)\)/.exec(block)?.[1];
    const range = /unicode-range:\s*([^;]+);/.exec(block)?.[1]?.trim();
    if (!url || !range) continue;
    const subset = url.replace(`${slug}-`, "").replace(/-\d+-(normal|italic)\.woff2$/, "");
    files.push({
      family: spec.family,
      weight: spec.weight,
      style: spec.style,
      subset,
      path: path.join(path.dirname(cssPath), "files", url),
      file: url,
      unicodeRange: range,
    });
  }
  files.sort((a, b) => rank(a.subset) - rank(b.subset));
  if (!files.length) throw new Error(`No font files found for ${key}`);
  fontFileCache.set(key, files);
  return files;
}

function rank(subset: string): number {
  const i = SUBSET_ORDER.indexOf(subset);
  return i === -1 ? SUBSET_ORDER.length : i;
}

interface LoadedFace {
  subsets: fontkit.Font[];
}

/** Text measurer backed by fontkit (shaping incl. kerning and ligatures, like Chromium). */
export class FontkitMeasurer implements TextMeasurer {
  private faces = new Map<string, LoadedFace>();
  private widths = new Map<string, number>();

  private face(spec: FontSpec): LoadedFace {
    const key = `${spec.family}|${spec.weight}|${spec.style}`;
    let face = this.faces.get(key);
    if (!face) {
      face = {
        subsets: fontFiles(spec).map((f) => fontkit.create(fs.readFileSync(f.path)) as fontkit.Font),
      };
      this.faces.set(key, face);
    }
    return face;
  }

  advanceEm(text: string, spec: FontSpec): number {
    const key = `${spec.family}|${spec.weight}|${spec.style}|${text}`;
    const cached = this.widths.get(key);
    if (cached !== undefined) return cached;
    const face = this.face(spec);
    let total = 0;
    let run = "";
    let runFont: fontkit.Font | null = null;
    const flush = () => {
      if (run && runFont) total += runFont.layout(run).advanceWidth / runFont.unitsPerEm;
      run = "";
    };
    for (const ch of text) {
      const cp = ch.codePointAt(0)!;
      const font = face.subsets.find((f) => f.hasGlyphForCodePoint(cp)) ?? face.subsets[0]!;
      if (font !== runFont) {
        flush();
        runFont = font;
      }
      run += ch;
    }
    flush();
    this.widths.set(key, total);
    return total;
  }

  missingGlyphs(text: string, spec: FontSpec): string[] {
    const face = this.face(spec);
    const missing = new Set<string>();
    for (const ch of text) {
      if (/\s/.test(ch)) continue;
      const cp = ch.codePointAt(0)!;
      if (!face.subsets.some((f) => f.hasGlyphForCodePoint(cp))) missing.add(ch);
    }
    return [...missing];
  }
}

const UI_FONT: FontSpec = {
  family: "Inter",
  weight: 700,
  style: "normal",
  letterSpacing: 0,
  transform: "none",
  lineHeight: 1.2,
};

/** Font assets for a style: what the renderer must load, plus the local files to serve. */
export function fontAssets(tokens: StyleTokens): { assets: FontAsset[]; files: FontFile[] } {
  const files: FontFile[] = [];
  const faces = kitFontFaces(tokens);
  // the burned-in DEMO label and the demo illustrations always use Inter 700
  if (
    !faces.some(
      (f) => f.family === UI_FONT.family && f.weight === UI_FONT.weight && f.style === UI_FONT.style,
    )
  )
    faces.push(UI_FONT);
  const assets: FontAsset[] = faces.map((f) => {
    const ff = fontFiles(f);
    files.push(...ff);
    return {
      family: f.family,
      weight: f.weight,
      style: f.style,
      files: ff.map((x) => ({ file: x.file, unicodeRange: x.unicodeRange })),
    };
  });
  return { assets, files };
}

/** Canonical JSON (sorted keys) → sha256 — stable across runs and machines. */
export function stableHash(value: unknown): string {
  return createHash("sha256").update(stableStringify(value)).digest("hex");
}

export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(",")}}`;
}

export interface PreparedCreative {
  brief: CreativeBrief;
  storyboard: CreativeStoryboard;
  localePack: LocalePack;
  plan: RenderPlan;
  issues: ResolveIssue[];
  fontFiles: FontFile[];
  storyboardHash: string;
  planHash: string;
}

const sharedMeasurer = new FontkitMeasurer();

/** Brief → storyboard → measured render plan, entirely local (no LLM, no network). */
export function prepareCreative(
  input: CreativeBriefInput,
  opts: DirectorOptions & {
    localePack?: LocalePack;
    mediaUrls?: Record<string, string>;
    measurer?: TextMeasurer;
  } = {},
): PreparedCreative {
  const brief = CreativeBrief.parse(input);
  const { storyboard, localePack } = directCreative(brief, opts);
  const pack = opts.localePack ?? localePack;
  const storyboardHash = stableHash(storyboard);
  const { assets, files } = fontAssets(storyboard.style);
  const { plan, issues } = resolveRenderPlan(storyboard, pack, opts.measurer ?? sharedMeasurer, {
    fonts: assets,
    storyboardHash,
    ...(opts.mediaUrls ? { mediaUrls: opts.mediaUrls } : {}),
  });
  return {
    brief,
    storyboard,
    localePack: pack,
    plan,
    issues,
    fontFiles: files,
    storyboardHash,
    planHash: stableHash(plan),
  };
}

export { FileFontMeasurer } from "./font-file.ts";
