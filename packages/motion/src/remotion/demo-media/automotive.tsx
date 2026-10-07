import type React from "react";
import { num } from "../util.ts";
import { FONT, Lin, Rad, clamp01, cylStops, scatter, useIds, type VectorProps } from "./shared.tsx";

/* Cordless handheld car vacuum — 1000×600, side view facing left, centre line y=300. */

const RED = "#E3262C";

export const VacuumArt: React.FC<{ params: VectorProps["params"]; ms: number }> = ({ params, ms }) => {
  const u = useIds();
  const power = clamp01(num(params, "power", 0));
  const fill = clamp01(num(params, "fill", 0.15));
  const debris = scatter(70, 330, 392 - 160, 178, 160, 5).filter((d) => d.y > 392 - fill * 160);
  return (
    <g>
      <defs>
        <Lin
          id={u.id("noz")}
          stops={[
            [0, "#3A3E45"],
            [0.45, "#24272C"],
            [1, "#121316"],
          ]}
        />
        <Lin
          id={u.id("body")}
          stops={[
            [0, "#4A4F57"],
            [0.3, "#2C3036"],
            [0.8, "#17191C"],
            [1, "#0E0F11"],
          ]}
        />
        <Lin id={u.id("ring")} stops={cylStops("#C81E23", "#FF6A6E", "#7A0E12")} />
        <Lin
          id={u.id("bin")}
          x2={1}
          y2={0}
          stops={[
            [0, "#DDEBF5", 0.3],
            [0.5, "#DDEBF5", 0.08],
            [1, "#DDEBF5", 0.25],
          ]}
        />
        <Lin
          id={u.id("dust")}
          stops={[
            [0, "#9C8466", 0],
            [1, "#7D6448", 0.85],
          ]}
        />
        <Rad
          id={u.id("vent")}
          stops={[
            [0, RED, 0.7],
            [1, RED, 0],
          ]}
        />
        <pattern id={u.id("mesh")} width="8" height="8" patternUnits="userSpaceOnUse">
          <circle cx="4" cy="4" r="1.6" fill="#ffffff" opacity="0.35" />
        </pattern>
        <clipPath id={u.id("binclip")}>
          <rect x={318} y={202} width={204} height={196} rx={28} />
        </clipPath>
      </defs>
      {/* handle loop (behind the body) */}
      <path
        d="M600,206 C622,128 690,100 780,100 C866,100 905,150 896,226 C890,280 850,318 780,330"
        fill="none"
        stroke="#202328"
        strokeWidth={58}
        strokeLinecap="round"
      />
      <path
        d="M612,196 C636,136 696,114 780,114 C858,114 892,152 888,224"
        fill="none"
        stroke="#ffffff"
        strokeOpacity={0.1}
        strokeWidth={6}
        strokeLinecap="round"
      />
      <path
        d="M660,124 C700,108 740,104 780,104 C850,104 884,140 892,190"
        fill="none"
        stroke="#33373D"
        strokeWidth={40}
        strokeDasharray="3 9"
        strokeLinecap="round"
      />
      <rect x={732} y={62} width={56} height={20} rx={10} fill={RED} />
      <rect x={738} y={64} width={44} height={5} rx={2.5} fill="#ffffff" opacity={0.45} />
      {[0, 1, 2].map((i) => (
        <circle
          key={i}
          cx={893 - i * 4}
          cy={252 + i * 22}
          r={5}
          fill={power > 0.05 || i < 2 ? "#5BFF7A" : "#2A2E33"}
          opacity={0.9}
        />
      ))}
      {/* nozzle */}
      <path d="M300,246 L300,354 L78,322 C52,318 40,312 40,300 C40,288 52,282 78,278 Z" fill={u.url("noz")} />
      <path d="M92,281 L92,319" stroke="#4A4F57" strokeWidth={3} />
      <path
        d="M100,284 L296,252"
        stroke="#ffffff"
        strokeOpacity={0.14}
        strokeWidth={4}
        strokeLinecap="round"
      />
      <rect x={290} y={236} width={30} height={128} rx={8} fill="#202328" />
      {/* clear cyclone bin */}
      <g clipPath={u.url("binclip")}>
        <rect x={318} y={202} width={204} height={196} fill="#1B2128" opacity={0.55} />
        <path
          d="M360,226 L480,226 L452,342 L388,342 Z"
          fill={u.url("mesh")}
          stroke="#ffffff"
          strokeOpacity={0.3}
          strokeWidth={2}
        />
        <rect x={318} y={392 - fill * 160} width={204} height={fill * 160 + 10} fill={u.url("dust")} />
        {debris.map((d, i) => (
          <polygon
            key={i}
            points={`${d.x},${d.y - 6 - d.k * 6} ${d.x + 7 + d.k * 5},${d.y + 3} ${d.x - 6},${d.y + 6}`}
            fill={["#C8A06A", "#E2B25A", "#8C6A44", "#D9C3A0"][i % 4]}
          />
        ))}
        {power > 0.02
          ? [0, 1, 2].map((k) => (
              <ellipse
                key={k}
                cx={420}
                cy={280 + k * 30}
                rx={84 - k * 10}
                ry={16}
                fill="none"
                stroke="#ffffff"
                strokeWidth={2.5}
                strokeDasharray="40 60"
                strokeDashoffset={-(ms * 0.5 * power) - k * 33}
                opacity={0.45 * power}
              />
            ))
          : null}
        <rect x={318} y={202} width={204} height={196} fill={u.url("bin")} />
      </g>
      <rect
        x={318}
        y={202}
        width={204}
        height={196}
        rx={28}
        fill="none"
        stroke="#ffffff"
        strokeOpacity={0.55}
        strokeWidth={3}
      />
      <rect x={336} y={214} width={12} height={170} rx={6} fill="#ffffff" opacity={0.3} />
      <path d="M332,252 h40" stroke="#ffffff" strokeOpacity={0.6} strokeWidth={2} strokeDasharray="6 4" />
      <text x={378} y={257} fontFamily={FONT} fontWeight={700} fontSize={14} fill="#ffffff" opacity={0.7}>
        MAX
      </text>
      <rect x={468} y={190} width={36} height={14} rx={6} fill={RED} />
      {/* red ring + motor body */}
      <rect x={522} y={196} width={16} height={208} rx={6} fill={u.url("ring")} />
      <path
        d="M538,198 L716,198 C780,198 812,244 812,300 C812,356 780,402 716,402 L538,402 Z"
        fill={u.url("body")}
      />
      <path
        d="M548,210 L716,210 C760,210 786,232 796,262"
        fill="none"
        stroke="#ffffff"
        strokeOpacity={0.16}
        strokeWidth={5}
        strokeLinecap="round"
      />
      {[256, 278, 300, 322, 344].map((y) => (
        <g key={y}>
          <rect x={600} y={y - 4} width={130} height={9} rx={4.5} fill="#07080A" />
          {power > 0.02 ? (
            <rect x={604} y={y - 2} width={122} height={5} rx={2.5} fill={RED} opacity={0.35 * power} />
          ) : null}
        </g>
      ))}
      <rect x={800} y={286} width={10} height={28} rx={5} fill="#0B0C0E" />
      <text x={566} y={384} fontFamily={FONT} fontWeight={700} fontSize={15} fill="#8E959E" letterSpacing={3}>
        CYCLONE
      </text>
      {power > 0.02
        ? [0, 1, 2].map((k) => {
            const ph = ((ms / 300 + k / 3) % 1) * 60;
            return (
              <path
                key={k}
                d={`M${822 + ph},${270 + k * 30} q12,-8 24,0 t24,0`}
                fill="none"
                stroke="#C9D6E3"
                strokeWidth={3}
                strokeLinecap="round"
                opacity={(1 - ph / 60) * 0.6 * power}
              />
            );
          })
        : null}
    </g>
  );
};

export const CarVacuum: React.FC<VectorProps> = ({ params, ms }) => <VacuumArt params={params} ms={ms} />;

/* Car front seat with crumbs, the vacuum at work — 1080×1920. Nearest crumbs disappear first. */
const NOZZLE = { x: 430, y: 1092 };

export const CarInterior: React.FC<VectorProps> = ({ params, ms }) => {
  const u = useIds();
  const crumbs = clamp01(num(params, "crumbs", 1));
  const power = clamp01(num(params, "power", 1));
  const showVacuum = num(params, "vacuum", 1) > 0.5;
  const pieces = [...scatter(46, 260, 1056, 580, 34, 7), ...scatter(14, 196, 1000, 70, 90, 9)]
    .map((p) => ({ ...p, d: Math.hypot(p.x - NOZZLE.x, p.y - NOZZLE.y) }))
    .sort((a, b) => a.d - b.d);
  const n = pieces.length;
  const vib = Math.sin(ms * 0.11) * 1.2 * power;
  return (
    <g>
      <defs>
        <Lin
          id={u.id("cabin")}
          stops={[
            [0, "#2A2D33"],
            [0.4, "#17191C"],
            [1, "#0C0D0F"],
          ]}
        />
        <Lin
          id={u.id("wind")}
          x1={0}
          y1={0}
          x2={1}
          y2={1}
          stops={[
            [0, "#DCE8F2"],
            [1, "#7D96AC"],
          ]}
        />
        <Lin
          id={u.id("seat")}
          stops={[
            [0, "#555A62"],
            [0.5, "#3C4047"],
            [1, "#24272B"],
          ]}
        />
        <Lin
          id={u.id("back")}
          x2={1}
          y2={0}
          stops={[
            [0, "#2E3136"],
            [0.6, "#464B52"],
            [1, "#363A40"],
          ]}
        />
        <pattern id={u.id("perf")} width="16" height="16" patternUnits="userSpaceOnUse">
          <rect width="16" height="16" fill="#4A4F57" />
          <circle cx="8" cy="8" r="2.2" fill="#2A2D32" />
        </pattern>
        <pattern id={u.id("carpet")} width="10" height="10" patternUnits="userSpaceOnUse">
          <rect width="10" height="10" fill="#222428" />
          <rect width="5" height="5" fill="#26282D" />
        </pattern>
        <Rad
          id={u.id("day")}
          cx={0.8}
          cy={0.2}
          r={0.95}
          stops={[
            [0, "#E6F0FF", 0.42],
            [0.55, "#DDEBFF", 0.12],
            [1, "#000000", 0],
          ]}
        />
        <Rad
          id={u.id("vig")}
          cx={0.5}
          cy={0.55}
          r={0.75}
          stops={[
            [0.6, "#000000", 0],
            [1, "#000000", 0.55],
          ]}
        />
      </defs>
      <rect width={1080} height={1920} fill={u.url("cabin")} />
      {/* windshield + dashboard */}
      <path d="M420,0 L1080,0 L1080,520 C900,420 700,330 420,0 Z" fill={u.url("wind")} opacity={0.75} />
      <path
        d="M380,0 C640,330 860,470 1080,560 L1080,760 C860,700 640,600 470,440 C420,300 400,160 380,0 Z"
        fill="#141518"
      />
      <path
        d="M470,440 C640,600 860,700 1080,760"
        fill="none"
        stroke="#ffffff"
        strokeOpacity={0.08}
        strokeWidth={6}
      />
      <circle cx={760} cy={430} r={210} fill="none" stroke="#0B0C0E" strokeWidth={44} />
      <circle cx={760} cy={430} r={210} fill="none" stroke="#ffffff" strokeOpacity={0.06} strokeWidth={4} />
      {/* floor + mat */}
      <rect y={1440} width={1080} height={480} fill={u.url("carpet")} />
      <path d="M120,1520 L980,1500 L1040,1920 L60,1920 Z" fill="#141518" stroke="#2E3035" strokeWidth={10} />
      {Array.from({ length: 8 }, (_, i) => (
        <path
          key={i}
          d={`M${150 - i * 10},${1570 + i * 46} L${990 + i * 6},${1550 + i * 46}`}
          stroke="#25272B"
          strokeWidth={8}
        />
      ))}
      {scatter(30, 160, 1560, 760, 300, 11).map((p, i) =>
        i / 30 >= 1 - crumbs ? (
          <polygon
            key={i}
            points={`${p.x},${p.y - 6} ${p.x + 8},${p.y + 3} ${p.x - 5},${p.y + 6}`}
            fill={["#C8A06A", "#E2B25A", "#8C6A44"][i % 3]}
            opacity={0.9}
          />
        ) : null,
      )}
      {/* seat: rails, cushion, back, headrest */}
      <rect x={260} y={1300} width={560} height={50} rx={10} fill="#0F1012" />
      <rect x={300} y={1350} width={480} height={18} rx={6} fill="#3A3D42" />
      <path
        d="M150,1300 C150,1200 170,1090 230,1070 L860,1056 C920,1056 940,1120 930,1190 C920,1260 900,1300 840,1310 L200,1316 C170,1316 150,1310 150,1300 Z"
        fill={u.url("seat")}
      />
      <path
        d="M300,1070 L800,1060 C820,1060 830,1080 828,1110 L300,1124 Z"
        fill={u.url("perf")}
        opacity={0.9}
      />
      <path d="M300,1124 L828,1110" stroke={RED} strokeWidth={3} strokeDasharray="10 7" opacity={0.85} />
      <path
        d="M236,1076 L858,1062"
        stroke="#ffffff"
        strokeOpacity={0.12}
        strokeWidth={6}
        strokeLinecap="round"
      />
      <path
        d="M150,1080 C120,860 150,620 210,430 C228,380 300,370 330,400 C370,440 360,640 320,1060 Z"
        fill={u.url("back")}
      />
      <path
        d="M200,1050 C180,860 200,660 246,470"
        fill="none"
        stroke={RED}
        strokeWidth={3}
        strokeDasharray="10 7"
        opacity={0.8}
      />
      <path
        d="M190,380 C190,300 230,250 290,256 C340,262 350,320 334,380 C320,420 210,420 190,380 Z"
        fill="#2E3136"
      />
      <rect x={228} y={418} width={14} height={40} fill="#8E959E" />
      <rect x={292} y={418} width={14} height={40} fill="#8E959E" />
      {/* crumbs on the cushion / in the seam */}
      {pieces.map((p, i) => {
        if (i / n < 1 - crumbs) return null;
        const c = ["#D9B27A", "#E2B25A", "#B07A43", "#F0D9A8"][i % 4]!;
        return i % 5 === 0 ? (
          <circle key={i} cx={p.x} cy={p.y} r={7 + p.k * 3} fill="none" stroke={c} strokeWidth={4.5} />
        ) : (
          <polygon
            key={i}
            points={`${p.x},${p.y - 5 - p.k * 4} ${p.x + 7 + p.k * 4},${p.y + 3} ${p.x - 6},${p.y + 5}`}
            fill={c}
          />
        );
      })}
      {/* the vacuum */}
      {showVacuum ? (
        <g transform={`translate(${NOZZLE.x} ${NOZZLE.y + vib}) rotate(-30) scale(0.98) translate(-44 -300)`}>
          <VacuumArt params={{ ...params, power }} ms={ms} />
        </g>
      ) : null}
      <rect width={1080} height={1920} fill={u.url("day")} />
      <rect width={1080} height={1920} fill={u.url("vig")} />
    </g>
  );
};

/* Top-down car floor mat, dirty or clean — 1080×1920. */
const LEAF = "M0,0 C14,-18 40,-20 56,0 C40,20 14,18 0,0 Z";

export const CarMat: React.FC<VectorProps> = ({ params }) => {
  const u = useIds();
  const dirt = clamp01(num(params, "dirt", 1));
  const grit = scatter(160, 190, 330, 700, 1340, 13);
  const blotches = [
    [360, 520, 150],
    [700, 980, 190],
    [420, 1380, 170],
    [760, 1560, 130],
  ] as const;
  return (
    <g>
      <defs>
        <pattern id={u.id("carpet")} width="12" height="12" patternUnits="userSpaceOnUse">
          <rect width="12" height="12" fill="#2A2C31" />
          <rect width="6" height="6" fill="#2F3237" />
        </pattern>
        <pattern
          id={u.id("heel")}
          width="26"
          height="26"
          patternUnits="userSpaceOnUse"
          patternTransform="rotate(45)"
        >
          <rect width="26" height="26" fill="#1D1E21" />
          <rect width="13" height="26" fill="#25272B" />
        </pattern>
        <Rad
          id={u.id("sand")}
          stops={[
            [0, "#B89B6E", 0.75],
            [0.6, "#A88B5E", 0.35],
            [1, "#A88B5E", 0],
          ]}
        />
        <Lin
          id={u.id("sheen")}
          x1={0}
          y1={0}
          x2={1}
          y2={1}
          stops={[
            [0, "#ffffff", 0],
            [0.45, "#ffffff", 0.07],
            [0.55, "#ffffff", 0.0],
            [1, "#ffffff", 0],
          ]}
        />
        <Rad
          id={u.id("vig")}
          cx={0.5}
          cy={0.5}
          r={0.75}
          stops={[
            [0.6, "#000000", 0],
            [1, "#000000", 0.5],
          ]}
        />
      </defs>
      <rect width={1080} height={1920} fill={u.url("carpet")} />
      {/* pedals */}
      <rect x={380} y={50} width={230} height={150} rx={26} fill="#3A3C40" />
      {Array.from({ length: 5 }, (_, i) => (
        <rect key={i} x={400} y={70 + i * 26} width={190} height={10} rx={5} fill="#2A2C30" />
      ))}
      <rect x={720} y={20} width={96} height={220} rx={22} fill="#3A3C40" />
      {Array.from({ length: 7 }, (_, i) => (
        <rect key={i} x={736} y={40 + i * 28} width={64} height={10} rx={5} fill="#2A2C30" />
      ))}
      {/* mat */}
      <path
        d="M200,280 L880,280 Q930,280 930,340 L960,1660 Q960,1740 880,1740 L200,1740 Q120,1740 120,1660 L150,340 Q150,280 200,280 Z"
        fill="#18191C"
        stroke="#34363B"
        strokeWidth={20}
      />
      <rect x={220} y={340} width={640} height={380} rx={30} fill={u.url("heel")} />
      {Array.from({ length: 20 }, (_, i) => (
        <rect key={i} x={200} y={780 + i * 46} width={680} height={14} rx={7} fill="#232528" />
      ))}
      <path
        d="M200,280 L880,280 Q930,280 930,340 L960,1660 Q960,1740 880,1740 L200,1740 Q120,1740 120,1660 L150,340 Q150,280 200,280 Z"
        fill={u.url("sheen")}
      />
      {/* dirt */}
      {dirt > 0.01 ? (
        <g opacity={Math.min(1, dirt * 1.4)}>
          {blotches.map(([x, y, r], i) => (
            <circle
              key={i}
              cx={x}
              cy={y}
              r={r}
              fill={u.url("sand")}
              opacity={i / blotches.length < dirt ? 1 : 0}
            />
          ))}
          <g transform="translate(470 980) rotate(-12)" opacity={dirt > 0.4 ? 0.6 : 0}>
            <path
              d="M0,0 C30,-60 110,-70 140,0 C160,60 150,140 120,200 L40,200 C10,140 -10,60 0,0 Z"
              fill="#5E4A30"
            />
            <path d="M50,240 C40,280 60,330 90,330 C120,330 130,280 120,240 Z" fill="#5E4A30" />
            {Array.from({ length: 5 }, (_, i) => (
              <rect
                key={i}
                x={20}
                y={20 + i * 34}
                width={110}
                height={10}
                rx={5}
                fill="#18191C"
                opacity={0.6}
              />
            ))}
          </g>
          {grit.map((g, i) =>
            g.k < dirt ? (
              i % 7 === 0 ? (
                <circle key={i} cx={g.x} cy={g.y} r={5 + g.k * 6} fill="#7F7B74" />
              ) : (
                <polygon
                  key={i}
                  points={`${g.x},${g.y - 5} ${g.x + 7},${g.y + 3} ${g.x - 5},${g.y + 6}`}
                  fill={["#C8A06A", "#D9C3A0", "#8C6A44", "#E2B25A"][i % 4]}
                />
              )
            ) : null,
          )}
          {[
            [300, 800, 30, "#7A5A2E"],
            [800, 640, -40, "#5E7A2E"],
            [640, 1460, 70, "#8A4A22"],
            [280, 1620, -10, "#6B5A2E"],
          ].map(([x, y, r, c], i) =>
            i / 4 < dirt ? (
              <path
                key={i}
                d={LEAF}
                transform={`translate(${x} ${y}) rotate(${r}) scale(1.6)`}
                fill={c as string}
              />
            ) : null,
          )}
        </g>
      ) : null}
      <rect width={1080} height={1920} fill={u.url("vig")} />
    </g>
  );
};
