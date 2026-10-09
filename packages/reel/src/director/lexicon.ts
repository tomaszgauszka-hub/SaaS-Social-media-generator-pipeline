import type { HookStrategy } from "../contracts/ids.ts";
import type { ProductFact } from "../contracts/product.ts";

/**
 * Native copy library for the template director and the template transcreation (pl, en, de, fr, es, it).
 *
 * Lines are written per language as a copywriter would write them — whole sentences, no word-by-word assembly
 * (Polish and German grammar does not survive string concatenation). Product claims come only from CONCEPTS,
 * and a concept is used only when the product's own facts contain it (`test`), so every claim carries the ids
 * of the facts that prove it. Emotional lines make no product claim and carry no fact ids.
 */

export const LANGS = ["pl", "en", "de", "fr", "es", "it"] as const;
export type Lang = (typeof LANGS)[number];
export type Lines = Record<Lang, string>;

/** pl-PL → pl; unknown languages → null (callers fall back to en with a warning) */
export function langOf(locale: string): Lang | null {
  const l = locale.slice(0, 2).toLowerCase();
  return (LANGS as readonly string[]).includes(l) ? (l as Lang) : null;
}

export type CategoryKey =
  "lighting" | "tools" | "electronics" | "beauty" | "home" | "kitchen" | "fashion" | "other";

/* ---------------------------------------------------------------- concepts (claims) ------------- */

export interface Concept {
  id: string;
  /** English summary for the ProductProfile (selling point / technical feature) */
  en: string;
  role: "selling" | "technical";
  /** all must match one fact's text (any source language) */
  test: RegExp[];
  /** full spoken / written sentence */
  line: Lines;
  /** on-screen overlay (≤ 32 chars) */
  short: Lines;
  /** hook for benefit_first / feature_reveal */
  hook?: Lines;
  /** what the studio should show for it */
  focus?: "whole" | "top" | "middle" | "base" | "detail";
  categories?: CategoryKey[];
}

export const CONCEPTS: Concept[] = [
  {
    id: "materials_walnut_brass_fabric",
    en: "Walnut base, brass stem and fabric shade",
    role: "selling",
    test: [
      /(walnut|walnuss|nogal|noyer|noce)/i,
      /(brass|messing|latón|laiton|ottone)/i,
      /(fabric|stoff|tela|tissu|tessuto)/i,
    ],
    line: {
      pl: "Orzechowa podstawa, mosiężny trzon i abażur z tkaniny.",
      en: "A walnut base, a brass stem and a fabric shade.",
      de: "Sockel aus Walnuss, Stange aus Messing, Schirm aus Stoff.",
      fr: "Un socle en noyer, une tige en laiton et un abat-jour en tissu.",
      es: "Base de nogal, poste de latón y pantalla de tela.",
      it: "Base in noce, stelo in ottone e paralume in tessuto.",
    },
    short: {
      pl: "Orzech · mosiądz · tkanina",
      en: "Walnut · brass · fabric",
      de: "Walnuss · Messing · Stoff",
      fr: "Noyer · laiton · tissu",
      es: "Nogal · latón · tela",
      it: "Noce · ottone · tessuto",
    },
    hook: {
      pl: "Orzech, mosiądz i tkanina w jednej lampie",
      en: "Walnut, brass and fabric in one lamp",
      de: "Walnuss, Messing und Stoff in einer Lampe",
      fr: "Noyer, laiton et tissu en une seule lampe",
      es: "Nogal, latón y tela en una sola lámpara",
      it: "Noce, ottone e tessuto in un'unica lampada",
    },
    focus: "whole",
    categories: ["lighting", "home"],
  },
  {
    id: "curved_brass_stem",
    en: "Slightly curved brass stem",
    role: "selling",
    test: [/(curved|gebogen|curvado|courbé|curvo)/i, /(brass|messing|latón|laiton|ottone)/i],
    line: {
      pl: "Lekko wygięty mosiężny trzon nadaje jej charakteru.",
      en: "A gently curved brass stem gives it character.",
      de: "Der leicht gebogene Messingstab gibt ihr Charakter.",
      fr: "Sa tige en laiton légèrement courbée lui donne du caractère.",
      es: "Su poste de latón ligeramente curvado le da carácter.",
      it: "Lo stelo in ottone leggermente curvo le dà carattere.",
    },
    short: {
      pl: "Lekko wygięty mosiężny trzon",
      en: "Gently curved brass stem",
      de: "Leicht gebogener Messingstab",
      fr: "Tige en laiton courbée",
      es: "Poste de latón curvado",
      it: "Stelo in ottone curvo",
    },
    hook: {
      pl: "Spójrz na ten wygięty mosiężny trzon",
      en: "Look at that curved brass stem",
      de: "Schau dir diesen gebogenen Messingstab an",
      fr: "Regardez cette tige en laiton courbée",
      es: "Mira ese poste de latón curvado",
      it: "Guarda questo stelo in ottone curvo",
    },
    focus: "middle",
    categories: ["lighting", "home"],
  },
  {
    id: "led_bulb_included",
    en: "LED bulb included",
    role: "selling",
    test: [/LED/i, /(included|inklusive|inclu[ií]d|inclus|fournie|inclusa|in dotazione)/i],
    line: {
      pl: "Żarówka LED jest w zestawie.",
      en: "The LED bulb is included.",
      de: "Das LED-Leuchtmittel ist schon dabei.",
      fr: "L'ampoule LED est fournie.",
      es: "La bombilla LED viene incluida.",
      it: "La lampadina LED è inclusa.",
    },
    short: {
      pl: "Żarówka LED w zestawie",
      en: "LED bulb included",
      de: "LED-Leuchtmittel inklusive",
      fr: "Ampoule LED fournie",
      es: "Bombilla LED incluida",
      it: "Lampadina LED inclusa",
    },
    categories: ["lighting"],
  },
  {
    id: "easy_assembly",
    en: "Easy assembly",
    role: "technical",
    test: [
      /(easy assembly|einfache montage|fácil de montar|montage facile|montaggio (semplice|facile)|facile da montare)/i,
    ],
    line: {
      pl: "A montaż jest prosty.",
      en: "And assembly is easy.",
      de: "Und die Montage ist einfach.",
      fr: "Et le montage est facile.",
      es: "Y es fácil de montar.",
      it: "E il montaggio è semplice.",
    },
    short: {
      pl: "Prosty montaż",
      en: "Easy assembly",
      de: "Einfache Montage",
      fr: "Montage facile",
      es: "Fácil de montar",
      it: "Montaggio semplice",
    },
  },
  {
    id: "mid_century_style",
    en: "Mid-century modern design that suits modern and industrial interiors",
    role: "selling",
    test: [/(mid-century|mitte des jahrhunderts|mediados de siglo|milieu du siècle|metà secolo)/i],
    line: {
      pl: "Styl mid-century, który pasuje do nowoczesnych i industrialnych wnętrz.",
      en: "Mid-century style that suits modern and industrial interiors.",
      de: "Mid-Century-Stil, der zu modernen und industriellen Räumen passt.",
      fr: "Un style mid-century qui s'accorde aux intérieurs modernes et industriels.",
      es: "Estilo mid-century que encaja en interiores modernos e industriales.",
      it: "Stile mid-century che si abbina a interni moderni e industriali.",
    },
    short: {
      pl: "Styl mid-century",
      en: "Mid-century style",
      de: "Mid-Century-Stil",
      fr: "Style mid-century",
      es: "Estilo mid-century",
      it: "Stile mid-century",
    },
    categories: ["lighting", "home"],
  },
  {
    id: "room_standout",
    en: "Stands out in living rooms and hallways",
    role: "selling",
    test: [/(stand out|hebt sich|destacará|se remarque|spicca|hallway|flur|pasillo)/i],
    line: {
      pl: "Wyróżni się w salonie i w przedpokoju.",
      en: "It stands out in a living room or hallway.",
      de: "Im Wohnzimmer oder Flur ein echter Blickfang.",
      fr: "Elle se remarque dans un salon ou une entrée.",
      es: "Destaca en un salón o en un pasillo.",
      it: "Spicca in soggiorno o nell'ingresso.",
    },
    short: {
      pl: "Do salonu i przedpokoju",
      en: "For living rooms and hallways",
      de: "Für Wohnzimmer und Flur",
      fr: "Pour salon et entrée",
      es: "Para salón y pasillo",
      it: "Per soggiorno e ingresso",
    },
    categories: ["lighting", "home"],
  },

  {
    id: "battery_included",
    en: "Battery included",
    role: "selling",
    test: [
      /(batter|akku|akumulator|batería|batteria)/i,
      /(included|inklusive|inclu[ií]d|inclus|w zestawie|incluse|in dotazione)/i,
    ],
    line: {
      pl: "Akumulator jest w zestawie.",
      en: "The battery is included.",
      de: "Der Akku ist schon dabei.",
      fr: "La batterie est fournie.",
      es: "La batería viene incluida.",
      it: "La batteria è inclusa.",
    },
    short: {
      pl: "Akumulator w zestawie",
      en: "Battery included",
      de: "Akku inklusive",
      fr: "Batterie fournie",
      es: "Batería incluida",
      it: "Batteria inclusa",
    },
    categories: ["tools"],
  },
  {
    id: "charger_included",
    en: "Charger included",
    role: "technical",
    test: [
      /(charger|ladegerät|ładowark|cargador|chargeur|caricabatterie)/i,
      /(included|inklusive|inclu[ií]d|inclus|w zestawie|in dotazione)/i,
    ],
    line: {
      pl: "Ładowarka też jest w zestawie.",
      en: "The charger is included too.",
      de: "Das Ladegerät ist auch dabei.",
      fr: "Le chargeur est aussi fourni.",
      es: "El cargador también viene incluido.",
      it: "Anche il caricabatterie è incluso.",
    },
    short: {
      pl: "Ładowarka w zestawie",
      en: "Charger included",
      de: "Ladegerät inklusive",
      fr: "Chargeur fourni",
      es: "Cargador incluido",
      it: "Caricabatterie incluso",
    },
    categories: ["tools"],
  },
  {
    id: "led_work_light",
    en: "Built-in LED work light",
    role: "selling",
    test: [
      /LED/i,
      /(light|licht|światł|luz|lumière|luce)/i,
      /(work|arbeit|robocz|trabajo|travail|lavoro|drill|bohr|wiertark|wkrętark)/i,
    ],
    line: {
      pl: "Wbudowana dioda LED oświetla miejsce pracy.",
      en: "A built-in LED lights up your work.",
      de: "Eine eingebaute LED leuchtet den Arbeitsbereich aus.",
      fr: "Une LED intégrée éclaire la zone de travail.",
      es: "Un LED integrado ilumina la zona de trabajo.",
      it: "Un LED integrato illumina la zona di lavoro.",
    },
    short: {
      pl: "Podświetlenie LED",
      en: "LED work light",
      de: "LED-Arbeitslicht",
      fr: "Éclairage LED",
      es: "Luz LED de trabajo",
      it: "Luce LED di lavoro",
    },
    focus: "detail",
    categories: ["tools"],
  },
  {
    id: "keyless_chuck",
    en: "Keyless chuck",
    role: "technical",
    test: [/(keyless|schnellspann|beznarzędziow|sin llave|sans clé|autoserrante)/i],
    line: {
      pl: "Szybkozaciskowy uchwyt — bity zmieniasz bez klucza.",
      en: "A keyless chuck: swap bits without a key.",
      de: "Schnellspannbohrfutter: Bits ohne Schlüssel wechseln.",
      fr: "Mandrin sans clé : changez d'embout sans outil.",
      es: "Portabrocas sin llave: cambia la punta sin herramientas.",
      it: "Mandrino autoserrante: cambi la punta senza chiave.",
    },
    short: {
      pl: "Uchwyt bez klucza",
      en: "Keyless chuck",
      de: "Schnellspannfutter",
      fr: "Mandrin sans clé",
      es: "Portabrocas sin llave",
      it: "Mandrino autoserrante",
    },
    focus: "detail",
    categories: ["tools"],
  },
  {
    id: "carry_case",
    en: "Carry case included",
    role: "technical",
    test: [/(case|koffer|walizk|maletín|mallette|valigetta)/i],
    line: {
      pl: "Całość w poręcznej walizce.",
      en: "Everything comes in a carry case.",
      de: "Alles kommt in einem Koffer.",
      fr: "Le tout dans une mallette.",
      es: "Todo viene en un maletín.",
      it: "Il tutto in una valigetta.",
    },
    short: {
      pl: "Walizka w zestawie",
      en: "Carry case included",
      de: "Mit Koffer",
      fr: "Mallette fournie",
      es: "Maletín incluido",
      it: "Valigetta inclusa",
    },
    categories: ["tools"],
  },
];

/** Materials named in a "Metal+Wood+Fabric" style field, localized (generic products). */
export const MATERIAL_WORDS: Record<string, Lines> = {
  metal: { pl: "metal", en: "metal", de: "Metall", fr: "métal", es: "metal", it: "metallo" },
  wood: { pl: "drewno", en: "wood", de: "Holz", fr: "bois", es: "madera", it: "legno" },
  fabric: { pl: "tkanina", en: "fabric", de: "Stoff", fr: "tissu", es: "tela", it: "tessuto" },
  glass: { pl: "szkło", en: "glass", de: "Glas", fr: "verre", es: "vidrio", it: "vetro" },
  steel: { pl: "stal", en: "steel", de: "Stahl", fr: "acier", es: "acero", it: "acciaio" },
  aluminum: {
    pl: "aluminium",
    en: "aluminium",
    de: "Aluminium",
    fr: "aluminium",
    es: "aluminio",
    it: "alluminio",
  },
  plastic: {
    pl: "tworzywo",
    en: "plastic",
    de: "Kunststoff",
    fr: "plastique",
    es: "plástico",
    it: "plastica",
  },
  ceramic: { pl: "ceramika", en: "ceramic", de: "Keramik", fr: "céramique", es: "cerámica", it: "ceramica" },
  leather: { pl: "skóra", en: "leather", de: "Leder", fr: "cuir", es: "cuero", it: "pelle" },
  cotton: { pl: "bawełna", en: "cotton", de: "Baumwolle", fr: "coton", es: "algodón", it: "cotone" },
};

/** "Made of …" with a localized list (fallback when no richer material concept exists). */
export const MADE_OF: Record<Lang, (list: string) => string> = {
  pl: (l) => `Materiały: ${l}.`,
  en: (l) => `Made of ${l}.`,
  de: (l) => `Aus ${l}.`,
  fr: (l) => `En ${l}.`,
  es: (l) => `De ${l}.`,
  it: (l) => `In ${l}.`,
};
export const AND: Lines = { pl: "i", en: "and", de: "und", fr: "et", es: "y", it: "e" };

export interface MatchedConcept {
  concept: Concept;
  factIds: string[];
}

/** Concepts the product's facts actually support (in library order), with the fact ids that prove them. */
export function detectConcepts(facts: readonly ProductFact[], category: CategoryKey): MatchedConcept[] {
  const out: MatchedConcept[] = [];
  for (const c of CONCEPTS) {
    if (c.categories && !c.categories.includes(category)) continue;
    const ids = facts.filter((f) => c.test.every((re) => re.test(f.text))).map((f) => f.id);
    if (ids.length) out.push({ concept: c, factIds: ids });
  }
  return out;
}

/** Prefer the fact written in the copy's language, then en-US, then any (max 2). */
export function factIdsFor(ids: readonly string[], facts: readonly ProductFact[], locale: string): string[] {
  const byId = new Map(facts.map((f) => [f.id, f]));
  const lang = locale.slice(0, 2);
  const score = (id: string) => {
    // facts handed to directors may carry no locale: ids like "bp.de-DE.2" / "color.en-US" still tell it
    const l = byId.get(id)?.locale ?? /\.([a-z]{2}-[A-Z]{2})(\.|$)/.exec(id)?.[1] ?? "en-US";
    return l === locale ? 0 : l.startsWith(lang) ? 1 : l === "en-US" ? 2 : 3;
  };
  return [...ids].sort((a, b) => score(a) - score(b) || a.localeCompare(b)).slice(0, 2);
}

/* ---------------------------------------------------------------- hooks ------------------------- */

export interface HookTemplate {
  /** category-specific lines (lamps, tools …); `generic` otherwise */
  byCategory?: Partial<Record<CategoryKey, Lines>>;
  generic: Lines;
  /** facts the strategy needs before it may be used (none = always applicable) */
  requires?: "price" | "rating" | "performance" | "comparison" | "visual_contrast" | "concept";
}

export const HOOKS: Record<HookStrategy, HookTemplate> = {
  visual_surprise: {
    byCategory: {
      lighting: {
        pl: "Poczekaj, aż się zaświeci",
        en: "Wait till it lights up",
        de: "Warte, bis sie leuchtet",
        fr: "Attendez qu'elle s'allume",
        es: "Espera a que se encienda",
        it: "Aspetta che si accenda",
      },
      tools: {
        pl: "Zobacz, co potrafi",
        en: "Watch what it can do",
        de: "Sieh, was er kann",
        fr: "Regardez ce qu'elle sait faire",
        es: "Mira lo que puede hacer",
        it: "Guarda cosa sa fare",
      },
    },
    generic: {
      pl: "Tego się nie spodziewasz",
      en: "You won't see this coming",
      de: "Damit rechnest du nicht",
      fr: "Vous ne vous y attendez pas",
      es: "No te lo esperas",
      it: "Non te lo aspetti",
    },
  },
  before_after: {
    requires: "visual_contrast",
    byCategory: {
      lighting: {
        pl: "Ten sam kąt. Jedna lampa.",
        en: "Same corner. One lamp.",
        de: "Gleiche Ecke. Eine Lampe.",
        fr: "Même coin. Une lampe.",
        es: "Mismo rincón. Una lámpara.",
        it: "Stesso angolo. Una lampada.",
      },
    },
    generic: {
      pl: "Przed i po. Zobacz sam.",
      en: "Before and after. See for yourself.",
      de: "Vorher, nachher. Sieh selbst.",
      fr: "Avant, après. Jugez vous-même.",
      es: "Antes y después. Míralo tú.",
      it: "Prima e dopo. Guarda tu.",
    },
  },
  problem_hook: {
    byCategory: {
      lighting: {
        pl: "Wieczorem w salonie zbyt ponuro?",
        en: "Living room too gloomy at night?",
        de: "Abends zu trist im Wohnzimmer?",
        fr: "Salon trop terne le soir ?",
        es: "¿Salón demasiado apagado de noche?",
        it: "Soggiorno troppo spento la sera?",
      },
      tools: {
        pl: "Śruby, które nie chcą wejść?",
        en: "Screws that just won't go in?",
        de: "Schrauben, die nicht reingehen?",
        fr: "Des vis qui résistent ?",
        es: "¿Tornillos que no entran?",
        it: "Viti che non entrano?",
      },
    },
    generic: {
      pl: "Masz dość kompromisów?",
      en: "Tired of settling?",
      de: "Genug von Kompromissen?",
      fr: "Marre des compromis ?",
      es: "¿Harto de conformarte?",
      it: "Stanco di accontentarti?",
    },
  },
  pain_point: {
    byCategory: {
      lighting: {
        pl: "Nudna lampa gasi cały pokój",
        en: "A dull lamp dims the whole room",
        de: "Eine fade Lampe macht den Raum fad",
        fr: "Une lampe banale éteint la pièce",
        es: "Una lámpara aburrida apaga la sala",
        it: "Una lampada anonima spegne la stanza",
      },
      tools: {
        pl: "Ręczne wkręcanie to strata czasu",
        en: "Driving screws by hand wastes time",
        de: "Von Hand schrauben kostet Zeit",
        fr: "Visser à la main fait perdre du temps",
        es: "Atornillar a mano es perder tiempo",
        it: "Avvitare a mano fa perdere tempo",
      },
    },
    generic: {
      pl: "Koniec z bylejakością",
      en: "No more settling for less",
      de: "Schluss mit Mittelmaß",
      fr: "Fini le médiocre",
      es: "Se acabó conformarse",
      it: "Basta accontentarsi",
    },
  },
  question: {
    byCategory: {
      lighting: {
        pl: "Szukasz lampy z charakterem?",
        en: "Looking for a lamp with character?",
        de: "Suchst du eine Lampe mit Charakter?",
        fr: "Envie d'une lampe qui a du caractère ?",
        es: "¿Buscas una lámpara con carácter?",
        it: "Cerchi una lampada con carattere?",
      },
      tools: {
        pl: "Szukasz narzędzia na lata?",
        en: "Looking for a tool that lasts?",
        de: "Suchst du Werkzeug für Jahre?",
        fr: "Un outil qui dure, ça vous dit ?",
        es: "¿Buscas una herramienta para años?",
        it: "Cerchi un attrezzo che duri?",
      },
    },
    generic: {
      pl: "Szukasz czegoś z charakterem?",
      en: "Looking for something with character?",
      de: "Suchst du etwas mit Charakter?",
      fr: "Envie de quelque chose qui a du caractère ?",
      es: "¿Buscas algo con carácter?",
      it: "Cerchi qualcosa con carattere?",
    },
  },
  benefit_first: { requires: "concept", generic: { pl: "", en: "", de: "", fr: "", es: "", it: "" } },
  feature_reveal: { requires: "concept", generic: { pl: "", en: "", de: "", fr: "", es: "", it: "" } },
  curiosity: {
    generic: {
      pl: "Ten jeden detal robi różnicę",
      en: "One detail makes all the difference",
      de: "Ein Detail macht den Unterschied",
      fr: "Un détail fait toute la différence",
      es: "Un detalle marca la diferencia",
      it: "Un dettaglio fa la differenza",
    },
  },
  comparison: {
    requires: "comparison",
    generic: {
      pl: "Zobacz różnicę",
      en: "See the difference",
      de: "Sieh den Unterschied",
      fr: "Voyez la différence",
      es: "Mira la diferencia",
      it: "Guarda la differenza",
    },
  },
  price_hook: {
    requires: "price",
    generic: {
      pl: "Tylko {price}",
      en: "Only {price}",
      de: "Nur {price}",
      fr: "Seulement {price}",
      es: "Solo {price}",
      it: "Solo {price}",
    },
  },
  social_proof: {
    requires: "rating",
    generic: {
      pl: "Ocena {rating}/5",
      en: "Rated {rating}/5",
      de: "Bewertet mit {rating}/5",
      fr: "Noté {rating}/5",
      es: "Valorado con {rating}/5",
      it: "Valutato {rating}/5",
    },
  },
  speed_demo: {
    requires: "performance",
    generic: {
      pl: "Zobacz, jak szybko to działa",
      en: "Watch how fast it works",
      de: "Sieh, wie schnell das geht",
      fr: "Regardez la vitesse",
      es: "Mira qué rápido funciona",
      it: "Guarda quanto è veloce",
    },
  },
};

/* ---------------------------------------------------------------- emotion, CTA, disclosure ------ */

/** DESIRE lines — emotional, no product claim (no fact ids). */
export const DESIRE: Record<"lighting" | "tools" | "generic", Lines> = {
  tools: {
    pl: "Narzędzie, po które sięgniesz przy każdym projekcie.",
    en: "The tool you'll reach for on every project.",
    de: "Das Werkzeug, zu dem du bei jedem Projekt greifst.",
    fr: "L'outil que vous prendrez pour chaque projet.",
    es: "La herramienta que usarás en cada proyecto.",
    it: "L'attrezzo che userai in ogni progetto.",
  },
  lighting: {
    pl: "Wieczór w zupełnie nowym świetle.",
    en: "Your evenings, in a whole new light.",
    de: "Deine Abende in ganz neuem Licht.",
    fr: "Vos soirées sous un jour nouveau.",
    es: "Tus noches, con otra luz.",
    it: "Le tue serate, in una nuova luce.",
  },
  generic: {
    pl: "Detal, który robi różnicę na co dzień.",
    en: "The detail that upgrades every day.",
    de: "Ein Detail, das den Alltag aufwertet.",
    fr: "Le détail qui change le quotidien.",
    es: "El detalle que mejora tu día a día.",
    it: "Il dettaglio che migliora ogni giorno.",
  },
};

export const CTA_TEXT: Lines = {
  pl: "Link w bio",
  en: "Link in bio",
  de: "Link in der Bio",
  fr: "Lien dans la bio",
  es: "Enlace en la bio",
  it: "Link nella bio",
};
export const CTA_VOICE: Lines = {
  pl: "Link znajdziesz w bio.",
  en: "Find the link in the bio.",
  de: "Den Link findest du in der Bio.",
  fr: "Le lien est dans la bio.",
  es: "Tienes el enlace en la bio.",
  it: "Trovi il link nella bio.",
};
export const CTA_BUTTON: Lines = {
  pl: "Sprawdź cenę",
  en: "Check the price",
  de: "Preis ansehen",
  fr: "Voir le prix",
  es: "Ver precio",
  it: "Vedi il prezzo",
};
export const DISCLOSURE: Lines = {
  pl: "Reklama · link afiliacyjny",
  en: "Ad · affiliate link",
  de: "Werbung · Affiliate-Link",
  fr: "Publicité · lien affilié",
  es: "Publicidad · enlace de afiliado",
  it: "Pubblicità · link affiliato",
};

/** Number formatting per language (decimal comma in pl/de/fr/es/it). */
export function formatNumber(n: number, lang: Lang): string {
  const s = Number.isInteger(n) ? String(n) : n.toFixed(1);
  return lang === "en" ? s : s.replace(".", ",");
}

/** "55 cm hoch" etc. — height of the product from a dimension fact (metric except en-US). */
export const HEIGHT_SHORT: Record<Lang, (v: string, unit: string) => string> = {
  pl: (v, u) => `${v} ${u} wysokości`,
  en: (v, u) => `${v} ${u} tall`,
  de: (v, u) => `${v} ${u} hoch`,
  fr: (v, u) => `${v} ${u} de haut`,
  es: (v, u) => `${v} ${u} de alto`,
  it: (v, u) => `${v} ${u} di altezza`,
};
