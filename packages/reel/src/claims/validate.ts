import type { LocaleCopy } from "../contracts/plan.ts";
import type { ProductFact, ProductProfile, ProductSource } from "../contracts/product.ts";
import type { BrandProfile } from "../contracts/profiles.ts";
import { disclosureFor } from "../director/lexicon.ts";

/**
 * Claim validation: every word a viewer reads or hears must be supported by the product's own facts.
 * Blockers make the director / transcreation chain fall back to the next provider (ultimately the template,
 * whose claims come from fact-matched concepts only). Copy written by a model (`modelWritten`) gets no benefit
 * of the doubt: a number or a colour the facts do not contain is a blocker there, not a warning.
 */

export interface ClaimIssue {
  slot: string;
  severity: "blocker" | "major" | "minor";
  code: string;
  message: string;
}

/* ---------------------------------------------------------------- numbers ---------------------- */

type Dim = "length" | "weight" | "other";
const UNIT: Record<string, { dim: Dim; toBase: number }> = {
  mm: { dim: "length", toBase: 0.1 },
  cm: { dim: "length", toBase: 1 },
  m: { dim: "length", toBase: 100 },
  in: { dim: "length", toBase: 2.54 },
  inch: { dim: "length", toBase: 2.54 },
  inches: { dim: "length", toBase: 2.54 },
  zoll: { dim: "length", toBase: 2.54 },
  cali: { dim: "length", toBase: 2.54 },
  pulgadas: { dim: "length", toBase: 2.54 },
  '"': { dim: "length", toBase: 2.54 },
  "″": { dim: "length", toBase: 2.54 },
  "''": { dim: "length", toBase: 2.54 },
  g: { dim: "weight", toBase: 0.001 },
  kg: { dim: "weight", toBase: 1 },
  lb: { dim: "weight", toBase: 0.45359237 },
  lbs: { dim: "weight", toBase: 0.45359237 },
  pounds: { dim: "weight", toBase: 0.45359237 },
};

export interface Quantity {
  value: number;
  unit: string;
  dim: Dim;
  base: number;
}

const NUM_RE =
  /(\d+(?:[.,]\d+)?)\s*(mm|cm|m\b|inches|inch|in\b|zoll|cali|pulgadas|"|″|''|kg|g\b|lbs|lb|pounds|%|w\b|v\b|mah|h\b|min|ml|l\b)?/gi;

export function quantities(text: string): Quantity[] {
  const out: Quantity[] = [];
  for (const m of text.matchAll(NUM_RE)) {
    const value = Number(m[1]!.replace(",", "."));
    const unit = (m[2] ?? "").toLowerCase();
    const u = UNIT[unit];
    out.push({ value, unit, dim: u?.dim ?? "other", base: u ? value * u.toBase : value });
  }
  return out;
}

function factQuantities(f: ProductFact): Quantity[] {
  const q = quantities(f.text);
  if (f.value !== undefined) {
    const u = UNIT[(f.unit ?? "").toLowerCase()];
    q.push({
      value: f.value,
      unit: f.unit ?? "",
      dim: u?.dim ?? "other",
      base: u ? f.value * u.toBase : f.value,
    });
  }
  return q;
}

/** same dimension, within 3 % (or ±0.6 of the base unit for small rounded values) */
export function sameQuantity(a: Quantity, b: Quantity): boolean {
  if (a.dim !== b.dim) return false;
  if (a.dim === "other" && a.unit !== b.unit) return false;
  const tol = Math.max(Math.abs(b.base) * 0.03, a.dim === "other" ? 0 : 0.6);
  return Math.abs(a.base - b.base) <= tol;
}

/* ---------------------------------------------------------------- word lists ------------------- */

const PROMO =
  /(rabat|promocj|wyprzeda|zniżk|discount|\bsale\b|\bdeal\b|rabatt|angebot|reduziert|descuento|oferta|rebaja|promo|soldes|réduction|sconto|offerta|% ?off|-\d+ ?%|\d+ ?% (taniej|günstiger|off|de descuento|de réduction|di sconto))/i;
const CURRENCY = /(\d[\d.,]*\s?(zł|pln|€|eur|usd|\$|£|gbp|chf)|(\$|€|£)\s?\d)/i;
const WARRANTY = /(gwarancj|warranty|garantie|garantía|garanzia|rękojm)/i;
const CERTIFICATE = /(certyfik|certifi|zertifi|\bCE\b|\bTÜV\b|\bISO ?\d|atest|homologa)/i;
const REVIEWS =
  /(\d(?:[.,]\d)? ?(\/ ?5|gwiazd|stars|sterne|estrellas|étoiles|stelle)|recenzj|opinie klient|reviews?\b|bewertung|reseñ|avis client|recension|\brated\b|ocen[aiy]\b)/i;
/** a fact that really is a rating: kind "rating" or a numeric star / out-of-5 pattern (not the bare word "review") */
const RATING_FACT = /\d(?:[.,]\d)?\s?(\/\s?5|out of 5|stars?\b|sterne|gwiazd\w*|estrellas|étoiles|stelle)/i;
/** fabricated social proof and first-person experiences (no source fact can make them true for a reel) */
const SOCIAL_PROOF =
  /(customers? (love|rave|adore)|happy customers|loved by|thousands of (customers|buyers|people)|best-?sellers?|top seller|sold out|\bI('ve| have)? (used|tried|love|bought|own)\b|\bmy (new )?favou?rite\b|klienci (kochają|pokochali|uwielbiają)|zadowolon\w* klient|tysiące (klientów|osób)|hit sprzedaży|bestsel|używam (go|jej|tego) od|kocham (tę|ten|to)|kunden (lieben|sind begeistert)|zufriedene kunden|tausende (kunden|käufer)|verkaufsschlager|ich (liebe|nutze|benutze) (sie|ihn|es|diese)|clientes (encantados|felices|aman)|miles de (clientes|personas)|más vendid|me encanta|lo uso desde|clients (adorent|satisfaits|ravis)|des milliers de|meilleure vente|j'adore|je l'utilise|clienti (soddisfatti|amano|entusiasti)|migliaia di|più vendut|lo adoro|la adoro)/i;
const FREE_SHIPPING =
  /(free (shipping|delivery)|ships free|darmow\w* (dostaw|wysył)|bezpłatn\w* (dostaw|wysył)|kostenlose\w* (versand|lieferung)|versandkostenfrei|envío (gratis|gratuito)|livraison (gratuite|offerte)|spedizione gratuita|consegna gratuita)/i;
const URGENCY =
  /(today only|only today|limited (time|stock|offer|edition)|last (pieces|chance|items)|while stocks? lasts?|hurry|ends (soon|tonight)|tylko dziś|tylko dzisiaj|ostatnie sztuki|ograniczon\w* (ilość|ofert|czas)|pośpiesz|nur heute|solange der vorrat reicht|letzte (chance|stücke)|nur noch wenige|solo hoy|últimas unidades|por tiempo limitado|aujourd'hui seulement|dernières pièces|quantité limitée|stock limité|solo oggi|ultimi pezzi|tempo limitato)/i;

const ABSOLUTE: Record<string, { blocker: RegExp; minor: RegExp }> = {
  pl: {
    blocker: /(najlepsz|najtańsz|numer 1|nr 1|jedyn[aeyi] (taki|na rynku)|gwarantowan)/i,
    minor: /(zawsze|nigdy|idealn|perfekcyjn)/i,
  },
  en: {
    blocker: /(\bbest\b|cheapest|#1\b|number one|\bonly one\b|guaranteed)/i,
    minor: /(\balways\b|\bnever\b|perfect)/i,
  },
  de: {
    blocker: /(\bbeste|billigste|nummer 1|nr\. 1|einzige|garantiert)/i,
    minor: /(\bimmer\b|\bnie\b|perfekt)/i,
  },
  fr: {
    blocker: /(meilleur|moins cher|numéro 1|\bn°1|le seul|garanti)/i,
    minor: /(toujours|jamais|parfait)/i,
  },
  es: { blocker: /(\bmejor\b|más barat|número 1|\bel único|garantizad)/i, minor: /(siempre|nunca|perfect)/i },
  it: { blocker: /(migliore|più economic|numero 1|l'unic|garantit)/i, minor: /(sempre|\bmai\b|perfett)/i },
};

/** feature words per risk keyword (the profile lists risks as `do not claim "<keyword …>"`) */
const RISK_WORDS: Record<string, RegExp> = {
  dimmable: /(dimmable|ściemni|dimmbar|regulable en intensidad|variateur|dimmerabil)/i,
  smart: /(\bsmart\b|aplikacj|\bapp\b|\bapp-|wi-?fi|bluetooth|alexa)/i,
  touch: /(touch|dotyk|táctil|tactile|tattile)/i,
  remote: /(remote|pilot|fernbedienung|mando a distancia|télécommande|telecomando)/i,
  cordless:
    /(cordless|bezprzewod|akumulator|kabellos|\bakku|inalámbric|sans fil|senza fili|battery|bateri|batterie|batteria)/i,
  usb: /\busb\b/i,
  colour: /(rgb|colou?r-changing|zmienia kolor|farbwechsel|cambia de color|change de couleur|cambia colore)/i,
  adjustable:
    /(adjustable height|regulowan[aey] wysoko|höhenverstellbar|altura (ajustable|regulable)|réglable en hauteur|regolabile in altezza)/i,
  waterproof: /(waterproof|wodoodporn|wasserdicht|impermeable|étanche|impermeabil)/i,
  brushless: /(brushless|bezszczotk|bürstenlos|sin escobillas)/i,
  clinically: /(clinically|klinicznie|klinisch|clínicamente|cliniquement|clinicamente)/i,
  solid: /(solid wood|lite drewno|massivholz|madera maciza|bois massif|legno massello)/i,
  handmade: /(handmade|ręcznie robion|handgemacht|hecho a mano|fait main|fatto a mano)/i,
};

/** colour concepts across languages (a colour in copy must exist in the facts) */
const COLOURS: Record<string, RegExp> = {
  black: /(black|czarn|schwarz|negr[oa]|noir|ner[oa]\b)/i,
  white: /(white|biał|weiß|weiss|blanc|bianc)/i,
  red: /(\bred\b|czerwon|\brot\b|\broj[oa]|rouge|ross[oa])/i,
  blue: /(blue|niebiesk|\bblau|azul|bleu|\bblu\b)/i,
  green: /(green|zielon|\bgrün|verde|\bvert)/i,
  gold: /(\bgold|złot|dorad|doré|dorat)/i,
  silver: /(silver|srebrn|silber|platead|argent)/i,
  grey: /(gr[ae]y\b|szar|\bgrau|gris|grigi)/i,
  pink: /(pink|różow|\brosa\b|\brose\b)/i,
  yellow: /(yellow|żółt|\bgelb|amarill|jaune|giall)/i,
};

/* ---------------------------------------------------------------- validator -------------------- */

const LIMITS: Record<string, number> = {
  hook: 70,
  overlay: 60,
  voice: 140,
  cta: 48,
  button: 24,
  disclosure: 80,
  caption: 200,
};

export function validateCopy(
  copy: LocaleCopy,
  source: ProductSource,
  brand: Pick<BrandProfile, "forbiddenPhrases"> & Partial<Pick<BrandProfile, "disclosure">>,
  profile?: Pick<ProductProfile, "risks">,
  opts: { modelWritten?: boolean } = {},
): ClaimIssue[] {
  const issues: ClaimIssue[] = [];
  const strict = Boolean(opts.modelWritten);
  const ratingFact = source.facts.some((f) => f.kind === "rating" || RATING_FACT.test(f.text));
  const disclosure = brand.disclosure
    ? disclosureFor({ disclosure: brand.disclosure }, copy.locale)
    : undefined;
  const facts = new Map(source.facts.map((f) => [f.id, f]));
  const allText = source.facts.map((f) => f.text).join("\n");
  const lang = copy.locale.slice(0, 2);
  const hasKind = (ids: string[], kinds: string[]) =>
    ids.some((id) => kinds.includes(facts.get(id)?.kind ?? "")) ||
    (kinds.includes("price") && Boolean(source.price && ids.includes(source.price.factId)));
  const riskKeys = (profile?.risks ?? [])
    .map((r) => /"([^"]+)"/.exec(r)?.[1]?.toLowerCase() ?? "")
    .flatMap((r) => Object.keys(RISK_WORDS).filter((k) => r.includes(k.slice(0, 5))));

  for (const [slot, s] of Object.entries(copy.slots)) {
    const add = (severity: ClaimIssue["severity"], code: string, message: string) =>
      issues.push({ slot, severity, code, message: `${slot}: ${message}` });
    const text = s.text;
    if (s.kind === "disclosure") {
      // legal text: exactly what the brand configured for this locale (no model may reword it)
      if (disclosure && text.trim() !== disclosure)
        add("blocker", "disclosure_altered", `disclosure must read "${disclosure}", got "${text}"`);
      continue;
    }
    const unknown = s.factIds.filter((id) => !facts.has(id) && id !== source.price?.factId);
    if (unknown.length) add("blocker", "unknown_fact", `cites unknown facts ${unknown.join(", ")}`);

    // numbers must trace to facts (cited facts first)
    for (const q of quantities(text)) {
      const cited = s.factIds.flatMap((id) => (facts.get(id) ? factQuantities(facts.get(id)!) : []));
      if (cited.some((c) => sameQuantity(q, c))) continue;
      const anywhere = source.facts.flatMap(factQuantities).some((c) => sameQuantity(q, c));
      if (anywhere) add("major", "uncited_number", `"${q.value}${q.unit}" matches a fact that is not cited`);
      else
        add(
          q.unit || strict ? "blocker" : "major",
          "invented_number",
          `"${q.value}${q.unit ? ` ${q.unit}` : ""}" is not in the product facts`,
        );
    }
    if ((CURRENCY.test(text) || PROMO.test(text)) && !hasKind(s.factIds, ["price", "promotion"]))
      add("blocker", "unsupported_price", `price / promotion wording without a price fact: "${text}"`);
    if (WARRANTY.test(text) && !hasKind(s.factIds, ["warranty"]))
      add("blocker", "unsupported_warranty", "warranty claim without a warranty fact");
    if (CERTIFICATE.test(text) && !hasKind(s.factIds, ["certificate"]))
      add("blocker", "unsupported_certificate", "certificate claim without a certificate fact");
    if (REVIEWS.test(text) && !ratingFact)
      add("blocker", "unsupported_reviews", "rating / review claim without a rating fact");
    if (SOCIAL_PROOF.test(text))
      add("blocker", "social_proof", `testimonial / social-proof wording is never supported: "${text}"`);
    if (FREE_SHIPPING.test(text) && !hasKind(s.factIds, ["promotion"]))
      add(
        "blocker",
        "unsupported_shipping",
        `free shipping / delivery offer without a promotion fact: "${text}"`,
      );
    if (URGENCY.test(text) && !hasKind(s.factIds, ["promotion"]))
      add("blocker", "unsupported_urgency", `urgency / scarcity wording without a promotion fact: "${text}"`);
    for (const p of brand.forbiddenPhrases)
      if (p && text.toLowerCase().includes(p.toLowerCase()))
        add("blocker", "forbidden_phrase", `forbidden phrase "${p}"`);
    const abs = ABSOLUTE[lang];
    if (abs?.blocker.test(text)) add("blocker", "absolute_claim", `superlative / absolute claim: "${text}"`);
    else if (abs?.minor.test(text)) add("minor", "absolute_word", `absolute wording: "${text}"`);
    for (const [key, re] of Object.entries(RISK_WORDS)) {
      if (!re.test(text)) continue;
      if (riskKeys.includes(key) || !re.test(allText))
        add("blocker", "unsupported_feature", `"${key}" feature is not in the product facts`);
    }
    for (const [colour, re] of Object.entries(COLOURS))
      if (re.test(text) && !re.test(allText))
        add(strict ? "blocker" : "major", "color_mismatch", `mentions ${colour}, the product facts do not`);
    const limit = LIMITS[s.kind];
    if (limit && text.length > limit) add("minor", "too_long", `${text.length} > ${limit} characters`);
  }
  return issues;
}
