import type React from "react";
import { num, rgba, str } from "../util.ts";
import { FONT, Lin, Rad, clamp01, useIds, type VectorProps } from "./shared.tsx";

/* 8-in-1 USB-C hub — 1000×640, three-quarter front view (top face + port face). */

const PORTS = [
  { id: "pd", x: 192, label: "PD" },
  { id: "hdmi", x: 276, label: "HDMI" },
  { id: "usba", x: 366, label: "USB" },
  { id: "usba2", x: 446, label: "USB" },
  { id: "usbc", x: 530, label: "C" },
  { id: "sd", x: 616, label: "SD" },
  { id: "microsd", x: 704, label: "TF" },
  { id: "ethernet", x: 806, label: "LAN" },
] as const;
const PY = 392;

const Port: React.FC<{ id: string; x: number }> = ({ id, x }) => {
  const hole = "#08090B";
  switch (id) {
    case "pd":
    case "usbc":
      return (
        <g>
          <rect
            x={x - 21}
            y={PY - 8}
            width={42}
            height={16}
            rx={8}
            fill={hole}
            stroke="#5B626B"
            strokeWidth={1.5}
          />
          <rect x={x - 13} y={PY - 2} width={26} height={4} rx={2} fill="#3A3F46" />
        </g>
      );
    case "hdmi":
      return (
        <g>
          <path
            d={`M${x - 31},${PY - 11} L${x + 31},${PY - 11} L${x + 31},${PY} L${x + 23},${PY + 11} L${x - 23},${PY + 11} L${x - 31},${PY} Z`}
            fill={hole}
            stroke="#5B626B"
            strokeWidth={1.5}
          />
          <rect x={x - 22} y={PY - 5} width={44} height={5} rx={1} fill="#3A3F46" />
        </g>
      );
    case "usba":
    case "usba2":
      return (
        <g>
          <rect
            x={x - 26}
            y={PY - 11}
            width={52}
            height={22}
            rx={2}
            fill={hole}
            stroke="#5B626B"
            strokeWidth={1.5}
          />
          <rect x={x - 20} y={PY - 7} width={40} height={7} rx={1} fill="#2D6BFF" />
        </g>
      );
    case "sd":
      return (
        <rect
          x={x - 38}
          y={PY - 5}
          width={76}
          height={10}
          rx={3}
          fill={hole}
          stroke="#5B626B"
          strokeWidth={1.5}
        />
      );
    case "microsd":
      return (
        <rect
          x={x - 26}
          y={PY - 4}
          width={52}
          height={8}
          rx={3}
          fill={hole}
          stroke="#5B626B"
          strokeWidth={1.5}
        />
      );
    default:
      return (
        <g>
          <path
            d={`M${x - 31},${PY - 22} L${x + 31},${PY - 22} L${x + 31},${PY + 22} L${x + 12},${PY + 22} L${x + 12},${PY + 30} L${x - 12},${PY + 30} L${x - 12},${PY + 22} L${x - 31},${PY + 22} Z`}
            fill={hole}
            stroke="#5B626B"
            strokeWidth={1.5}
          />
          {Array.from({ length: 8 }, (_, i) => (
            <rect key={i} x={x - 22 + i * 6} y={PY - 18} width={3} height={8} fill="#C8A44A" />
          ))}
        </g>
      );
  }
};

export const HubArt: React.FC<{ params: VectorProps["params"]; ms: number; accent: string }> = ({
  params,
  ms,
  accent,
}) => {
  const u = useIds();
  const led = clamp01(num(params, "led", 1));
  const glow = str(params, "glow", "");
  const net = num(params, "net", 1) > 0.5;
  const blink = Math.floor(ms / 260) % 3 !== 0;
  const g = PORTS.find((p) => p.id === glow);
  return (
    <g>
      <defs>
        <Lin
          id={u.id("front")}
          stops={[
            [0, "#2E3238"],
            [0.25, "#4A5058"],
            [1, "#24272C"],
          ]}
        />
        <Lin
          id={u.id("top")}
          x1={0}
          y1={0}
          x2={0.25}
          y2={1}
          stops={[
            [0, "#B9C0C8"],
            [0.55, "#8D949D"],
            [1, "#6F767F"],
          ]}
        />
        <Lin
          id={u.id("plug")}
          x2={1}
          y2={0}
          stops={[
            [0, "#6F767F"],
            [0.4, "#D9DEE3"],
            [1, "#7C838C"],
          ]}
        />
        <Rad
          id={u.id("glow")}
          stops={[
            [0, accent, 0.55],
            [1, accent, 0],
          ]}
        />
        <Rad
          id={u.id("led")}
          stops={[
            [0, "#C9F4FF", 1],
            [0.4, "#7FE6FF", 0.5],
            [1, "#7FE6FF", 0],
          ]}
        />
        <clipPath id={u.id("topclip")}>
          <rect x={130} y={200} width={770} height={130} rx={72} ry={56} />
        </clipPath>
      </defs>
      {/* braided cable + plug */}
      <path
        d="M152,334 C80,334 58,300 68,238 C80,170 120,150 120,118"
        fill="none"
        stroke="#24272C"
        strokeWidth={26}
        strokeLinecap="round"
      />
      <path
        d="M152,334 C80,334 58,300 68,238 C80,170 120,150 120,118"
        fill="none"
        stroke="#4E545C"
        strokeWidth={22}
        strokeDasharray="5 6"
        opacity={0.6}
      />
      <rect x={96} y={40} width={48} height={84} rx={14} fill={u.url("plug")} />
      <rect x={104} y={16} width={32} height={28} rx={7} fill="#C9CED4" />
      <rect x={110} y={24} width={20} height={9} rx={4} fill="#3A3F46" />
      {/* body */}
      <rect x={130} y={200} width={770} height={262} rx={72} ry={64} fill={u.url("front")} />
      <rect x={130} y={200} width={770} height={130} rx={72} ry={56} fill={u.url("top")} />
      <g clipPath={u.url("topclip")} opacity={0.5}>
        {Array.from({ length: 32 }, (_, i) => (
          <rect key={i} x={130} y={202 + i * 4} width={770} height={1} fill="#ffffff" opacity={0.08} />
        ))}
        <polygon points="300,200 520,200 400,330 180,330" fill="#ffffff" opacity={0.16} />
      </g>
      <path d="M206,330 L824,330" stroke="#E6EAEE" strokeWidth={3} opacity={0.75} />
      <rect x={180} y={334} width={670} height={10} fill="#000" opacity={0.18} />
      <text
        x={516}
        y={276}
        textAnchor="middle"
        fontFamily={FONT}
        fontWeight={700}
        fontSize={22}
        fill="#ffffff"
        opacity={0.42}
        letterSpacing={7}
      >
        8-IN-1
      </text>
      <circle cx={822} cy={252} r={5} fill={led > 0.05 ? "#B9F2FF" : "#59616A"} />
      {led > 0.05 ? <circle cx={822} cy={252} r={20} fill={u.url("led")} opacity={led} /> : null}
      {g ? <ellipse cx={g.x} cy={PY} rx={66} ry={40} fill={u.url("glow")} /> : null}
      {PORTS.map((p) => (
        <Port key={p.id} id={p.id} x={p.x} />
      ))}
      {net ? (
        <>
          <rect x={777} y={364} width={7} height={5} fill={blink ? "#5BFF7A" : "#1D4D27"} />
          <rect x={828} y={364} width={7} height={5} fill="#FFB547" />
        </>
      ) : null}
      {PORTS.map((p) => (
        <text
          key={`${p.id}l`}
          x={p.x}
          y={p.id === "ethernet" ? 446 : 436}
          textAnchor="middle"
          fontFamily={FONT}
          fontWeight={700}
          fontSize={14}
          fill="#A3ABB4"
          letterSpacing={1}
        >
          {p.label}
        </text>
      ))}
      {g ? (
        <ellipse cx={g.x} cy={PY} rx={56} ry={32} fill="none" stroke={accent} strokeWidth={3} opacity={0.9} />
      ) : null}
    </g>
  );
};

export const Hub: React.FC<VectorProps> = ({ params, ms, palette }) => (
  <HubArt params={params} ms={ms} accent={palette.accent} />
);

/* Laptop screen listing the devices connected through the hub — 1200×900. */
const ROWS = [
  { icon: "display", label: "External display", detail: "4K · HDMI" },
  { icon: "lan", label: "Ethernet", detail: "1 Gbps" },
  { icon: "usb", label: "USB drive", detail: "USB-A · 5 Gbps" },
  { icon: "sd", label: "SD card", detail: "64 GB" },
  { icon: "bolt", label: "Charging", detail: "PD · 100 W" },
  { icon: "keys", label: "Keyboard + mouse", detail: "USB-A" },
] as const;

const Glyph: React.FC<{ kind: string; x: number; y: number; color: string }> = ({ kind, x, y, color }) => {
  const s = {
    fill: "none",
    stroke: color,
    strokeWidth: 3,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
  };
  switch (kind) {
    case "display":
      return <path d={`M${x - 11},${y - 8} h22 v14 h-22 Z M${x - 5},${y + 11} h10`} {...s} />;
    case "lan":
      return <path d={`M${x - 10},${y - 8} h20 v12 h-6 v4 h-8 v-4 h-6 Z`} {...s} />;
    case "usb":
      return (
        <path
          d={`M${x},${y + 11} v-20 M${x},${y - 9} l-4,5 M${x},${y - 9} l4,5 M${x},${y + 2} l-7,-5 v-4 M${x},${y + 5} l7,-5 v-3`}
          {...s}
        />
      );
    case "sd":
      return <path d={`M${x - 8},${y - 11} h12 l5,5 v17 h-17 Z`} {...s} />;
    case "bolt":
      return <path d={`M${x + 2},${y - 12} l-9,13 h8 l-3,11 l9,-13 h-8 Z`} {...s} />;
    default:
      return (
        <path
          d={`M${x - 12},${y - 6} h24 v12 h-24 Z M${x - 7},${y} h2 M${x - 1},${y} h2 M${x + 5},${y} h2`}
          {...s}
        />
      );
  }
};

export const HubScreen: React.FC<VectorProps> = ({ params, palette }) => {
  const u = useIds();
  const items = num(params, "items", 6);
  const toggle = clamp01(num(params, "toggle", 0));
  const accent = palette.accent;
  return (
    <g>
      <defs>
        <Lin
          id={u.id("wall")}
          x1={0}
          y1={0}
          x2={1}
          y2={1}
          stops={[
            [0, "#12365C"],
            [0.55, "#0B1A30"],
            [1, "#081020"],
          ]}
        />
        <Rad
          id={u.id("blobA")}
          stops={[
            [0, accent, 0.4],
            [1, accent, 0],
          ]}
        />
        <Rad
          id={u.id("blobB")}
          stops={[
            [0, palette.accent2, 0.3],
            [1, palette.accent2, 0],
          ]}
        />
        <Lin
          id={u.id("base")}
          stops={[
            [0, "#D3D8DE"],
            [1, "#8A919A"],
          ]}
        />
        <clipPath id={u.id("screen")}>
          <rect x={138} y={52} width={924} height={588} rx={6} />
        </clipPath>
      </defs>
      <rect x={110} y={24} width={980} height={648} rx={28} fill="#14171C" stroke="#2C3138" strokeWidth={2} />
      <circle cx={600} cy={38} r={4} fill="#2A2F36" />
      <g clipPath={u.url("screen")}>
        <rect x={138} y={52} width={924} height={588} fill={u.url("wall")} />
        <circle cx={260} cy={560} r={300} fill={u.url("blobA")} />
        <circle cx={1000} cy={120} r={320} fill={u.url("blobB")} />
        {/* window */}
        <rect
          x={250}
          y={104}
          width={700}
          height={496}
          rx={18}
          fill="#0E141D"
          opacity={0.95}
          stroke="#ffffff"
          strokeOpacity={0.08}
          strokeWidth={1.5}
        />
        {["#FF5F57", "#FEBC2E", "#28C840"].map((c, i) => (
          <circle key={c} cx={278 + i * 22} cy={132} r={7} fill={c} />
        ))}
        <text
          x={600}
          y={140}
          textAnchor="middle"
          fontFamily={FONT}
          fontWeight={700}
          fontSize={21}
          fill="#E6EDF5"
        >
          Hub · 8-in-1
        </text>
        <rect x={806} y={118} width={120} height={28} rx={14} fill="#1F6F3D" />
        <circle cx={824} cy={132} r={5} fill="#5BFF7A" />
        <text x={836} y={138} fontFamily={FONT} fontWeight={700} fontSize={15} fill="#CFFFD9">
          Connected
        </text>
        <rect x={250} y={160} width={700} height={1.5} fill="#ffffff" opacity={0.08} />
        {ROWS.map((r, i) => {
          const a = clamp01(items - i);
          if (a <= 0) return null;
          const y = 172 + i * 60;
          return (
            <g key={r.label} opacity={a} transform={`translate(${(1 - a) * 28} 0)`}>
              <rect x={272} y={y + 6} width={44} height={44} rx={12} fill={rgba(accent, 0.16)} />
              <Glyph kind={r.icon} x={294} y={y + 28} color={accent} />
              <text x={334} y={y + 36} fontFamily={FONT} fontWeight={700} fontSize={22} fill="#E6EDF5">
                {r.label}
              </text>
              <text
                x={880}
                y={y + 36}
                textAnchor="end"
                fontFamily={FONT}
                fontWeight={700}
                fontSize={18}
                fill="#8FA0B3"
              >
                {r.detail}
              </text>
              <circle cx={910} cy={y + 29} r={11} fill={rgba(accent, 0.2)} />
              <path
                d={`M904,${y + 29} l4,4 l8,-8`}
                fill="none"
                stroke={accent}
                strokeWidth={3}
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </g>
          );
        })}
        <rect x={272} y={540} width={656} height={44} rx={12} fill="#ffffff" opacity={0.05} />
        <text x={292} y={570} fontFamily={FONT} fontWeight={700} fontSize={20} fill="#E6EDF5">
          Extend display
        </text>
        <rect x={840} y={545} width={64} height={34} rx={17} fill={toggle > 0.5 ? accent : "#3A4350"} />
        <circle cx={857 + toggle * 30} cy={562} r={13} fill="#ffffff" />
        <rect x={420} y={604} width={360} height={30} rx={12} fill="#ffffff" opacity={0.12} />
        {["#FF8A5B", accent, "#B8F34B", "#FFD15C", "#C08BFF", "#7FA7FF"].map((c, i) => (
          <rect key={c + i} x={442 + i * 56} y={609} width={20} height={20} rx={6} fill={c} opacity={0.9} />
        ))}
      </g>
      <rect x={110} y={672} width={980} height={12} fill="#0B0C0F" />
      <path
        d="M30,684 L1170,684 C1176,684 1180,690 1176,696 L1150,736 C1144,746 1134,752 1120,752 L80,752 C66,752 56,746 50,736 L24,696 C20,690 24,684 30,684 Z"
        fill={u.url("base")}
      />
      <rect x={520} y={684} width={160} height={10} rx={5} fill="#9AA1A9" />
      {/* the hub on the desk, plugged into the laptop */}
      <path
        d="M1168,712 C1186,730 1180,770 1150,790"
        fill="none"
        stroke="#24272C"
        strokeWidth={12}
        strokeLinecap="round"
      />
      <rect x={1050} y={786} width={146} height={44} rx={20} fill="#7C838C" />
      <rect x={1050} y={786} width={146} height={22} rx={11} fill="#B4BBC3" />
      <circle cx={1178} cy={797} r={3} fill="#B9F2FF" />
    </g>
  );
};

/* Top-down desks for the side-by-side — 1080×1920, content concentrated in the central column. */
const Desk: React.FC<{ u: ReturnType<typeof useIds> }> = ({ u }) => (
  <>
    <defs>
      <pattern id={u.id("wood")} width="1080" height="240" patternUnits="userSpaceOnUse">
        <rect width="1080" height="240" fill="#7A5133" />
        <rect y="0" width="1080" height="3" fill="#4E321E" opacity="0.6" />
        <path
          d="M0,60 C200,40 420,90 640,60 S960,40 1080,70"
          fill="none"
          stroke="#5E3D25"
          strokeWidth="2"
          opacity="0.5"
        />
        <path
          d="M0,140 C240,120 380,170 620,150 S900,120 1080,150"
          fill="none"
          stroke="#8E6243"
          strokeWidth="3"
          opacity="0.4"
        />
        <path
          d="M0,200 C180,190 460,220 700,205 S980,190 1080,210"
          fill="none"
          stroke="#5E3D25"
          strokeWidth="1.5"
          opacity="0.45"
        />
      </pattern>
      <Lin
        id={u.id("lid")}
        stops={[
          [0, "#8F969E"],
          [1, "#CDD2D8"],
        ]}
      />
      <Lin
        id={u.id("alu")}
        stops={[
          [0, "#D6DADF"],
          [1, "#B3B9C1"],
        ]}
      />
      <Rad
        id={u.id("light")}
        cx={0.4}
        cy={0.35}
        r={0.8}
        stops={[
          [0, "#FFE9C8", 0.22],
          [1, "#000000", 0.35],
        ]}
      />
    </defs>
    <rect width={1080} height={1920} fill={u.url("wood")} />
  </>
);

const Laptop: React.FC<{ u: ReturnType<typeof useIds> }> = ({ u }) => (
  <g>
    <rect x={292} y={772} width={496} height={150} rx={20} fill="#000" opacity={0.25} />
    <rect x={300} y={760} width={480} height={146} rx={18} fill={u.url("lid")} />
    <rect x={300} y={898} width={480} height={8} fill="#5C636B" />
    <rect x={296} y={906} width={488} height={336} rx={24} fill="#000" opacity={0.25} />
    <rect x={300} y={900} width={480} height={330} rx={22} fill={u.url("alu")} />
    <rect x={330} y={930} width={420} height={170} rx={10} fill="#2A2E34" />
    {Array.from({ length: 5 }, (_, r) =>
      Array.from({ length: 13 }, (_, c) => (
        <rect
          key={`${r}-${c}`}
          x={338 + c * 31.5}
          y={938 + r * 32}
          width={26}
          height={26}
          rx={4}
          fill="#3B4047"
        />
      )),
    )}
    <rect x={470} y={1120} width={140} height={90} rx={10} fill="#BCC2C9" stroke="#A0A7AF" strokeWidth={2} />
  </g>
);

const Mug: React.FC<{ x: number; y: number }> = ({ x, y }) => (
  <g>
    <circle cx={x + 6} cy={y + 8} r={66} fill="#000" opacity={0.25} />
    <circle cx={x} cy={y} r={64} fill="#F3EFE8" />
    <circle cx={x} cy={y} r={50} fill="#5A3A22" />
    <circle cx={x - 12} cy={y - 14} r={16} fill="#ffffff" opacity={0.12} />
    <rect
      x={x + 58}
      y={y - 14}
      width={36}
      height={28}
      rx={12}
      fill="none"
      stroke="#F3EFE8"
      strokeWidth={12}
    />
  </g>
);

const Cable: React.FC<{ d: string; color: string; w?: number }> = ({ d, color, w = 12 }) => (
  <g>
    <path
      d={d}
      fill="none"
      stroke="#000"
      strokeOpacity={0.3}
      strokeWidth={w + 6}
      strokeLinecap="round"
      transform="translate(4 6)"
    />
    <path d={d} fill="none" stroke={color} strokeWidth={w} strokeLinecap="round" />
  </g>
);

export const DeskBefore: React.FC<VectorProps> = () => {
  const u = useIds();
  return (
    <g>
      <Desk u={u} />
      <Mug x={880} y={600} />
      <Laptop u={u} />
      {/* charger brick */}
      <rect x={130} y={520} width={140} height={104} rx={20} fill="#F2F2F2" />
      <rect x={150} y={540} width={100} height={8} rx={4} fill="#DADADA" />
      <Cable d="M200,624 C205,760 130,820 210,900 S262,1010 300,1000" color="#F2F2F2" w={11} />
      {/* HDMI dongle + monitor cable */}
      <rect x={232} y={1040} width={64} height={40} rx={8} fill="#2E3238" />
      <Cable d="M264,1040 C220,900 70,860 40,700 S120,420 60,0" color="#1C1E22" w={16} />
      {/* Ethernet dongle */}
      <rect x={784} y={984} width={74} height={52} rx={10} fill="#3A3F46" />
      <Cable
        d="M858,1010 C980,1050 1010,1220 880,1310 S700,1440 820,1600 S1000,1760 940,1920"
        color="#2D6BFF"
        w={13}
      />
      {/* SD reader + card */}
      <rect x={784} y={1096} width={56} height={40} rx={8} fill="#E6E6E6" />
      <rect x={838} y={1102} width={46} height={30} rx={3} fill="#1F4FBF" />
      {/* USB-A adapter + stick */}
      <rect x={784} y={1166} width={44} height={30} rx={6} fill="#2E3238" />
      <rect x={826} y={1170} width={90} height={22} rx={6} fill="#C0392B" />
      {/* cables crossing the laptop */}
      <Cable
        d="M520,0 C560,320 300,520 430,760 S700,860 560,1120 S240,1300 300,1500 S620,1700 520,1920"
        color="#202226"
        w={14}
      />
      <Cable
        d="M0,1380 C220,1300 380,1420 520,1330 S760,1180 900,1260 S1040,1420 1080,1380"
        color="#8A9099"
        w={11}
      />
      <Cable d="M120,1920 C200,1700 420,1640 380,1500 S180,1300 268,1080" color="#1C1E22" w={10} />
      <Cable d="M820,1200 C900,1300 760,1380 700,1460 S760,1700 680,1920" color="#E8E8E8" w={9} />
      <rect width={1080} height={1920} fill={u.url("light")} />
    </g>
  );
};

export const DeskAfter: React.FC<VectorProps> = ({ params, ms, palette }) => {
  const u = useIds();
  return (
    <g>
      <Desk u={u} />
      <Mug x={880} y={600} />
      {/* plant */}
      <g transform="translate(220 640)">
        <circle r={96} fill="#000" opacity={0.2} transform="translate(8 10)" />
        <circle r={92} fill="#C9764A" />
        {Array.from({ length: 9 }, (_, i) => (
          <ellipse
            key={i}
            cx={Math.cos(i * 0.7) * 48}
            cy={Math.sin(i * 0.7) * 48}
            rx={56}
            ry={22}
            fill={i % 2 ? "#3F7D4E" : "#5FA36B"}
            transform={`rotate(${i * 40} ${Math.cos(i * 0.7) * 48} ${Math.sin(i * 0.7) * 48})`}
          />
        ))}
      </g>
      <Laptop u={u} />
      <Cable d="M780,1120 C850,1160 840,1290 780,1318" color="#2A2D33" w={14} />
      <Cable d="M640,1366 L640,1920" color="#1C1E22" w={12} />
      <Cable d="M690,1366 L690,1920" color="#2D6BFF" w={11} />
      <g transform="translate(560 1290)">
        <rect width={240} height={80} rx={36} fill="#000" opacity={0.25} transform="translate(6 8)" />
        <g transform="scale(0.3117) translate(-130 -200)">
          <HubArt params={params} ms={ms} accent={palette.accent} />
        </g>
      </g>
      <rect width={1080} height={1920} fill={u.url("light")} />
    </g>
  );
};
