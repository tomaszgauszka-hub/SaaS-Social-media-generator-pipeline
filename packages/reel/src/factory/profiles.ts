import fs from "node:fs";
import { resolveFromRoot } from "@cre/config";
import { BrandProfile } from "../contracts/profiles.ts";

/** Loads a BrandProfile JSON (reusable across reels) and resolves its asset paths against the repo root. */
export function loadBrandProfile(file: string): BrandProfile {
  const raw: unknown = JSON.parse(fs.readFileSync(resolveFromRoot(file), "utf8"));
  const brand = BrandProfile.parse(raw);
  const abs = (p: string) => resolveFromRoot(p);
  const out: BrandProfile = {
    ...brand,
    fonts: {
      display: { ...brand.fonts.display, file: abs(brand.fonts.display.file) },
      body: { ...brand.fonts.body, file: abs(brand.fonts.body.file) },
      captions: { ...brand.fonts.captions, file: abs(brand.fonts.captions.file) },
    },
    ...(brand.logo ? { logo: { ...brand.logo, path: abs(brand.logo.path) } } : {}),
  };
  for (const f of [out.fonts.display.file, out.fonts.body.file, out.fonts.captions.file, out.logo?.path])
    if (f && !fs.existsSync(f)) throw new Error(`brand ${brand.brandId}: missing file ${f}`);
  return out;
}
