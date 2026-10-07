import type { ParamValue } from "@cre/creative";
import type React from "react";
import { num } from "../util.ts";
import { FONT, Lin, Rad, clamp01, cylStops, scatter, useIds, type VectorProps } from "./shared.tsx";

/* Cordless drill/driver — 800×720, facing left, chuck centre line y=130. Generic design, no brand trade dress. */

const AMBER = "#F2A900";
const AMBER_D = "#B87D00";

export const DrillArt: React.FC<{ params: Record<string, ParamValue>; ms: number }> = ({ params, ms }) => {
  const u = useIds();
  const bit = num(params, "bit", 1) > 0.5;
  const spin = clamp01(num(params, "spin", 0));
  const trig = clamp01(num(params, "trigger", 0));
  const led = clamp01(num(params, "led", 0));
  const charge = clamp01(num(params, "charge", 1));
  const torque = Math.round(num(params, "torque", 12));
  const gear = num(params, "gear", 2);
  const angle = (ms / 1000) * spin * Math.PI * 2 * 1.4;
  const ribs = (x1: number, x2: number, r1: number, r2: number, n: number, key: string) =>
    Array.from({ length: n }, (_, i) => {
      const th = (i / n) * Math.PI * 2 + angle;
      const c = Math.cos(th);
      if (c <= 0.05) return null;
      const y1 = 130 + r1 * Math.sin(th);
      const y2 = 130 + r2 * Math.sin(th);
      return (
        <line
          key={`${key}${i}`}
          x1={x1}
          y1={y1}
          x2={x2}
          y2={y2}
          stroke="#000"
          strokeWidth={3}
          opacity={(0.25 + 0.5 * c) * (1 - spin * 0.6)}
        />
      );
    });
  const grooveShift = ((ms / 1000) * spin * 180) % 14;
  const lit = Math.ceil(charge * 4 - 0.001);
  return (
    <g>
      <defs>
        <Lin
          id={u.id("body")}
          stops={[
            [0, "#5A616B"],
            [0.3, "#3A4048"],
            [0.75, "#23272D"],
            [1, "#16191D"],
          ]}
        />
        <Lin
          id={u.id("handle")}
          x2={1}
          y2={0}
          stops={[
            [0, "#4A5059"],
            [0.45, "#30353C"],
            [1, "#1A1D21"],
          ]}
        />
        <Lin
          id={u.id("cap")}
          stops={[
            [0, "#2C3036"],
            [0.5, "#1A1C20"],
            [1, "#0E0F11"],
          ]}
        />
        <Lin id={u.id("ring")} stops={cylStops("#30353C", "#5E656F", "#15171A")} />
        <Lin id={u.id("chuck")} stops={cylStops("#1F2226", "#4A5058", "#0C0D0F")} />
        <Lin id={u.id("nose")} stops={cylStops("#8E959E", "#EEF1F4", "#5A6068")} />
        <Lin id={u.id("gold")} stops={cylStops("#C99A2E", "#FFE29A", "#7A5A12")} />
        <Lin
          id={u.id("amber")}
          stops={[
            [0, "#FFD15C"],
            [0.5, AMBER],
            [1, AMBER_D],
          ]}
        />
        <Lin
          id={u.id("batt")}
          stops={[
            [0, "#30343A"],
            [0.12, "#1F2226"],
            [1, "#0F1012"],
          ]}
        />
        <Lin
          id={u.id("beam")}
          x1={414}
          y1={566}
          x2={60}
          y2={160}
          units="userSpaceOnUse"
          stops={[
            [0, "#FFF6D8", 0.55],
            [1, "#FFF6D8", 0],
          ]}
        />
        <Rad
          id={u.id("ledglow")}
          stops={[
            [0, "#FFFBEA", 1],
            [0.35, "#FFE9A8", 0.6],
            [1, "#FFE9A8", 0],
          ]}
        />
        <pattern
          id={u.id("grip")}
          width="12"
          height="12"
          patternUnits="userSpaceOnUse"
          patternTransform="rotate(45)"
        >
          <rect width="12" height="12" fill="#17191C" />
          <rect x="3" y="3" width="6" height="6" rx="1" fill="#24272C" />
        </pattern>
        <clipPath id={u.id("flute")}>
          <rect x={40} y={121} width={86} height={18} rx={3} />
        </clipPath>
        <clipPath id={u.id("ringclip")}>
          <rect x={286} y={60} width={60} height={140} rx={18} />
        </clipPath>
      </defs>

      {/* LED work-light beam (behind everything) */}
      {led > 0.01 ? <polygon points="414,566 0,40 0,330" fill={u.url("beam")} opacity={led} /> : null}

      {/* handle */}
      <path
        d="M440,212 C452,300 462,420 470,548 L642,548 C632,420 620,300 616,212 Z"
        fill={u.url("handle")}
      />
      <path d="M552,236 C566,320 578,430 588,530 L640,530 C630,420 619,320 614,236 Z" fill={u.url("grip")} />
      <path d="M448,300 C456,380 462,460 468,530 L490,530 C484,450 476,370 468,300 Z" fill="#16181B" />
      <path
        d="M445,215 C456,300 465,420 472,546"
        fill="none"
        stroke="#ffffff"
        strokeOpacity={0.12}
        strokeWidth={3}
      />

      {/* trigger + direction switch */}
      <g transform={`translate(${trig * 16} 0)`}>
        <path
          d="M454,236 L412,240 C400,242 395,252 397,263 L407,320 C409,332 420,339 432,336 L460,330 Z"
          fill={u.url("amber")}
        />
        <path
          d="M410,248 L448,244"
          stroke="#ffffff"
          strokeOpacity={0.45}
          strokeWidth={3}
          strokeLinecap="round"
        />
      </g>
      <rect x={454} y={224} width={34} height={20} rx={7} fill="#2A2E34" stroke="#454B53" strokeWidth={1.5} />
      <polygon points="462,234 472,228 472,240" fill={AMBER} />

      {/* foot + LED */}
      <path
        d="M420,546 L708,546 C722,546 730,556 730,570 L730,588 L404,588 L404,566 C404,555 410,546 420,546 Z"
        fill={u.url("body")}
      />
      <rect x={406} y={556} width={12} height={20} rx={4} fill={led > 0.01 ? "#FFFBEA" : "#C9CED4"} />
      {led > 0.01 ? <circle cx={412} cy={566} r={46} fill={u.url("ledglow")} opacity={led} /> : null}

      {/* battery */}
      <rect x={404} y={588} width={340} height={112} rx={20} fill={u.url("batt")} />
      <rect x={404} y={588} width={340} height={24} rx={10} fill="#2F3339" />
      <rect x={414} y={596} width={42} height={12} rx={6} fill={AMBER} />
      {Array.from({ length: 8 }, (_, i) => (
        <rect key={i} x={474 + i * 13} y={624} width={5} height={56} rx={2.5} fill="#08090A" />
      ))}
      <circle cx={588} cy={652} r={8} fill="#2C3036" stroke="#4A5058" strokeWidth={1.5} />
      {Array.from({ length: 4 }, (_, i) => (
        <rect
          key={i}
          x={604 + i * 22}
          y={648}
          width={16}
          height={9}
          rx={4.5}
          fill={i < lit ? "#7CF07C" : "#2A2E33"}
        />
      ))}
      {lit > 0 ? <rect x={598} y={640} width={92} height={25} rx={12} fill="#7CF07C" opacity={0.12} /> : null}
      <text x={604} y={688} fontFamily={FONT} fontWeight={700} fontSize={15} fill="#8C939C" letterSpacing={1}>
        20V · 2.0Ah
      </text>
      <path d="M412,698 L736,698" stroke="#ffffff" strokeOpacity={0.08} strokeWidth={2} />

      {/* motor housing */}
      <path
        d="M346,62 C420,46 560,40 664,46 C738,50 776,84 776,130 C776,180 740,214 668,218 L432,216 C392,214 362,208 346,200 Z"
        fill={u.url("body")}
      />
      <path
        d="M640,45 C720,48 776,84 776,130 C776,178 738,214 668,218 L640,218 C626,190 620,160 620,130 C620,98 628,68 640,45 Z"
        fill={u.url("cap")}
      />
      {[672, 690, 708, 726].map((x) => (
        <g key={x}>
          <rect x={x} y={94} width={8} height={72} rx={4} fill="#060708" />
          <rect x={x + 1} y={95} width={2} height={70} rx={1} fill="#ffffff" opacity={0.08} />
        </g>
      ))}
      <path d="M362,74 C430,58 560,52 640,56 L640,66 C560,62 440,68 364,84 Z" fill="#ffffff" opacity={0.2} />
      <path d="M350,150 L620,152" stroke="#121417" strokeWidth={2} opacity={0.7} />
      {[
        [384, 196],
        [600, 202],
        [700, 196],
      ].map(([x, y]) => (
        <g key={`${x}`}>
          <circle cx={x} cy={y} r={6} fill="#14161A" />
          <circle cx={x! - 1} cy={y! - 1} r={2} fill="#5A616B" />
        </g>
      ))}
      <text
        x={418}
        y={146}
        fontFamily={FONT}
        fontWeight={700}
        fontStyle="italic"
        fontSize={54}
        fill={AMBER}
        letterSpacing={-1}
      >
        20V
      </text>
      <text
        x={420}
        y={178}
        fontFamily={FONT}
        fontWeight={700}
        fontSize={14}
        fill="#9AA1AA"
        letterSpacing={3.5}
      >
        DRILL · DRIVER
      </text>

      {/* gear selector */}
      <rect x={520} y={28} width={86} height={22} rx={10} fill="#16181B" stroke="#3A3F46" strokeWidth={1.5} />
      <rect x={gear >= 1.5 ? 566 : 524} y={31} width={36} height={16} rx={8} fill={AMBER} />
      <text x={536} y={22} fontFamily={FONT} fontWeight={700} fontSize={13} fill="#9AA1AA">
        1
      </text>
      <text x={580} y={22} fontFamily={FONT} fontWeight={700} fontSize={13} fill="#9AA1AA">
        2
      </text>

      {/* amber collar + clutch ring with numbers */}
      <rect x={344} y={60} width={9} height={140} fill={AMBER} />
      <rect x={284} y={56} width={64} height={148} rx={20} fill={u.url("ring")} />
      <g clipPath={u.url("ringclip")}>
        {[-2, -1, 0, 1, 2].map((d) => {
          const v = torque + d;
          if (v < 1 || v > 21) return null;
          return (
            <text
              key={d}
              x={316}
              y={138 + d * 34}
              textAnchor="middle"
              fontFamily={FONT}
              fontWeight={700}
              fontSize={d === 0 ? 24 : 18}
              fill={d === 0 ? "#FFFFFF" : "#AEB4BC"}
              opacity={d === 0 ? 1 : 0.55 - Math.abs(d) * 0.15}
            >
              {v}
            </text>
          );
        })}
      </g>
      <polygon points="364,122 364,138 352,130" fill={AMBER} />

      {/* chuck */}
      <rect x={214} y={72} width={72} height={116} rx={14} fill={u.url("chuck")} />
      {ribs(220, 280, 56, 56, 18, "b")}
      <path d="M218,76 L218,184 L158,170 L158,90 Z" fill={u.url("chuck")} />
      {ribs(162, 214, 38, 52, 14, "f")}
      <rect x={140} y={98} width={22} height={64} rx={6} fill={u.url("nose")} />

      {/* bit */}
      {bit ? (
        <g>
          <rect x={118} y={122} width={26} height={16} rx={2} fill={u.url("gold")} />
          <rect x={40} y={121} width={86} height={18} rx={3} fill={u.url("gold")} />
          <g clipPath={u.url("flute")}>
            {Array.from({ length: 9 }, (_, i) => {
              const x = 30 + i * 14 - grooveShift;
              return (
                <path key={i} d={`M${x},121 L${x + 9},139`} stroke="#6E4E0C" strokeWidth={4} opacity={0.75} />
              );
            })}
          </g>
          <polygon points="40,121 40,139 25,130" fill="#B8892A" />
        </g>
      ) : null}
      {spin > 0.2 ? (
        <g opacity={spin * 0.5}>
          <path
            d="M150,62 Q215,48 284,60"
            fill="none"
            stroke="#ffffff"
            strokeWidth={2}
            strokeLinecap="round"
            opacity={0.5}
          />
          <path
            d="M150,198 Q215,212 284,200"
            fill="none"
            stroke="#ffffff"
            strokeWidth={2}
            strokeLinecap="round"
            opacity={0.5}
          />
        </g>
      ) : null}
    </g>
  );
};

export const Drill: React.FC<VectorProps> = ({ params, ms }) => <DrillArt params={params} ms={ms} />;

/* Workshop scene — 1080×1920: timber post on the left, the drill driving a screw into its side face. */
export const DrillWork: React.FC<VectorProps> = ({ params, ms }) => {
  const u = useIds();
  const drive = clamp01(num(params, "drive", 0.4));
  const spin = clamp01(num(params, "spin", 1));
  const hx = 330 + (1 - drive) * 64;
  const s = 0.98;
  const tx = hx + 12 - 26 * s;
  const ty = 900 - 130 * s + Math.sin(ms * 0.09) * 1.4 * spin;
  const dust = scatter(26, 334, 868, 46, 64, 3);
  return (
    <g>
      <defs>
        <pattern id={u.id("peg")} width="54" height="54" patternUnits="userSpaceOnUse">
          <rect width="54" height="54" fill="#3B332B" />
          <circle cx="27" cy="27" r="6" fill="#16120E" />
          <circle
            cx="27"
            cy="28.5"
            r="6"
            fill="none"
            stroke="#ffffff"
            strokeOpacity="0.06"
            strokeWidth="1.5"
          />
        </pattern>
        <Lin
          id={u.id("post")}
          x2={1}
          y2={0}
          stops={[
            [0, "#B8834A"],
            [0.35, "#D9AE72"],
            [0.8, "#E6C38C"],
            [0.97, "#C9995C"],
            [1, "#8C6234"],
          ]}
        />
        <Lin
          id={u.id("bench")}
          stops={[
            [0, "#7A5434"],
            [0.08, "#5C3E25"],
            [1, "#2E1F13"],
          ]}
        />
        <Rad
          id={u.id("spot")}
          cx={0.32}
          cy={0.42}
          r={0.75}
          stops={[
            [0, "#FFE7B5", 0.32],
            [0.5, "#FFE7B5", 0.08],
            [1, "#000000", 0],
          ]}
        />
        <Rad
          id={u.id("vig")}
          cx={0.45}
          cy={0.48}
          r={0.78}
          stops={[
            [0.55, "#000000", 0],
            [1, "#000000", 0.6],
          ]}
        />
        <Lin id={u.id("zinc")} stops={cylStops("#9AA1A9", "#F1F4F7", "#5D646C")} />
        <Lin
          id={u.id("tape")}
          stops={[
            [0, "#FFD15C"],
            [1, "#C98F00"],
          ]}
        />
      </defs>
      <rect width={1080} height={1920} fill="#2B2620" />
      <rect x={330} width={750} height={1500} fill={u.url("peg")} />
      {/* tape measure + wrench on the pegboard */}
      <g transform="translate(700 380)">
        <rect x={-72} y={-66} width={150} height={132} rx={40} fill={u.url("tape")} />
        <rect x={-50} y={-44} width={106} height={88} rx={28} fill="#1E1E1E" />
        <circle cx={3} cy={0} r={22} fill="#2E2E2E" stroke="#4A4A4A" strokeWidth={3} />
        <rect x={76} y={30} width={60} height={18} rx={3} fill="#F4E27A" />
        <path d="M86 30v8M96 30v12M106 30v8M116 30v12M126 30v8" stroke="#222" strokeWidth={2} />
      </g>
      <g transform="translate(905 250) rotate(18)">
        <rect x={-13} y={40} width={26} height={330} rx={11} fill="#8A5A2E" />
        <rect x={-13} y={250} width={26} height={120} rx={11} fill="#1E1E1E" />
        <rect x={-7} y={50} width={5} height={190} rx={2.5} fill="#ffffff" opacity={0.25} />
        <path d="M-70,0 L50,0 C70,0 84,10 92,28 L60,30 C50,22 40,30 22,30 L-70,30 Z" fill="#AEB5BD" />
        <path
          d="M-70,0 L50,0 C70,0 84,10 92,28"
          fill="none"
          stroke="#ffffff"
          strokeOpacity={0.5}
          strokeWidth={3}
        />
        <rect x={-80} y={-4} width={22} height={38} rx={4} fill="#8E959E" />
      </g>
      {/* timber post */}
      <rect x={0} width={332} height={1500} fill={u.url("post")} />
      {Array.from({ length: 11 }, (_, i) => {
        const x = 18 + i * 29;
        return (
          <path
            key={i}
            d={`M${x},0 C${x + 10},300 ${x - 12},620 ${x + 6},900 S${x - 6},1300 ${x + 4},1500`}
            fill="none"
            stroke="#8C5E2E"
            strokeWidth={i % 3 === 0 ? 3 : 1.6}
            opacity={0.28 + (i % 4) * 0.06}
          />
        );
      })}
      <ellipse cx={150} cy={1240} rx={22} ry={46} fill="#9A6A36" opacity={0.6} />
      <ellipse cx={150} cy={1240} rx={10} ry={26} fill="#6E4721" opacity={0.6} />
      <rect x={322} width={10} height={1500} fill="#7A5228" opacity={0.55} />
      {/* finished screw above */}
      <rect x={330} y={680} width={8} height={40} rx={3} fill={u.url("zinc")} />
      <ellipse cx={332} cy={700} rx={6} ry={26} fill="#E9D3A8" opacity={0.5} />
      {/* screw being driven */}
      <rect x={330} y={892} width={Math.max(0, hx - 330)} height={16} fill={u.url("zinc")} />
      {Array.from({ length: 12 }, (_, i) => {
        const x = 330 + i * 7;
        return x < hx - 3 ? (
          <path key={i} d={`M${x},892 L${x + 5},908`} stroke="#5D646C" strokeWidth={2} />
        ) : null;
      })}
      <path d={`M${hx},878 L${hx + 6},878 Q${hx + 14},900 ${hx + 6},922 L${hx},922 Z`} fill={u.url("zinc")} />
      {dust.map((d, i) => (
        <ellipse
          key={i}
          cx={d.x}
          cy={d.y}
          rx={2 + d.k * 4}
          ry={1.5 + d.k * 2}
          fill="#EBD2A2"
          opacity={0.75}
        />
      ))}
      {/* bench */}
      <rect y={1480} width={1080} height={440} fill={u.url("bench")} />
      <rect y={1480} width={1080} height={8} fill="#A57A4E" opacity={0.6} />
      <g transform="translate(160 1600) rotate(-8)">
        <rect width={260} height={18} rx={4} fill="#F2C230" />
        <polygon points="260,0 296,9 260,18" fill="#E9C9A0" />
        <polygon points="286,6 296,9 286,12" fill="#333" />
      </g>
      {[
        [620, 1640, 20],
        [700, 1610, -35],
        [780, 1660, 70],
      ].map(([x, y, r]) => (
        <g key={x} transform={`translate(${x} ${y}) rotate(${r})`}>
          <rect x={0} y={-6} width={70} height={12} rx={2} fill={u.url("zinc")} />
          <rect x={-8} y={-14} width={10} height={28} rx={3} fill="#C9CED4" />
        </g>
      ))}
      {/* the drill */}
      <g transform={`translate(${tx} ${ty}) scale(${s})`}>
        <DrillArt params={{ ...params, bit: 1, spin }} ms={ms} />
      </g>
      <rect width={1080} height={1920} fill={u.url("spot")} />
      <rect width={1080} height={1920} fill={u.url("vig")} />
    </g>
  );
};
