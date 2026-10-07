import type React from "react";
import { num, rgba } from "../util.ts";
import { Lin, Rad, clamp01, scatter, useIds, type VectorProps } from "./shared.tsx";

/* Pet grooming vacuum kit — 1000×800: canister, hose, deshedding brush, attachments. highlight 1 brush · 2 hose/power · 3 cup */

const TEAL = "#1E9E90";
const TEAL_D = "#137A6F";
const FUR = ["#E8C995", "#D9B07A", "#C69A63", "#F2DDB4"];

const FurStrands: React.FC<{
  x: number;
  y: number;
  w: number;
  h: number;
  n: number;
  seed: number;
  width?: number;
}> = ({ x, y, w, h, n, seed, width = 3 }) => (
  <g>
    {scatter(n, x, y, w, h, seed).map((p, i) => (
      <path
        key={i}
        d={`M${p.x},${p.y} q${8 + p.k * 10},${-10 - p.k * 8} ${18 + p.k * 12},${-2} t${14},${6}`}
        fill="none"
        stroke={FUR[i % 4]}
        strokeWidth={width}
        strokeLinecap="round"
      />
    ))}
  </g>
);

export const BrushHead: React.FC<{ u: ReturnType<typeof useIds> }> = ({ u }) => (
  <g>
    {Array.from({ length: 22 }, (_, i) => (
      <rect key={i} x={72 + i * 10} y={244} width={6} height={50} rx={3} fill={u.url("steel")} />
    ))}
    <rect x={50} y={170} width={260} height={84} rx={40} fill={u.url("white")} />
    <rect x={70} y={170} width={220} height={22} rx={11} fill={TEAL} />
    <circle cx={250} cy={218} r={14} fill={TEAL_D} />
    <rect x={292} y={204} width={44} height={54} rx={14} fill={TEAL} />
  </g>
);

export const GroomArt: React.FC<{ params: VectorProps["params"]; ms: number; accent: string }> = ({
  params,
  ms,
  accent,
}) => {
  const u = useIds();
  const fill = clamp01(num(params, "fill", 0.2));
  const power = clamp01(num(params, "power", 0));
  const level = Math.round(num(params, "level", 2));
  const hl = num(params, "highlight", 0);
  const glow = (k: number) => clamp01(1 - Math.abs(hl - k) * 1.5);
  const hose = "M524,520 C430,544 382,470 364,384 C352,330 346,262 336,236";
  return (
    <g>
      <defs>
        <Lin
          id={u.id("white")}
          stops={[
            [0, "#FFFFFF"],
            [0.6, "#EEF2F4"],
            [1, "#CDD5DA"],
          ]}
        />
        <Lin
          id={u.id("teal")}
          stops={[
            [0, "#33B7A8"],
            [1, TEAL_D],
          ]}
        />
        <Lin
          id={u.id("steel")}
          x2={1}
          y2={0}
          stops={[
            [0, "#8E979E"],
            [0.5, "#F2F5F7"],
            [1, "#7C858C"],
          ]}
        />
        <Rad
          id={u.id("glow")}
          stops={[
            [0, accent, 0.55],
            [1, accent, 0],
          ]}
        />
        <clipPath id={u.id("cup")}>
          <rect x={560} y={430} width={230} height={230} rx={34} />
        </clipPath>
      </defs>
      {/* highlight glows */}
      {glow(1) > 0.01 ? (
        <ellipse cx={190} cy={232} rx={210} ry={120} fill={u.url("glow")} opacity={glow(1)} />
      ) : null}
      {glow(2) > 0.01 ? (
        <ellipse cx={420} cy={420} rx={160} ry={200} fill={u.url("glow")} opacity={glow(2)} />
      ) : null}
      {glow(3) > 0.01 ? (
        <ellipse cx={675} cy={545} rx={190} ry={190} fill={u.url("glow")} opacity={glow(3)} />
      ) : null}
      {/* attachments tray */}
      <rect x={40} y={600} width={440} height={170} rx={28} fill="#E9EDF0" />
      <rect x={40} y={600} width={440} height={14} rx={7} fill="#ffffff" opacity={0.7} />
      <g>
        <rect x={70} y={640} width={84} height={56} rx={14} fill="#ffffff" />
        {scatter(24, 76, 696, 72, 22, 3).map((p, i) => (
          <circle key={i} cx={p.x} cy={p.y} r={2.4} fill="#8E979E" />
        ))}
        <rect x={98} y={700} width={28} height={50} rx={10} fill={TEAL} />
        <rect x={176} y={640} width={84} height={40} rx={12} fill="#ffffff" />
        {Array.from({ length: 9 }, (_, i) => (
          <rect key={i} x={182 + i * 9} y={680} width={4} height={44} rx={2} fill={u.url("steel")} />
        ))}
        <path d="M290,648 L360,648 L344,750 L306,750 Z" fill="#ffffff" />
        <rect x={300} y={640} width={50} height={18} rx={8} fill={TEAL} />
        <rect x={386} y={632} width={60} height={118} rx={26} fill={u.url("teal")} />
        <rect x={392} y={632} width={48} height={18} rx={4} fill={u.url("steel")} />
        <circle cx={416} cy={700} r={9} fill="#ffffff" />
      </g>
      {/* hose */}
      <path d={hose} fill="none" stroke="#AEB7BE" strokeWidth={44} strokeLinecap="round" />
      <path d={hose} fill="none" stroke="#8C959C" strokeWidth={44} strokeDasharray="3 7" />
      <path
        d={hose}
        fill="none"
        stroke="#ffffff"
        strokeWidth={6}
        opacity={0.35}
        transform="translate(-8 -4)"
      />
      {power > 0.02 ? (
        <path
          d={hose}
          fill="none"
          stroke="#ffffff"
          strokeWidth={8}
          strokeDasharray="14 40"
          strokeDashoffset={ms * 0.6}
          opacity={0.6 * power}
          strokeLinecap="round"
        />
      ) : null}
      {/* canister */}
      <rect x={520} y={300} width={380} height={390} rx={70} fill={u.url("white")} />
      <path
        d="M520,370 C520,330 550,300 590,300 L830,300 C870,300 900,330 900,370 L900,384 L520,384 Z"
        fill={u.url("teal")}
      />
      <path
        d="M610,322 C610,252 650,236 712,236 C774,236 814,252 814,322"
        fill="none"
        stroke={u.url("teal")}
        strokeWidth={30}
        strokeLinecap="round"
      />
      <path
        d="M624,300 C628,262 660,250 712,250"
        fill="none"
        stroke="#ffffff"
        strokeOpacity={0.35}
        strokeWidth={6}
        strokeLinecap="round"
      />
      <circle cx={656} cy={340} r={20} fill="#ffffff" />
      <path
        d="M656,330 v10 M648,334 a11,11 0 1,0 16,0"
        fill="none"
        stroke={TEAL_D}
        strokeWidth={3.5}
        strokeLinecap="round"
      />
      <circle cx={836} cy={342} r={26} fill="#ffffff" />
      <line
        x1={836}
        y1={342}
        x2={836 + Math.cos(-Math.PI / 2 + (level - 2) * 0.8) * 18}
        y2={342 + Math.sin(-Math.PI / 2 + (level - 2) * 0.8) * 18}
        stroke={TEAL_D}
        strokeWidth={5}
        strokeLinecap="round"
      />
      {[1, 2, 3].map((k) => (
        <rect
          key={`lv${k}`}
          x={712 + k * 22}
          y={358}
          width={14}
          height={8}
          rx={4}
          fill={k <= level ? "#ffffff" : rgba("#ffffff", 0.35)}
        />
      ))}
      {/* clear fur cup */}
      <g clipPath={u.url("cup")}>
        <rect x={560} y={430} width={230} height={230} fill="#DDE9EE" opacity={0.6} />
        <rect
          x={560}
          y={650 - fill * 210}
          width={230}
          height={fill * 210 + 20}
          fill="#E2C08C"
          opacity={0.85}
        />
        <FurStrands
          x={560}
          y={656 - fill * 210}
          w={230}
          h={fill * 210}
          n={Math.round(20 + fill * 60)}
          seed={4}
        />
      </g>
      <rect x={560} y={430} width={230} height={230} rx={34} fill="none" stroke="#ffffff" strokeWidth={4} />
      <rect x={576} y={446} width={14} height={190} rx={7} fill="#ffffff" opacity={0.55} />
      <rect x={650} y={414} width={50} height={18} rx={8} fill={TEAL} />
      <ellipse cx={600} cy={694} rx={40} ry={10} fill="#5A6268" />
      <ellipse cx={820} cy={694} rx={40} ry={10} fill="#5A6268" />
      {/* deshedding brush */}
      <BrushHead u={u} />
    </g>
  );
};

export const GroomKit: React.FC<VectorProps> = ({ params, ms, palette }) => (
  <GroomArt params={params} ms={ms} accent={palette.accent} />
);

/* Dog being groomed in a living room — 1080×1920 (flat illustration, friendly retriever-type dog). */
const COAT = "#D9A55B";
const COAT_L = "#F0C98E";
const COAT_D = "#B9843E";

const Room: React.FC<{ u: ReturnType<typeof useIds> }> = ({ u }) => (
  <>
    <defs>
      <Lin
        id={u.id("wall")}
        stops={[
          [0, "#FFF4E6"],
          [1, "#F6E2CC"],
        ]}
      />
      <Lin
        id={u.id("floor")}
        stops={[
          [0, "#C98B55"],
          [1, "#9C6436"],
        ]}
      />
      <Lin
        id={u.id("win")}
        x1={0}
        y1={0}
        x2={1}
        y2={1}
        stops={[
          [0, "#ffffff", 0.6],
          [1, "#ffffff", 0],
        ]}
      />
    </defs>
    <rect width={1080} height={1920} fill={u.url("wall")} />
    <polygon points="620,120 900,120 700,1180 420,1180" fill={u.url("win")} opacity={0.6} />
    <rect y={1150} width={1080} height={300} fill="#F3DCC3" />
    {[60, 330, 600, 870].map((x) => (
      <rect
        key={x}
        x={x}
        y={1180}
        width={180}
        height={230}
        rx={10}
        fill="none"
        stroke="#E2C6A8"
        strokeWidth={6}
      />
    ))}
    <rect y={1440} width={1080} height={480} fill={u.url("floor")} />
    {Array.from({ length: 6 }, (_, i) => (
      <rect key={i} y={1500 + i * 80} width={1080} height={4} fill="#7A4A22" opacity={0.25} />
    ))}
    <rect x={150} y={330} width={220} height={260} rx={8} fill="#FFFFFF" stroke="#E2541B" strokeWidth={10} />
    <ellipse cx={260} cy={470} rx={46} ry={38} fill="#1E9E90" opacity={0.85} />
    {[
      [214, 412],
      [242, 396],
      [278, 396],
      [306, 412],
    ].map(([x, y]) => (
      <ellipse key={x} cx={x} cy={y} rx={16} ry={20} fill="#1E9E90" opacity={0.85} />
    ))}
  </>
);

export const DogArt: React.FC<{ fur: number; ms: number }> = ({ fur, ms }) => {
  const breathe = Math.sin(ms / 900) * 3;
  const wag = Math.sin(ms / 160) * 9;
  const tufts = scatter(16, 420, 1060, 420, 200, 6);
  return (
    <g>
      {/* tail */}
      <g transform={`rotate(${wag} 850 1170)`}>
        <path
          d="M840,1180 C900,1150 950,1090 960,1000"
          fill="none"
          stroke={COAT_D}
          strokeWidth={52}
          strokeLinecap="round"
        />
        <path
          d="M846,1170 C896,1140 940,1086 948,1010"
          fill="none"
          stroke={COAT}
          strokeWidth={34}
          strokeLinecap="round"
        />
      </g>
      {/* far legs */}
      <rect x={690} y={1250} width={66} height={300} rx={30} fill={COAT_D} />
      <rect x={440} y={1250} width={60} height={300} rx={28} fill={COAT_D} />
      {/* body */}
      <ellipse cx={610} cy={1190 + breathe * 0.4} rx={280} ry={150 + breathe} fill={COAT} />
      <ellipse cx={600} cy={1130} rx={240} ry={70} fill={COAT_L} opacity={0.55} />
      <ellipse cx={620} cy={1300} rx={220} ry={40} fill={COAT_D} opacity={0.35} />
      {/* near legs */}
      <path d="M760,1220 C840,1230 850,1330 820,1420 L812,1550 L752,1550 L748,1400 Z" fill={COAT} />
      <rect x={350} y={1240} width={70} height={312} rx={32} fill={COAT} />
      {[
        [385, 1552],
        [470, 1552],
        [722, 1552],
        [782, 1552],
      ].map(([x, y], i) => (
        <ellipse key={i} cx={x} cy={y} rx={46} ry={20} fill={i % 2 ? COAT_D : COAT_L} />
      ))}
      {/* chest + head */}
      <ellipse cx={390} cy={1130} rx={150} ry={175} fill={COAT} transform="rotate(-18 390 1130)" />
      <ellipse
        cx={370}
        cy={1190}
        rx={90}
        ry={110}
        fill={COAT_L}
        opacity={0.7}
        transform="rotate(-18 370 1190)"
      />
      <path
        d="M300,1050 C340,1100 430,1100 470,1060"
        fill="none"
        stroke={TEAL}
        strokeWidth={26}
        strokeLinecap="round"
      />
      <circle cx={392} cy={1104} r={16} fill="#F4C542" stroke="#C9A12E" strokeWidth={3} />
      <circle cx={300} cy={930} r={132} fill={COAT} />
      <ellipse cx={196} cy={992} rx={98} ry={64} fill={COAT_L} />
      <ellipse cx={114} cy={968} rx={30} ry={24} fill="#2B1D14" />
      <ellipse cx={106} cy={960} rx={9} ry={6} fill="#ffffff" opacity={0.5} />
      <path
        d="M128,1012 C160,1036 196,1036 226,1018"
        fill="none"
        stroke="#5A3A22"
        strokeWidth={6}
        strokeLinecap="round"
      />
      <path d="M170,1030 C172,1066 206,1068 208,1030 Z" fill="#E8707A" />
      <circle cx={276} cy={900} r={17} fill="#2B1D14" />
      <circle cx={270} cy={894} r={6} fill="#ffffff" />
      <path
        d="M250,868 C262,860 284,860 296,866"
        fill="none"
        stroke={COAT_D}
        strokeWidth={6}
        strokeLinecap="round"
      />
      <path
        d="M340,830 C420,840 430,960 410,1060 C400,1100 352,1100 344,1060 C330,990 320,900 340,830 Z"
        fill={COAT_D}
      />
      {/* coat texture */}
      {scatter(40, 400, 1080, 440, 180, 2).map((p, i) => (
        <path
          key={i}
          d={`M${p.x},${p.y} q8,-10 18,-2`}
          fill="none"
          stroke={i % 2 ? COAT_L : COAT_D}
          strokeWidth={3}
          strokeLinecap="round"
          opacity={0.7}
        />
      ))}
      {/* loose fur on the coat */}
      {tufts.map((t, i) =>
        t.k < fur ? (
          <g key={i}>
            <path
              d={`M${t.x},${t.y} q10,-18 26,-6 t20,4`}
              fill="none"
              stroke="#F7E3BE"
              strokeWidth={5}
              strokeLinecap="round"
            />
            <path
              d={`M${t.x + 6},${t.y + 8} q12,-14 28,-4`}
              fill="none"
              stroke="#F7E3BE"
              strokeWidth={4}
              strokeLinecap="round"
            />
          </g>
        ) : null,
      )}
    </g>
  );
};

export const DogScene: React.FC<VectorProps> = ({ params, ms }) => {
  const u = useIds();
  const fur = clamp01(num(params, "fur", 1));
  const brushing = clamp01(num(params, "brushing", 1));
  const bx = Math.sin(ms / 450) * 46 * brushing;
  const floorFur = scatter(28, 120, 1560, 840, 260, 8);
  return (
    <g>
      <defs>
        <Lin
          id={u.id("white")}
          stops={[
            [0, "#FFFFFF"],
            [0.6, "#EEF2F4"],
            [1, "#CDD5DA"],
          ]}
        />
        <Lin
          id={u.id("steel")}
          x2={1}
          y2={0}
          stops={[
            [0, "#8E979E"],
            [0.5, "#F2F5F7"],
            [1, "#7C858C"],
          ]}
        />
      </defs>
      <Room u={u} />
      <ellipse cx={560} cy={1680} rx={540} ry={150} fill={TEAL} />
      <ellipse
        cx={560}
        cy={1680}
        rx={500}
        ry={124}
        fill="none"
        stroke="#E2541B"
        strokeWidth={10}
        strokeDasharray="30 18"
      />
      <ellipse cx={590} cy={1575} rx={380} ry={34} fill="#000" opacity={0.18} />
      {floorFur.map((p, i) =>
        p.k < fur ? (
          <path
            key={i}
            d={`M${p.x},${p.y} q12,-12 26,-3 t18,5`}
            fill="none"
            stroke={FUR[i % 4]}
            strokeWidth={4}
            strokeLinecap="round"
          />
        ) : null,
      )}
      <DogArt fur={fur} ms={ms} />
      {/* brush on the back + hose out of frame */}
      <path
        d={`M${700 + bx},${1028} C820,980 900,860 1100,800`}
        fill="none"
        stroke="#AEB7BE"
        strokeWidth={40}
        strokeLinecap="round"
      />
      <path
        d={`M${700 + bx},${1028} C820,980 900,860 1100,800`}
        fill="none"
        stroke="#8C959C"
        strokeWidth={40}
        strokeDasharray="3 7"
      />
      <g transform={`translate(${430 + bx} ${800}) scale(1.05)`}>
        <BrushHead u={u} />
      </g>
    </g>
  );
};

/* Sofa covered in pet hair, or clean — 1080×1920. */
export const SofaScene: React.FC<VectorProps> = ({ params }) => {
  const u = useIds();
  const fur = clamp01(num(params, "fur", 1));
  const fabric = "#4A5B6E";
  return (
    <g>
      <defs>
        <Lin
          id={u.id("cush")}
          stops={[
            [0, "#5E7085"],
            [1, "#3F4F61"],
          ]}
        />
        <Lin
          id={u.id("seat")}
          stops={[
            [0, "#56687C"],
            [1, "#3A4859"],
          ]}
        />
      </defs>
      <Room u={u} />
      <ellipse cx={540} cy={1700} rx={560} ry={160} fill="#E9D3B8" />
      {/* lamp */}
      <rect x={990} y={620} width={10} height={830} fill="#5A4636" />
      <path d="M930,520 L1060,520 L1030,640 L960,640 Z" fill="#F7E8CF" />
      {/* sofa */}
      <rect x={40} y={960} width={100} height={460} rx={44} fill={u.url("cush")} />
      <rect x={940} y={960} width={100} height={460} rx={44} fill={u.url("cush")} />
      {[100, 390, 680].map((x) => (
        <rect
          key={x}
          x={x}
          y={860}
          width={300}
          height={330}
          rx={46}
          fill={u.url("cush")}
          stroke="#3A4859"
          strokeWidth={4}
        />
      ))}
      {[110, 393, 676].map((x) => (
        <rect
          key={x}
          x={x}
          y={1170}
          width={294}
          height={150}
          rx={36}
          fill={u.url("seat")}
          stroke="#33404F"
          strokeWidth={4}
        />
      ))}
      <rect x={90} y={1300} width={900} height={110} rx={24} fill={fabric} />
      {[150, 900].map((x) => (
        <rect key={x} x={x} y={1406} width={30} height={60} rx={8} fill="#7A5236" />
      ))}
      {/* pillows */}
      <rect x={150} y={960} width={220} height={200} rx={40} fill="#E2541B" transform="rotate(-8 260 1060)" />
      <rect x={720} y={980} width={200} height={190} rx={40} fill="#1E9E90" transform="rotate(7 820 1075)" />
      {/* tennis ball */}
      <circle cx={760} cy={1640} r={44} fill="#C9E14A" />
      <path
        d="M724,1616 C750,1640 750,1664 726,1686 M796,1616 C770,1640 770,1664 794,1686"
        fill="none"
        stroke="#ffffff"
        strokeWidth={6}
      />
      {/* fur */}
      {fur > 0.01 ? (
        <g opacity={fur}>
          <FurStrands x={140} y={1180} w={800} h={120} n={90} seed={2} width={4} />
          <FurStrands x={120} y={900} w={840} h={260} n={70} seed={5} width={3.5} />
          <FurStrands x={120} y={1500} w={820} h={240} n={40} seed={7} width={4} />
          {scatter(9, 200, 1190, 700, 90, 3).map((p, i) => (
            <g key={i}>
              <ellipse cx={p.x} cy={p.y} rx={34} ry={16} fill="#E8C995" opacity={0.7} />
              <FurStrands x={p.x - 30} y={p.y - 10} w={60} h={20} n={8} seed={i + 11} width={3} />
            </g>
          ))}
        </g>
      ) : null}
    </g>
  );
};
