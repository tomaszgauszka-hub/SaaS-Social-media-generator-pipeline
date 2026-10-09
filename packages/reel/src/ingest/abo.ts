import fs from "node:fs";
import path from "node:path";
import { ProductSource, type FactKind, type ProductFact, type ProductImage } from "../contracts/product.ts";
import { fileSha256 } from "../util/cache.ts";
import { decodeRaw } from "../util/raw.ts";

/**
 * Amazon Berkeley Objects (ABO, CC BY 4.0) listing → ProductSource. Every fact keeps its source field path and
 * language; derived facts (unit conversions) say which fact they were derived from, so a claim in any language
 * traces back to the catalog record.
 */

export const ABO_LICENSE = "CC BY 4.0";
export const ABO_ATTRIBUTION =
  "Amazon Berkeley Objects (ABO) dataset, CC BY 4.0 — https://amazon-berkeley-objects.s3.amazonaws.com/index.html";

interface AboText {
  language_tag?: string;
  value: string;
  standardized_values?: string[];
}
interface AboDim {
  unit: string;
  value: number;
}
interface AboListing {
  item_id: string;
  brand?: AboText[];
  item_name?: AboText[];
  bullet_point?: AboText[];
  color?: AboText[];
  material?: AboText[];
  finish_type?: AboText[];
  model_number?: { value: string }[];
  product_type?: { value: string }[];
  style?: AboText[];
  item_dimensions?: Record<string, AboDim & { normalized_value?: AboDim }>;
  item_weight?: (AboDim & { normalized_value?: AboDim })[];
  node?: { node_id: number; node_name: string }[];
}

/** en_US → en-US */
export const aboLocale = (tag: string | undefined) => (tag ?? "en_US").replace("_", "-");

const IN_TO_CM = 2.54;
const LB_TO_KG = 0.45359237;

/** Bullet kind by keyword (en / de / es / fr / it / pt); long descriptive bullets are "feature". */
export function classifyBullet(text: string): FactKind {
  const t = text.toLowerCase();
  if (text.length > 140) return "feature";
  if (
    /\d/.test(t) &&
    /(cm|mm|"|''|\bin\b|inch|zoll|pulgadas|durchmesser|diameter|diámetro|diamètre|höhe|alto|high|\bh\b)/.test(
      t,
    )
  )
    return "dimension";
  if (/(included|inklusive|inclu[ií]d|inclus|compris|in dotazione|inclusa)/.test(t)) return "included";
  if (/(assembly|montage|montagem|montar|montaggio|assemblage)/.test(t)) return "assembly";
  if (
    /(made of|aus |hecha de|feita de|en |in |walnut|walnuss|nogal|brass|messing|latón|fabric|stoff|tela|wood|holz|madera)/.test(
      t,
    ) &&
    /(walnut|walnuss|nogal|nogueira|noyer|noce|brass|messing|latón|latão|laiton|ottone|fabric|stoff|tela|tecido|tissu|tessuto|wood|holz|madera|metal|steel|stahl|glass|glas)/.test(
      t,
    )
  )
    return "material";
  if (
    /(indoor|innenbereich|interior|interno|hallway|flur|pasillo|corredor|living|wohnzimmer|sala|salon|soggiorno)/.test(
      t,
    )
  )
    return "usage";
  if (/(warranty|garantie|garantía|garanzia)/.test(t)) return "warranty";
  return "feature";
}

function firstValue(xs: AboText[] | undefined, locale = "en_US"): string | undefined {
  return xs?.find((x) => x.language_tag === locale)?.value ?? xs?.[0]?.value;
}

const round1 = (n: number) => Math.round(n * 10) / 10;

/** Image role: 0 = main; white-background photos = other (packshots); the rest = lifestyle. */
async function imageRole(file: string, index: number): Promise<ProductImage["role"]> {
  if (index === 0) return "main";
  try {
    const px = await decodeRaw(file, "scale=16:16:flags=area,format=gray");
    const border: number[] = [];
    for (let y = 0; y < 16; y++)
      for (let x = 0; x < 16; x++)
        if (x === 0 || y === 0 || x === 15 || y === 15) border.push(px[y * 16 + x] ?? 0);
    const white = border.filter((v) => v > 235).length / border.length;
    return white > 0.8 ? "other" : "lifestyle";
  } catch {
    return "other";
  }
}

export function factsFromListing(l: AboListing): ProductFact[] {
  const facts: ProductFact[] = [];
  const add = (f: Omit<ProductFact, "locale"> & { locale?: string }) => facts.push({ locale: "en-US", ...f });

  const dims = l.item_dimensions ?? {};
  for (const axis of ["height", "width", "length"] as const) {
    const d = dims[axis]?.normalized_value ?? dims[axis];
    if (!d || !Number.isFinite(d.value)) continue;
    const id = `dim.${axis}`;
    const inches = /inch/.test(d.unit) ? d.value : d.unit === "centimeters" ? d.value / IN_TO_CM : NaN;
    add({
      id,
      kind: "dimension",
      text: `${axis} ${d.value} ${d.unit}`,
      value: d.value,
      unit: d.unit === "inches" ? "in" : d.unit,
      source: `item_dimensions.${axis}`,
    });
    if (Number.isFinite(inches) && /inch/.test(d.unit))
      add({
        id: `${id}.cm`,
        kind: "dimension",
        text: `${axis} ${round1(inches * IN_TO_CM)} cm (converted from ${d.value} in, fact ${id})`,
        value: round1(inches * IN_TO_CM),
        unit: "cm",
        source: `derived:${id}`,
      });
  }
  const w = l.item_weight?.[0];
  if (w && Number.isFinite(w.value)) {
    add({
      id: "weight",
      kind: "weight",
      text: `weight ${w.value} ${w.unit}`,
      value: w.value,
      unit: w.unit === "pounds" ? "lb" : w.unit,
      source: "item_weight",
    });
    if (w.unit === "pounds")
      add({
        id: "weight.kg",
        kind: "weight",
        text: `weight ${round1(w.value * LB_TO_KG)} kg (converted, fact weight)`,
        value: round1(w.value * LB_TO_KG),
        unit: "kg",
        source: "derived:weight",
      });
  }
  for (const m of l.material ?? [])
    add({
      id: `material.${aboLocale(m.language_tag)}`,
      kind: "material",
      text: m.value,
      source: "material",
      locale: aboLocale(m.language_tag),
    });
  for (const c of l.color ?? []) {
    const loc = aboLocale(c.language_tag);
    if (!/^(en|de|es|fr|it|pl|pt)-/.test(loc)) continue;
    add({ id: `color.${loc}`, kind: "color", text: c.value, source: "color", locale: loc });
  }
  const finish = firstValue(l.finish_type);
  if (finish) add({ id: "finish", kind: "material", text: finish, source: "finish_type" });
  const brand = firstValue(l.brand);
  if (brand) add({ id: "brand", kind: "other", text: `brand ${brand}`, source: "brand" });
  const model = l.model_number?.[0]?.value;
  if (model)
    add({ id: "model_number", kind: "other", text: `model number ${model}`, source: "model_number" });
  for (const s of l.style ?? []) {
    const loc = aboLocale(s.language_tag);
    if (/^(en|de|es|fr|it|pl|pt)-/.test(loc))
      add({ id: `type.${loc}`, kind: "other", text: s.value, source: "style", locale: loc });
  }
  const perLocale = new Map<string, number>();
  for (const b of l.bullet_point ?? []) {
    const loc = aboLocale(b.language_tag);
    if (!/^(en|de|es|fr|it|pl|pt)-/.test(loc)) continue; // keep languages the copy library can verify
    const n = (perLocale.get(loc) ?? 0) + 1;
    perLocale.set(loc, n);
    add({
      id: `bp.${loc}.${n}`,
      kind: classifyBullet(b.value),
      text: b.value.slice(0, 600),
      source: `bullet_point[${loc}][${n - 1}]`,
      locale: loc,
    });
  }
  return facts;
}

export async function ingestAboProduct(dir: string): Promise<ProductSource> {
  const listing = JSON.parse(fs.readFileSync(path.join(dir, "listing.json"), "utf8")) as AboListing;
  const names: Record<string, string> = {};
  for (const n of listing.item_name ?? []) {
    const loc = aboLocale(n.language_tag);
    if (/^[a-z]{2}-[A-Z]{2}$/.test(loc)) names[loc] = n.value.slice(0, 300);
  }
  const imagesDir = path.join(dir, "images");
  const files = fs.existsSync(imagesDir)
    ? fs
        .readdirSync(imagesDir)
        .filter((f) => /\.(jpe?g|png|webp)$/i.test(f))
        .sort()
    : [];
  const images: ProductImage[] = [];
  for (const [i, f] of files.entries())
    images.push({
      path: path.join(imagesDir, f),
      role: await imageRole(path.join(imagesDir, f), i),
      license: ABO_LICENSE,
    });
  const modelPath = path.join(dir, "model.glb");
  const dims = listing.item_dimensions ?? {};
  const m = (axis: string) => {
    const d = dims[axis]?.normalized_value ?? dims[axis];
    return d && /inch/.test(d.unit) ? (d.value * IN_TO_CM) / 100 : undefined;
  };
  const [ex, ey, ez] = [m("width"), m("length"), m("height")];
  const node = listing.node?.[0]?.node_name;
  const colorEn = listing.color?.find((c) => c.language_tag === "en_US");
  return ProductSource.parse({
    id: listing.item_id,
    source: {
      kind: "abo",
      ref: `abo:${listing.item_id}`,
      license: ABO_LICENSE,
      attribution: ABO_ATTRIBUTION,
    },
    brand: firstValue(listing.brand) ?? "",
    names,
    category: node ? node.split("/").filter(Boolean).pop()! : (listing.product_type?.[0]?.value ?? "other"),
    ...(node ? { categoryPath: node } : {}),
    ...(listing.model_number?.[0]?.value ? { modelNumber: listing.model_number[0].value } : {}),
    ...(colorEn ? { color: { name: colorEn.value } } : {}),
    facts: factsFromListing(listing),
    images,
    ...(fs.existsSync(modelPath)
      ? {
          model3d: {
            path: modelPath,
            format: "glb",
            license: ABO_LICENSE,
            sha256: await fileSha256(modelPath),
            ...(ex && ey && ez ? { extentM: { x: ex, y: ey, z: ez } } : {}),
          },
        }
      : {}),
  });
}

/** A ProductSource stored as JSON (DB export, merchant feed adapter, hand-written test product). */
export function loadProductSourceJson(file: string): ProductSource {
  const raw = JSON.parse(fs.readFileSync(file, "utf8")) as ProductSource;
  const base = path.dirname(file);
  const abs = (p: string) => (path.isAbsolute(p) ? p : path.join(base, p));
  return ProductSource.parse({
    ...raw,
    images: (raw.images ?? []).map((i) => ({ ...i, path: abs(i.path) })),
    ...(raw.model3d ? { model3d: { ...raw.model3d, path: abs(raw.model3d.path) } } : {}),
  });
}
