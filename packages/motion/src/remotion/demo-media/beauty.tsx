import type React from "react";
import { mix, num } from "../util.ts";
import { Lin, Rad, clamp01, useIds, type VectorProps } from "./shared.tsx";

/* Round LED vanity mirror — 800×1000. tone 0 warm · 1 neutral · 2 cool (continuous). No faces, no skin claims. */

export function toneColor(tone: number): string {
  const t = Math.max(0, Math.min(2, tone));
  return t <= 1 ? mix("#FFC77E", "#FFF1DA", t) : mix("#FFF1DA", "#D6E6FF", t - 1);
}

export const MirrorArt: React.FC<{ params: VectorProps["params"]; ms: number }> = ({ params }) => {
  const u = useIds();
  const light = clamp01(num(params, "light", 1));
  const tone = num(params, "tone", 1);
  const level = clamp01(num(params, "level", 0.8));
  const touch = clamp01(num(params, "touch", 0));
  const tc = toneColor(tone);
  const ring = mix("#E9E4E0", tc, light);
  const lit = Math.round(level * 5);
  return (
    <g>
      <defs>
        <Rad
          id={u.id("halo")}
          stops={[
            [0, tc, 0.55],
            [0.55, tc, 0.22],
            [1, tc, 0],
          ]}
        />
        <Lin
          id={u.id("frame")}
          x1={0}
          y1={0}
          x2={1}
          y2={1}
          stops={[
            [0, "#F6E3D5"],
            [0.3, "#C9967A"],
            [0.55, "#F7E6DA"],
            [0.8, "#B98A6E"],
            [1, "#E8C9B4"],
          ]}
        />
        <Lin
          id={u.id("glass")}
          x1={0.2}
          y1={0}
          x2={0.8}
          y2={1}
          stops={[
            [0, mix("#E9EEF2", "#FFFFFF", light * 0.5)],
            [0.5, mix("#B7C1CA", "#D9DEE2", light * 0.6)],
            [1, mix("#DCE3E9", "#F4F6F8", light * 0.4)],
          ]}
        />
        <Lin
          id={u.id("stem")}
          x2={1}
          y2={0}
          stops={[
            [0, "#B98A6E"],
            [0.45, "#F7E6DA"],
            [1, "#A97C62"],
          ]}
        />
        <Lin
          id={u.id("base")}
          stops={[
            [0, "#F6E8DE"],
            [1, "#D9B8A2"],
          ]}
        />
        <clipPath id={u.id("gclip")}>
          <circle cx={400} cy={410} r={280} />
        </clipPath>
        <clipPath id={u.id("mclip")}>
          <circle cx={545} cy={545} r={64} />
        </clipPath>
      </defs>
      {light > 0.01 ? <circle cx={400} cy={410} r={420} fill={u.url("halo")} opacity={light} /> : null}
      {/* stand */}
      <ellipse cx={400} cy={944} rx={240} ry={56} fill="#B98A6E" />
      <rect x={160} y={912} width={480} height={32} fill="#C99C82" />
      <ellipse cx={400} cy={912} rx={240} ry={56} fill={u.url("base")} />
      <ellipse cx={400} cy={906} rx={200} ry={40} fill="#ffffff" opacity={0.25} />
      {Array.from({ length: 5 }, (_, i) => (
        <circle key={i} cx={352 + i * 24} cy={918} r={5} fill={i < lit && light > 0.05 ? tc : "#CDB3A2"} />
      ))}
      <rect x={386} y={724} width={28} height={190} rx={8} fill={u.url("stem")} />
      <rect x={366} y={716} width={68} height={30} rx={12} fill={u.url("stem")} />
      {/* frame, LED ring, glass */}
      <circle cx={400} cy={410} r={316} fill={u.url("frame")} />
      <circle cx={400} cy={410} r={300} fill="#8E6A55" opacity={0.6} />
      <circle cx={400} cy={410} r={296} fill={ring} />
      {light > 0.01 ? (
        <circle
          cx={400}
          cy={410}
          r={288}
          fill="none"
          stroke="#ffffff"
          strokeWidth={6}
          opacity={0.7 * light}
        />
      ) : null}
      <circle cx={400} cy={410} r={280} fill={u.url("glass")} />
      <g clipPath={u.url("gclip")}>
        <path d="M160,180 L300,140 L330,470 L190,510 Z" fill="#ffffff" opacity={0.22} />
        <path d="M200,700 L640,180 L700,230 L260,750 Z" fill="#ffffff" opacity={0.14} />
        <ellipse cx={460} cy={640} rx={300} ry={110} fill="#6E7A86" opacity={0.18} />
        {light > 0.01 ? <circle cx={400} cy={410} r={280} fill={tc} opacity={0.14 * light} /> : null}
        {/* touch control */}
        <circle cx={400} cy={640} r={30} fill="#ffffff" opacity={0.12 + touch * 0.35} />
        <circle cx={400} cy={640} r={24} fill="none" stroke="#ffffff" strokeWidth={3} opacity={0.9} />
        <circle cx={400} cy={640} r={7} fill="#ffffff" opacity={0.9} />
        {Array.from({ length: 8 }, (_, i) => {
          const a = (i / 8) * Math.PI * 2;
          return (
            <line
              key={i}
              x1={400 + Math.cos(a) * 11}
              y1={640 + Math.sin(a) * 11}
              x2={400 + Math.cos(a) * 16}
              y2={640 + Math.sin(a) * 16}
              stroke="#ffffff"
              strokeWidth={2.5}
              strokeLinecap="round"
              opacity={0.9}
            />
          );
        })}
      </g>
      {/* 10× spot mirror */}
      <circle cx={545} cy={545} r={72} fill={u.url("frame")} />
      <circle cx={545} cy={545} r={64} fill="#C9D2DA" />
      <g clipPath={u.url("mclip")}>
        <path d="M470,600 L590,470 L620,500 L500,630 Z" fill="#ffffff" opacity={0.35} />
        <circle cx={520} cy={520} r={30} fill="#ffffff" opacity={0.2} />
      </g>
    </g>
  );
};

export const LedMirror: React.FC<VectorProps> = ({ params, ms }) => <MirrorArt params={params} ms={ms} />;

/* Vanity table at dusk — 1080×1920. The mirror sits on the table (base at y≈1380). */
export const VanityScene: React.FC<VectorProps> = ({ params, ms }) => {
  const u = useIds();
  const light = clamp01(num(params, "light", 1));
  const tone = num(params, "tone", 1);
  const tc = toneColor(tone);
  return (
    <g>
      <defs>
        <Lin
          id={u.id("wall")}
          stops={[
            [0, "#EBD8D0"],
            [1, "#D9BFB4"],
          ]}
        />
        <Lin
          id={u.id("top")}
          stops={[
            [0, "#EFEAE6"],
            [1, "#FBF9F7"],
          ]}
        />
        <Lin
          id={u.id("front")}
          stops={[
            [0, "#E8E1DB"],
            [1, "#CFC5BD"],
          ]}
        />
        <Lin
          id={u.id("gold")}
          x2={1}
          y2={0}
          stops={[
            [0, "#B98A4E"],
            [0.5, "#F4D9A3"],
            [1, "#A97A3E"],
          ]}
        />
        <Lin
          id={u.id("bottle")}
          x2={1}
          y2={0}
          stops={[
            [0, "#F2D6CC", 0.7],
            [0.5, "#FFFFFF", 0.5],
            [1, "#E8C2B4", 0.7],
          ]}
        />
        <Rad
          id={u.id("glow")}
          stops={[
            [0, tc, 0.75],
            [0.45, tc, 0.28],
            [1, tc, 0],
          ]}
        />
        <Rad
          id={u.id("pool")}
          stops={[
            [0, tc, 0.6],
            [1, tc, 0],
          ]}
        />
      </defs>
      <rect width={1080} height={1920} fill={u.url("wall")} />
      {Array.from({ length: 14 }, (_, i) => (
        <rect key={i} x={i * 80} width={2} height={1300} fill="#C9AFA4" opacity={0.35} />
      ))}
      {/* framed arch print */}
      <rect
        x={96}
        y={300}
        width={250}
        height={340}
        rx={6}
        fill="#F7EFEA"
        stroke={u.url("gold")}
        strokeWidth={10}
      />
      <path d="M150,600 L150,470 A71,71 0 0 1 292,470 L292,600 Z" fill="#C88A74" />
      <circle cx={221} cy={430} r={26} fill="#E9B8A0" />
      {/* table */}
      <path d="M0,1300 L1080,1300 L1080,1480 L0,1480 Z" fill={u.url("top")} />
      {[
        "M40,1330 C200,1360 300,1320 460,1400",
        "M600,1320 C700,1380 860,1350 1060,1440",
        "M120,1450 C260,1420 380,1470 520,1440",
      ].map((d) => (
        <path key={d} d={d} fill="none" stroke="#B9B2AC" strokeWidth={2} opacity={0.6} />
      ))}
      <rect y={1480} width={1080} height={110} fill={u.url("front")} />
      <rect y={1590} width={1080} height={330} fill="#D8CEC6" />
      <rect x={470} y={1520} width={140} height={14} rx={7} fill={u.url("gold")} />
      {/* mirror light pool on the table */}
      {light > 0.01 ? (
        <ellipse cx={540} cy={1390} rx={520} ry={120} fill={u.url("pool")} opacity={light * 0.55} />
      ) : null}
      {/* brush cup + brushes */}
      {[
        [170, -14, "#2B2B2B"],
        [200, -4, "#E8C2B4"],
        [230, 8, "#2B2B2B"],
        [250, 18, "#C9967A"],
      ].map(([x, r, c], i) => (
        <g key={i} transform={`rotate(${r} ${x} 1260)`}>
          <rect x={(x as number) - 7} y={1040 + i * 18} width={14} height={240} rx={7} fill={c as string} />
          <rect x={(x as number) - 9} y={1010 + i * 18} width={18} height={40} rx={4} fill={u.url("gold")} />
          <path
            d={`M${(x as number) - 14},${1012 + i * 18} C${(x as number) - 16},${950 + i * 18} ${(x as number) + 16},${950 + i * 18} ${(x as number) + 14},${1012 + i * 18} Z`}
            fill={i % 2 ? "#6B4A3E" : "#3A2A24"}
          />
        </g>
      ))}
      <rect x={140} y={1240} width={140} height={170} rx={16} fill="#F7F1EE" />
      <rect x={140} y={1240} width={140} height={20} rx={8} fill={u.url("gold")} />
      {/* palette */}
      <path d="M220,1440 L480,1440 L500,1500 L200,1500 Z" fill="#2E2A2A" />
      {["#E7B9A6", "#C88A74", "#8E5A4A", "#F2D3C2", "#B27A86", "#6B4A3E"].map((c, i) => (
        <ellipse key={c} cx={250 + i * 42} cy={1470} rx={17} ry={11} fill={c} />
      ))}
      {/* perfume + lipstick + compact */}
      <rect
        x={820}
        y={1250}
        width={120}
        height={170}
        rx={18}
        fill={u.url("bottle")}
        stroke="#ffffff"
        strokeOpacity={0.6}
        strokeWidth={3}
      />
      <rect x={850} y={1300} width={60} height={60} rx={8} fill="#ffffff" opacity={0.3} />
      <rect x={856} y={1206} width={48} height={48} rx={8} fill={u.url("gold")} />
      <rect x={756} y={1340} width={42} height={100} rx={6} fill={u.url("gold")} />
      <path d="M760,1342 L760,1300 C760,1290 794,1280 794,1300 L794,1342 Z" fill="#B3263A" />
      <ellipse cx={680} cy={1466} rx={56} ry={20} fill={u.url("gold")} />
      {/* the mirror */}
      <g transform="translate(140 440)">
        <MirrorArt params={params} ms={ms} />
      </g>
      {/* dusk: the room is dim; the mirror light lifts the area around it */}
      <rect width={1080} height={1920} fill="#2A1820" opacity={0.58 * (1 - light * 0.75)} />
      {light > 0.01 ? (
        <circle
          cx={540}
          cy={850}
          r={640}
          fill={u.url("glow")}
          opacity={light * 0.5}
          style={{ mixBlendMode: "screen" }}
        />
      ) : null}
    </g>
  );
};
