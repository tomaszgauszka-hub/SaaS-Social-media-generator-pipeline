import type React from "react";
import { num, str } from "../util.ts";
import { FONT, Lin, Rad, clamp01, scatter, useIds, type VectorProps } from "./shared.tsx";

/*
 * Mineral SPF 50 sun fluid — beauty benchmark artwork. Shot language: lit hero on stone, packaging macro, the
 * product in a morning vanity ritual, a mineral-filter diagram, a texture / application macro and a summer flat
 * lay. Depth comes from foreground layers, reflections, moving light and shadows — never a plain gradient card.
 */
const SERIF = "cre-Playfair-Display, 'Playfair Display', serif";
const INK = "#3B2A24";
const MUTED = "#8C6A58";

/* ---------------------------------------------------------------- the tube (600×1100, stands on its cap) */
export const SunTubeArt: React.FC<{ params: VectorProps["params"]; ms: number }> = ({ params }) => {
  const u = useIds();
  const sheen = num(params, "sheen", 0.25);
  const body = "M190,868 C190,700 172,320 156,112 L444,112 C428,320 410,700 410,868 Z";
  const sx = -260 + sheen * 760;
  return (
    <g>
      <defs>
        <Lin
          id={u.id("body")}
          x2={1}
          y2={0}
          stops={[
            [0, "#C9B3A0"],
            [0.12, "#E8DCCF"],
            [0.36, "#FBF7F2"],
            [0.6, "#F3EAE0"],
            [0.86, "#D9C8B7"],
            [1, "#BBA38D"],
          ]}
        />
        <Lin
          id={u.id("cap")}
          x2={1}
          y2={0}
          stops={[
            [0, "#6E3323"],
            [0.18, "#A85C42"],
            [0.4, "#E2A788"],
            [0.58, "#BE6D50"],
            [1, "#6A3021"],
          ]}
        />
        <Lin
          id={u.id("crimp")}
          stops={[
            [0, "#F2E9DF"],
            [1, "#DCCDBE"],
          ]}
        />
        <Rad
          id={u.id("badge")}
          cx={0.38}
          cy={0.32}
          r={0.75}
          stops={[
            [0, "#D48A6C"],
            [0.7, "#A85C42"],
            [1, "#8A4632"],
          ]}
        />
        <Lin
          id={u.id("sheen")}
          x2={1}
          y2={0}
          stops={[
            [0, "#FFFFFF", 0],
            [0.5, "#FFFFFF", 0.55],
            [1, "#FFFFFF", 0],
          ]}
        />
        <clipPath id={u.id("clip")}>
          <path d={body} />
        </clipPath>
      </defs>
      {/* cap */}
      <rect x={192} y={862} width={216} height={178} rx={24} fill={u.url("cap")} />
      {Array.from({ length: 8 }, (_, i) => (
        <rect key={i} x={196} y={896 + i * 15} width={208} height={2} fill="#000" opacity={0.1} />
      ))}
      <ellipse cx={300} cy={1036} rx={104} ry={8} fill="#000" opacity={0.18} />
      <rect x={214} y={872} width={18} height={150} rx={9} fill="#FFFFFF" opacity={0.28} />
      {/* body */}
      <path d={body} fill={u.url("body")} />
      <ellipse cx={300} cy={866} rx={112} ry={14} fill="#B59C87" opacity={0.6} />
      <g clipPath={u.url("clip")}>
        <path
          d="M196,860 C196,700 180,330 166,118 L190,118 C202,330 218,700 220,860 Z"
          fill="#FFFFFF"
          opacity={0.55}
        />
        <rect
          x={sx}
          y={60}
          width={150}
          height={900}
          fill={u.url("sheen")}
          transform={`skewX(-18)`}
          opacity={0.75}
        />
        {/* label */}
        <text
          x={300}
          y={298}
          textAnchor="middle"
          fontFamily={FONT}
          fontWeight={700}
          fontSize={19}
          letterSpacing={8}
          fill={MUTED}
        >
          MINERAL
        </text>
        <text
          x={300}
          y={372}
          textAnchor="middle"
          fontFamily={SERIF}
          fontStyle="italic"
          fontWeight={500}
          fontSize={54}
          fill={INK}
        >
          Sun Fluid
        </text>
        <line x1={250} y1={404} x2={350} y2={404} stroke="#A85C42" strokeWidth={2} />
        <circle cx={300} cy={520} r={74} fill={u.url("badge")} />
        <circle cx={300} cy={520} r={64} fill="none" stroke="#FFFFFF" strokeOpacity={0.45} strokeWidth={2} />
        <text
          x={300}
          y={497}
          textAnchor="middle"
          fontFamily={FONT}
          fontWeight={700}
          fontSize={22}
          letterSpacing={5}
          fill="#FFFFFF"
        >
          SPF
        </text>
        <text
          x={300}
          y={566}
          textAnchor="middle"
          fontFamily={FONT}
          fontWeight={700}
          fontSize={64}
          fill="#FFFFFF"
        >
          50
        </text>
        <text
          x={300}
          y={648}
          textAnchor="middle"
          fontFamily={FONT}
          fontWeight={700}
          fontSize={15}
          letterSpacing={2.5}
          fill={MUTED}
        >
          ZINC OXIDE FILTER
        </text>
        <text
          x={300}
          y={688}
          textAnchor="middle"
          fontFamily={FONT}
          fontWeight={700}
          fontSize={13}
          letterSpacing={2}
          fill="#A88C7A"
        >
          FRAGRANCE-FREE
        </text>
        <text
          x={300}
          y={712}
          textAnchor="middle"
          fontFamily={FONT}
          fontWeight={700}
          fontSize={13}
          letterSpacing={2}
          fill="#A88C7A"
        >
          50 ML
        </text>
      </g>
      {/* crimp seal */}
      <rect x={150} y={66} width={300} height={52} rx={6} fill={u.url("crimp")} />
      {Array.from({ length: 36 }, (_, i) => (
        <rect key={i} x={156 + i * 8} y={70} width={2} height={44} fill="#000" opacity={0.06} />
      ))}
      <rect x={150} y={66} width={300} height={5} rx={2} fill="#FFFFFF" opacity={0.6} />
    </g>
  );
};

export const SunTube: React.FC<VectorProps> = ({ params, ms }) => <SunTubeArt params={params} ms={ms} />;

/** places the tube (base of the cap at its anchor) in a scene */
const Tube: React.FC<{
  x: number;
  y: number;
  s: number;
  rotate?: number;
  params: VectorProps["params"];
  ms: number;
}> = ({ x, y, s, rotate = 0, params, ms }) => (
  <g transform={`translate(${x} ${y}) rotate(${rotate}) scale(${s}) translate(-300 -1040)`}>
    <SunTubeArt params={params} ms={ms} />
  </g>
);

/* ---------------------------------------------------------------- hero scenes: stone podium / hard summer shadows */
export const SunPodium: React.FC<VectorProps> = ({ params, ms }) => {
  const u = useIds();
  const variant = str(params, "variant", "podium");
  const sheen = num(params, "sheen", 0.3);
  const t = ms / 1000;
  if (variant === "shadow") {
    const sway = Math.sin(t * 0.9) * 2.2;
    return (
      <g>
        <defs>
          <Lin
            id={u.id("wall")}
            stops={[
              [0, "#EBCBA6"],
              [1, "#DDB48B"],
            ]}
          />
          <Lin
            id={u.id("floor")}
            stops={[
              [0, "#D9AE84"],
              [1, "#C99B70"],
            ]}
          />
          <Lin
            id={u.id("slab")}
            stops={[
              [0, "#F1E2D0"],
              [1, "#DCC5AC"],
            ]}
          />
          <Rad
            id={u.id("sun")}
            cx={0.78}
            cy={0.18}
            r={0.8}
            stops={[
              [0, "#FFF4DE", 0.75],
              [0.5, "#FFE9C8", 0.25],
              [1, "#FFE9C8", 0],
            ]}
          />
        </defs>
        <rect width={1080} height={1920} fill={u.url("wall")} />
        <rect y={1340} width={1080} height={580} fill={u.url("floor")} />
        <rect width={1080} height={1920} fill={u.url("sun")} />
        {/* palm frond shadows, swaying */}
        <g opacity={0.26} transform={`rotate(${sway} 980 -100)`}>
          {Array.from({ length: 9 }, (_, i) => {
            const a = -60 + i * 13;
            return (
              <path
                key={i}
                d="M0,0 C120,-26 300,-30 520,0 C300,30 120,26 0,0 Z"
                fill="#6E4628"
                transform={`translate(980 -100) rotate(${a + 90}) translate(140 0) scale(${1.4 - (i % 3) * 0.12} 1)`}
              />
            );
          })}
          <rect x={960} y={-100} width={26} height={900} fill="#6E4628" transform="rotate(28 973 -100)" />
        </g>
        {/* travertine slab */}
        <rect x={150} y={1330} width={780} height={130} rx={18} fill={u.url("slab")} />
        <rect x={150} y={1440} width={780} height={80} rx={14} fill="#CDB295" />
        {scatter(26, 170, 1345, 740, 100, 4).map((p, i) => (
          <ellipse key={i} cx={p.x} cy={p.y} rx={3 + p.k * 7} ry={2 + p.k * 2} fill="#C4A587" opacity={0.6} />
        ))}
        {/* cast shadow of the tube */}
        <path d="M600,1392 L1080,1250 L1080,1330 L640,1405 Z" fill="#5B3A22" opacity={0.28} />
        <ellipse cx={560} cy={1395} rx={110} ry={16} fill="#5B3A22" opacity={0.35} />
        <Tube x={560} y={1395} s={0.86} rotate={-5} params={{ ...params, sheen }} ms={ms} />
        {[0, 1, 2].map((k) => {
          const a = 0.5 + 0.5 * Math.sin(t * 3 + k * 2.1);
          const x = [470, 610, 520][k]!;
          const y = [1310, 1250, 760][k]!;
          return (
            <path
              key={k}
              d={`M${x},${y - 16} L${x + 4},${y - 4} L${x + 16},${y} L${x + 4},${y + 4} L${x},${y + 16} L${x - 4},${y + 4} L${x - 16},${y} L${x - 4},${y - 4} Z`}
              fill="#FFFFFF"
              opacity={a * 0.9}
            />
          );
        })}
      </g>
    );
  }
  const drift = Math.sin(t * 0.7);
  return (
    <g>
      <defs>
        <Lin
          id={u.id("bg")}
          stops={[
            [0, "#F2DDD0"],
            [1, "#E5C4B0"],
          ]}
        />
        <Lin
          id={u.id("arch")}
          stops={[
            [0, "#FBF1EA"],
            [1, "#F1DCCD"],
          ]}
        />
        <Lin
          id={u.id("stone")}
          x2={1}
          y2={0}
          stops={[
            [0, "#D5B9A6"],
            [0.3, "#EEDCCD"],
            [0.7, "#E4CBB8"],
            [1, "#C7A790"],
          ]}
        />
        <Lin
          id={u.id("top")}
          stops={[
            [0, "#F6EAE0"],
            [1, "#E6D0BF"],
          ]}
        />
        <Rad
          id={u.id("caustic")}
          stops={[
            [0, "#FFFFFF", 0.55],
            [1, "#FFFFFF", 0],
          ]}
        />
        <clipPath id={u.id("topclip")}>
          <ellipse cx={540} cy={1480} rx={270} ry={46} />
        </clipPath>
        <filter id={u.id("blur")} x="-20%" y="-20%" width="140%" height="140%">
          <feGaussianBlur stdDeviation="14" />
        </filter>
      </defs>
      <rect width={1080} height={1920} fill={u.url("bg")} />
      <path d="M220,1500 L220,560 A320,320 0 0 1 860,560 L860,1500 Z" fill={u.url("arch")} />
      <path
        d="M220,1500 L220,560 A320,320 0 0 1 860,560 L860,1500"
        fill="none"
        stroke="#E2C6B3"
        strokeWidth={4}
      />
      {/* moving caustic light inside the niche */}
      {[0, 1, 2, 3].map((k) => (
        <ellipse
          key={k}
          cx={420 + k * 90 + Math.sin(t * 0.8 + k) * 60}
          cy={760 + k * 110 + Math.cos(t * 0.6 + k) * 40}
          rx={170}
          ry={70}
          fill={u.url("caustic")}
          opacity={0.5}
          transform={`rotate(${-20 + k * 8} 540 900)`}
        />
      ))}
      <rect y={1500} width={1080} height={420} fill="#E0BFA9" />
      {/* back podium */}
      <rect x={690} y={1390} width={260} height={210} fill={u.url("stone")} />
      <ellipse cx={820} cy={1390} rx={130} ry={24} fill={u.url("top")} />
      {/* main podium */}
      <rect x={270} y={1480} width={540} height={250} fill={u.url("stone")} />
      <ellipse cx={540} cy={1730} rx={270} ry={46} fill="#BF9F88" />
      <ellipse cx={540} cy={1480} rx={270} ry={46} fill={u.url("top")} />
      {/* reflection of the tube on the polished top */}
      <g clipPath={u.url("topclip")} opacity={0.2}>
        <g transform="translate(0 2960) scale(1 -1)">
          <Tube x={540} y={1480} s={0.86} params={{ ...params, sheen }} ms={ms} />
        </g>
      </g>
      <ellipse cx={540} cy={1482} rx={118} ry={14} fill="#6B4434" opacity={0.25} />
      <Tube x={540} y={1480} s={0.86} params={{ ...params, sheen }} ms={ms} />
      {/* blurred foreground grass, parallax */}
      <g filter={u.url("blur")} opacity={0.85} transform={`translate(${drift * 26} 0)`}>
        {Array.from({ length: 7 }, (_, i) => (
          <path
            key={i}
            d={`M${-40 + i * 34},1960 C${10 + i * 40},1700 ${60 + i * 30},1560 ${120 + i * 26},${1380 + (i % 3) * 40}`}
            fill="none"
            stroke={i % 2 ? "#C9A27E" : "#B48C66"}
            strokeWidth={10}
            strokeLinecap="round"
          />
        ))}
      </g>
    </g>
  );
};

/* ---------------------------------------------------------------- morning vanity (1080×1920) */
export const SunVanity: React.FC<VectorProps> = ({ params, ms }) => {
  const u = useIds();
  const t = ms / 1000;
  const light = clamp01(num(params, "light", 1));
  const sheen = num(params, "sheen", 0.4);
  const leaf = (x: number, y: number, r: number, rot: number, c: string) => (
    <ellipse cx={x} cy={y} rx={r} ry={r * 0.72} fill={c} transform={`rotate(${rot} ${x} ${y})`} />
  );
  return (
    <g>
      <defs>
        <Lin
          id={u.id("wall")}
          stops={[
            [0, "#EEDFD0"],
            [1, "#E2CDB9"],
          ]}
        />
        <Lin
          id={u.id("marble")}
          stops={[
            [0, "#F7F3EE"],
            [1, "#EBE4DC"],
          ]}
        />
        <Lin
          id={u.id("wood")}
          stops={[
            [0, "#C99F79"],
            [1, "#B88C66"],
          ]}
        />
        <Lin
          id={u.id("mirror")}
          x1={0}
          y1={0}
          x2={1}
          y2={1}
          stops={[
            [0, "#F4F3EF"],
            [0.6, "#D9DCD8"],
            [1, "#C8CCC8"],
          ]}
        />
        <Lin
          id={u.id("brass")}
          x2={1}
          y2={0}
          stops={[
            [0, "#A8844F"],
            [0.5, "#E3C48C"],
            [1, "#9C7843"],
          ]}
        />
        <Lin
          id={u.id("vase")}
          x2={1}
          y2={0}
          stops={[
            [0, "#D9CDBE"],
            [0.4, "#F4EEE6"],
            [1, "#CDBFAE"],
          ]}
        />
        <filter id={u.id("blur")} x="-30%" y="-30%" width="160%" height="160%">
          <feGaussianBlur stdDeviation="18" />
        </filter>
        <clipPath id={u.id("tray")}>
          <ellipse cx={610} cy={1306} rx={176} ry={24} />
        </clipPath>
      </defs>
      <rect width={1080} height={1920} fill={u.url("wall")} />
      {Array.from({ length: 6 }, (_, r) => (
        <rect key={r} y={r * 240} width={1080} height={2} fill="#D6C1AC" opacity={0.6} />
      ))}
      {Array.from({ length: 4 }, (_, k) => (
        <rect key={k} x={k * 360 + (k % 2) * 180} width={2} height={1250} fill="#D6C1AC" opacity={0.4} />
      ))}
      {/* window light with mullion and leaf shadows */}
      <g opacity={0.55 * light}>
        <polygon points="40,180 520,120 600,1240 120,1250" fill="#FFF6E8" />
        <polygon points="300,150 330,146 412,1246 382,1247" fill="#E2CDB9" />
        <polygon points="72,700 556,640 566,672 82,732" fill="#E2CDB9" />
        {Array.from({ length: 10 }, (_, i) =>
          leaf(
            180 + (i % 5) * 70 + Math.sin(t + i) * 8,
            380 + Math.floor(i / 5) * 150 + (i % 2) * 40,
            34,
            i * 30,
            "#D8C2AC",
          ),
        )}
      </g>
      {/* round mirror */}
      <circle cx={910} cy={560} r={318} fill={u.url("brass")} />
      <circle cx={910} cy={560} r={300} fill={u.url("mirror")} />
      <path d="M700,420 L840,300 L1020,520 L880,640 Z" fill="#FFFFFF" opacity={0.28} />
      {/* eucalyptus in a vase */}
      {Array.from({ length: 5 }, (_, i) => (
        <path
          key={i}
          d={`M225,1060 C${200 + i * 20},${900 - i * 40} ${160 + i * 40},${760 - i * 20} ${140 + i * 50},${640 + (i % 2) * 60}`}
          fill="none"
          stroke="#7E8F78"
          strokeWidth={4}
        />
      ))}
      {Array.from({ length: 26 }, (_, i) =>
        leaf(150 + ((i * 37) % 200), 660 + ((i * 53) % 400), 22, i * 23, i % 2 ? "#97AC93" : "#8AA088"),
      )}
      <path
        d="M160,1060 C150,1150 170,1250 200,1270 L260,1270 C290,1250 310,1150 300,1060 Z"
        fill={u.url("vase")}
      />
      {/* countertop + cabinet */}
      <rect y={1250} width={1080} height={175} fill={u.url("marble")} />
      {[
        "M0,1300 C200,1290 300,1330 520,1310",
        "M560,1380 C700,1360 900,1400 1080,1370",
        "M100,1400 C240,1380 360,1410 480,1395",
      ].map((d) => (
        <path key={d} d={d} fill="none" stroke="#C9C0B6" strokeWidth={2} opacity={0.7} />
      ))}
      <rect y={1425} width={1080} height={55} fill="#E2DAD0" />
      <rect y={1480} width={1080} height={440} fill={u.url("wood")} />
      <rect x={530} y={1480} width={4} height={440} fill="#9C7552" />
      <rect x={470} y={1560} width={40} height={10} rx={5} fill={u.url("brass")} />
      <rect x={556} y={1560} width={40} height={10} rx={5} fill={u.url("brass")} />
      {/* towels */}
      <rect x={770} y={1180} width={230} height={50} rx={14} fill="#F1E6DA" />
      <rect x={760} y={1222} width={250} height={56} rx={16} fill="#D8B9A0" />
      {/* brass tray, the tube and its reflection */}
      <ellipse cx={610} cy={1312} rx={190} ry={30} fill={u.url("brass")} />
      <ellipse cx={610} cy={1306} rx={176} ry={24} fill="#E9D3A6" />
      <g opacity={0.22} clipPath={u.url("tray")}>
        <g transform="translate(0 2610) scale(1 -1)">
          <Tube x={610} y={1306} s={0.42} params={{ sheen }} ms={ms} />
        </g>
      </g>
      <ellipse cx={612} cy={1306} rx={56} ry={9} fill="#5B4636" opacity={0.3} />
      <Tube x={610} y={1306} s={0.42} rotate={-3} params={{ sheen }} ms={ms} />
      {/* foreground leaves: blurred and drifting faster than the scene (depth) */}
      <g filter={u.url("blur")} transform={`translate(${Math.sin(t * 0.8) * 30} ${Math.cos(t * 0.6) * 10})`}>
        {Array.from({ length: 9 }, (_, i) =>
          leaf(40 + i * 46, 1700 + (i % 3) * 70, 70, i * 40, i % 2 ? "#7E9479" : "#90A88B"),
        )}
      </g>
    </g>
  );
};

/* ---------------------------------------------------------------- how a mineral filter works (diagram) */
export const SunMineral: React.FC<VectorProps> = ({ params, ms }) => {
  const u = useIds();
  const t = ms / 1000;
  const film = clamp01(num(params, "film", 1));
  const rays = [0, 1, 2, 3, 4];
  const hit = (k: number) => ({ x: 170 + k * 190, y: 1196 });
  const src = (k: number) => ({ x: 790 + k * 18, y: 410 + k * 10 });
  return (
    <g>
      <defs>
        <Lin
          id={u.id("sky")}
          stops={[
            [0, "#FBEADC"],
            [1, "#F4DCCB"],
          ]}
        />
        <Rad
          id={u.id("sun")}
          stops={[
            [0, "#FFE29A"],
            [0.7, "#F6B169"],
            [1, "#EE9B55"],
          ]}
        />
        <Rad
          id={u.id("glow")}
          stops={[
            [0, "#FFD48A", 0.6],
            [1, "#FFD48A", 0],
          ]}
        />
        <Lin
          id={u.id("skin")}
          stops={[
            [0, "#EAC1A4"],
            [0.4, "#E0AE8E"],
            [1, "#C98F70"],
          ]}
        />
        <Lin
          id={u.id("film")}
          stops={[
            [0, "#FFFFFF", 0.85],
            [1, "#FFFFFF", 0.35],
          ]}
        />
      </defs>
      <rect width={1080} height={1920} fill={u.url("sky")} />
      <circle cx={840} cy={360} r={300} fill={u.url("glow")} />
      <g transform={`rotate(${t * 12} 840 360)`}>
        {Array.from({ length: 12 }, (_, i) => (
          <rect
            key={i}
            x={836}
            y={180}
            width={8}
            height={46}
            rx={4}
            fill="#F6B169"
            opacity={0.7}
            transform={`rotate(${i * 30} 840 360)`}
          />
        ))}
      </g>
      <circle cx={840} cy={360} r={120} fill={u.url("sun")} />
      {/* incoming UV rays and their reflection off the mineral layer */}
      {rays.map((k) => {
        const a = src(k);
        const b = hit(k);
        const back = { x: b.x - (a.x - b.x) * 0.45, y: b.y - (b.y - a.y) * 0.45 };
        const off = -((t * 220 + k * 40) % 84);
        return (
          <g key={k}>
            <line
              x1={a.x}
              y1={a.y}
              x2={b.x}
              y2={b.y}
              stroke="#C8603F"
              strokeWidth={6}
              strokeDasharray="44 40"
              strokeDashoffset={off}
              strokeLinecap="round"
              opacity={0.85}
            />
            <line
              x1={b.x}
              y1={b.y}
              x2={back.x}
              y2={back.y}
              stroke="#E58F55"
              strokeWidth={5}
              strokeDasharray="30 30"
              strokeDashoffset={off * 0.8}
              strokeLinecap="round"
              opacity={0.7 * film}
            />
            <circle cx={b.x} cy={b.y} r={14 + 6 * Math.sin(t * 5 + k)} fill="#FFFFFF" opacity={0.7 * film} />
          </g>
        );
      })}
      {/* skin (abstract) */}
      <rect y={1232} width={1080} height={688} fill={u.url("skin")} />
      {scatter(60, 20, 1270, 1040, 620, 7).map((p, i) => (
        <ellipse
          key={i}
          cx={p.x}
          cy={p.y}
          rx={30 + p.k * 40}
          ry={14 + p.k * 12}
          fill="#F2CDB3"
          opacity={0.22}
        />
      ))}
      <path
        d="M0,1232 C200,1222 400,1240 600,1230 S900,1222 1080,1234"
        fill="none"
        stroke="#C98F70"
        strokeWidth={3}
        opacity={0.6}
      />
      {/* the mineral layer on top of the skin */}
      <rect y={1178} width={1080} height={56} fill={u.url("film")} opacity={film} />
      {scatter(70, 10, 1184, 1060, 44, 11).map((p, i) => {
        const tw = 0.6 + 0.4 * Math.sin(t * 4 + i);
        const r = 7 + p.k * 7;
        return (
          <polygon
            key={i}
            points={Array.from(
              { length: 6 },
              (_, j) => `${p.x + Math.cos((j * Math.PI) / 3) * r},${p.y + Math.sin((j * Math.PI) / 3) * r}`,
            ).join(" ")}
            fill="#FFFFFF"
            stroke="#D9C8BC"
            strokeWidth={1.5}
            opacity={film * tw}
          />
        );
      })}
    </g>
  );
};

/* ---------------------------------------------------------------- texture / application macro */
export const SunTexture: React.FC<VectorProps> = ({ params, ms }) => {
  const u = useIds();
  const s = clamp01(num(params, "spread", 0));
  const t = ms / 1000;
  const swipe = s > 0.08 && s < 0.95;
  if (str(params, "view", "dollop") === "swatch") return <SunSwatch ms={ms} />;
  return (
    <g>
      <defs>
        <Rad
          id={u.id("skin")}
          cx={0.5}
          cy={0.45}
          r={0.8}
          stops={[
            [0, "#EFCBB0"],
            [0.6, "#E2B293"],
            [1, "#CF9877"],
          ]}
        />
        <pattern id={u.id("pores")} width="34" height="30" patternUnits="userSpaceOnUse">
          <circle cx="8" cy="9" r="1.6" fill="#B67E60" opacity="0.35" />
          <circle cx="25" cy="22" r="1.2" fill="#B67E60" opacity="0.3" />
        </pattern>
        <Rad
          id={u.id("cream")}
          cx={0.4}
          cy={0.35}
          r={0.75}
          stops={[
            [0, "#FFFFFF"],
            [0.6, "#F7F1EC"],
            [1, "#E6DAD2"],
          ]}
        />
        <Rad
          id={u.id("film")}
          stops={[
            [0, "#FFFFFF", 0.32],
            [0.7, "#FFFFFF", 0.12],
            [1, "#FFFFFF", 0],
          ]}
        />
        <Lin
          id={u.id("streak")}
          x2={1}
          y2={0}
          stops={[
            [0, "#FFFFFF", 0],
            [0.5, "#FFFFFF", 0.5],
            [1, "#FFFFFF", 0],
          ]}
        />
      </defs>
      <rect width={1080} height={1920} fill={u.url("skin")} />
      <rect width={1080} height={1920} fill={u.url("pores")} />
      {Array.from({ length: 9 }, (_, i) => (
        <path
          key={i}
          d={`M-40,${300 + i * 170} C300,${270 + i * 170} 700,${330 + i * 170} 1120,${290 + i * 170}`}
          fill="none"
          stroke="#C48A6B"
          strokeWidth={1.5}
          opacity={0.16}
        />
      ))}
      {/* blending: the dollop is swiped out along a stroke and turns sheer */}
      <path
        d="M540,950 C680,900 840,790 960,560"
        fill="none"
        stroke="#FFF7F0"
        strokeWidth={200}
        strokeLinecap="round"
        opacity={0.4 * s}
        strokeDasharray={`${s * 640} 2000`}
      />
      <path
        d="M540,950 C420,1010 260,1120 120,1320"
        fill="none"
        stroke="#FFF7F0"
        strokeWidth={200}
        strokeLinecap="round"
        opacity={0.4 * s}
        strokeDasharray={`${s * 560} 2000`}
      />
      <path
        d="M540,920 C680,870 840,760 950,540"
        fill="none"
        stroke="#FFFFFF"
        strokeWidth={8}
        strokeLinecap="round"
        opacity={0.7 * s}
        strokeDasharray={`${s * 640} 2000`}
      />
      <path
        d="M540,920 C420,980 260,1090 130,1290"
        fill="none"
        stroke="#FFFFFF"
        strokeWidth={8}
        strokeLinecap="round"
        opacity={0.7 * s}
        strokeDasharray={`${s * 560} 2000`}
      />
      <g
        transform={`translate(540 940) scale(${1.5 * (1 - 0.65 * s)}) translate(-540 -940)`}
        opacity={1 - 0.7 * s}
      >
        <ellipse cx={540} cy={968} rx={220} ry={136} fill="#000" opacity={0.08} />
        <ellipse cx={540} cy={940} rx={210} ry={128} fill={u.url("cream")} />
        <path
          d="M380,930 C420,860 540,840 640,880 C700,905 690,960 620,968 C560,975 500,940 470,960"
          fill="none"
          stroke="#E8DDD5"
          strokeWidth={10}
          strokeLinecap="round"
        />
        <path
          d="M450,905 C500,880 580,885 600,915"
          fill="none"
          stroke="#FFFFFF"
          strokeWidth={8}
          strokeLinecap="round"
          opacity={0.9}
        />
        <ellipse cx={470} cy={890} rx={40} ry={16} fill="#FFFFFF" opacity={0.95} />
      </g>
      {/* droplets around */}
      {scatter(7, 280, 700, 520, 520, 5).map((p, i) => (
        <g key={i} opacity={1 - s}>
          <circle cx={p.x} cy={p.y} r={10 + p.k * 14} fill="#FFFFFF" opacity={0.75} />
          <circle cx={p.x - 4} cy={p.y - 4} r={3 + p.k * 3} fill="#FFFFFF" />
        </g>
      ))}
      {swipe ? (
        <rect
          x={-200 + s * 1400}
          y={820}
          width={260}
          height={260}
          fill={u.url("streak")}
          transform={`rotate(-14 540 950)`}
          opacity={0.6}
        />
      ) : null}
      {/* a soft glint moving over the finished film */}
      <ellipse
        cx={360 + Math.sin(t * 1.4) * 220}
        cy={900}
        rx={90}
        ry={26}
        fill="#FFFFFF"
        opacity={0.18 * s}
        transform="rotate(-14 540 950)"
      />
    </g>
  );
};

/* ---------------------------------------------------------------- summer flat lay (top-down) */
export const SunOutdoor: React.FC<VectorProps> = ({ params, ms }) => {
  const u = useIds();
  const t = ms / 1000;
  return (
    <g>
      <defs>
        <pattern id={u.id("sand")} width="22" height="22" patternUnits="userSpaceOnUse">
          <rect width="22" height="22" fill="#EBD1AC" />
          <circle cx="5" cy="6" r="1.4" fill="#D4B184" />
          <circle cx="16" cy="15" r="1.1" fill="#F6E4C8" />
        </pattern>
        <Rad
          id={u.id("hat")}
          stops={[
            [0, "#E9CE98"],
            [0.8, "#D9B577"],
            [1, "#C79F5F"],
          ]}
        />
      </defs>
      <rect width={1080} height={1920} fill={u.url("sand")} />
      {/* striped towel */}
      <g transform="rotate(-12 540 1000)">
        <rect x={110} y={260} width={860} height={1480} rx={16} fill="#F4EBDD" />
        {Array.from({ length: 9 }, (_, i) => (
          <rect
            key={i}
            x={110 + i * 96}
            y={260}
            width={44}
            height={1480}
            fill={i % 3 === 0 ? "#B4654A" : i % 3 === 1 ? "#E3B79C" : "#9DB39A"}
            opacity={0.85}
          />
        ))}
        {Array.from({ length: 14 }, (_, i) => (
          <rect key={i} x={110 + i * 64} y={1740} width={6} height={36} fill="#F4EBDD" />
        ))}
      </g>
      {/* straw hat */}
      <circle cx={860} cy={420} r={250} fill="#000" opacity={0.12} transform="translate(14 18)" />
      <circle cx={860} cy={420} r={250} fill={u.url("hat")} />
      {[200, 160, 120].map((r) => (
        <circle key={r} cx={860} cy={420} r={r} fill="none" stroke="#B99258" strokeWidth={3} opacity={0.5} />
      ))}
      <circle cx={860} cy={420} r={110} fill="#E2C389" />
      <circle cx={860} cy={420} r={118} fill="none" stroke="#3B2A24" strokeWidth={14} />
      {/* sunglasses */}
      <g transform="rotate(18 270 1300)">
        <ellipse cx={210} cy={1300} rx={78} ry={62} fill="#2B2420" />
        <ellipse cx={370} cy={1300} rx={78} ry={62} fill="#2B2420" />
        <path d="M285,1290 Q290,1270 296,1290" fill="none" stroke="#C9A26B" strokeWidth={8} />
        <ellipse cx={190} cy={1280} rx={26} ry={12} fill="#FFFFFF" opacity={0.25} />
        <ellipse cx={350} cy={1280} rx={26} ry={12} fill="#FFFFFF" opacity={0.25} />
      </g>
      {/* the tube, lying on the towel */}
      <ellipse
        cx={600}
        cy={1020}
        rx={90}
        ry={300}
        fill="#000"
        opacity={0.14}
        transform="rotate(-58 600 1020)"
      />
      <Tube
        x={790}
        y={1150}
        s={0.62}
        rotate={-62}
        params={{ ...params, sheen: 0.35 + 0.1 * Math.sin(t) }}
        ms={ms}
      />
      {/* moving palm shadow */}
      <g opacity={0.2} transform={`rotate(${Math.sin(t * 0.7) * 3} 0 1920)`}>
        {Array.from({ length: 7 }, (_, i) => (
          <path
            key={i}
            d="M0,0 C110,-22 260,-24 460,0 C260,24 110,22 0,0 Z"
            fill="#4A3424"
            transform={`translate(-60 1980) rotate(${-80 + i * 12}) translate(180 0)`}
          />
        ))}
      </g>
    </g>
  );
};

/** texture swatch: a sheer, glossy stroke of fluid on skin — shows the finish without a white cast */
const SunSwatch: React.FC<{ ms: number }> = ({ ms }) => {
  const u = useIds();
  const t = ms / 1000;
  const stroke = "M120,1320 C260,1080 420,980 560,930 C720,872 860,760 960,560";
  const glint = (Math.sin(t * 0.9) * 0.5 + 0.5) * 900;
  return (
    <g>
      <defs>
        <Rad
          id={u.id("skin")}
          cx={0.45}
          cy={0.42}
          r={0.85}
          stops={[
            [0, "#F0CCB1"],
            [0.6, "#E2B293"],
            [1, "#CC9475"],
          ]}
        />
        <pattern id={u.id("pores")} width="30" height="28" patternUnits="userSpaceOnUse">
          <circle cx="7" cy="8" r="1.5" fill="#B67E60" opacity="0.32" />
          <circle cx="22" cy="20" r="1.1" fill="#B67E60" opacity="0.28" />
        </pattern>
        <Lin
          id={u.id("gloss")}
          x1={0}
          y1={1}
          x2={1}
          y2={0}
          stops={[
            [0, "#FFFFFF", 0.05],
            [0.5, "#FFFFFF", 0.35],
            [1, "#FFFFFF", 0.08],
          ]}
        />
        <filter id={u.id("soft")} x="-10%" y="-10%" width="120%" height="120%">
          <feGaussianBlur stdDeviation="10" />
        </filter>
      </defs>
      <rect width={1080} height={1920} fill={u.url("skin")} />
      <rect width={1080} height={1920} fill={u.url("pores")} />
      {/* the sheer stroke: soft body + glossy edges + a moving highlight */}
      <path
        d={stroke}
        fill="none"
        stroke="#FFF7F0"
        strokeWidth={230}
        strokeLinecap="round"
        opacity={0.28}
        filter={u.url("soft")}
      />
      <path d={stroke} fill="none" stroke={u.url("gloss")} strokeWidth={200} strokeLinecap="round" />
      <path
        d="M150,1270 C290,1040 440,950 580,900 C730,846 860,736 950,560"
        fill="none"
        stroke="#FFFFFF"
        strokeWidth={10}
        strokeLinecap="round"
        opacity={0.75}
      />
      <path
        d="M190,1370 C330,1140 480,1050 620,1000 C770,946 900,830 990,640"
        fill="none"
        stroke="#FFFFFF"
        strokeWidth={5}
        strokeLinecap="round"
        opacity={0.45}
      />
      <path
        d={stroke}
        fill="none"
        stroke="#FFFFFF"
        strokeWidth={70}
        strokeLinecap="round"
        strokeDasharray={`140 ${2400}`}
        strokeDashoffset={-glint}
        opacity={0.35}
        filter={u.url("soft")}
      />
      {scatter(14, 220, 760, 700, 520, 9).map((p, i) => (
        <circle
          key={i}
          cx={p.x}
          cy={p.y}
          r={4 + p.k * 6}
          fill="#FFFFFF"
          opacity={0.55 + 0.35 * Math.sin(t * 3 + i)}
        />
      ))}
    </g>
  );
};
