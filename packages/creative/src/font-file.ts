import fs from "node:fs";
import * as fontkit from "fontkit";
import type { FontSpec } from "./model.ts";
import type { TextMeasurer } from "./text-fit.ts";

/**
 * Text measurer for arbitrary font FILES (brand fonts: TTF / OTF). Same shaping as FontkitMeasurer (kerning,
 * ligatures), but the face is chosen by `family|weight` from an explicit file map instead of the bundled
 * @fontsource subsets — so the layout is measured with exactly the file libass will draw.
 */
export class FileFontMeasurer implements TextMeasurer {
  private faces = new Map<string, fontkit.Font>();
  private widths = new Map<string, number>();

  /** files keyed by `${family}|${weight}`; the first entry of a family is the fallback for other weights */
  constructor(private readonly files: Record<string, string>) {}

  private face(spec: FontSpec): fontkit.Font {
    const key = `${spec.family}|${spec.weight}`;
    const file =
      this.files[key] ?? Object.entries(this.files).find(([k]) => k.startsWith(`${spec.family}|`))?.[1];
    if (!file) throw new Error(`no font file for ${spec.family} ${spec.weight}`);
    let face = this.faces.get(file);
    if (!face) {
      face = fontkit.create(fs.readFileSync(file)) as fontkit.Font;
      this.faces.set(file, face);
    }
    return face;
  }

  advanceEm(text: string, spec: FontSpec): number {
    const key = `${spec.family}|${spec.weight}|${text}`;
    const cached = this.widths.get(key);
    if (cached !== undefined) return cached;
    const face = this.face(spec);
    const w = face.layout(text).advanceWidth / face.unitsPerEm;
    this.widths.set(key, w);
    return w;
  }

  missingGlyphs(text: string, spec: FontSpec): string[] {
    const face = this.face(spec);
    const missing = new Set<string>();
    for (const ch of text) {
      if (/\s/.test(ch)) continue;
      if (!face.hasGlyphForCodePoint(ch.codePointAt(0)!)) missing.add(ch);
    }
    return [...missing];
  }
}
