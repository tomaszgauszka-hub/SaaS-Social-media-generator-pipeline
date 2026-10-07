import type React from "react";
import { lerp, mix, num, str } from "../util.ts";
import { FONT, Lin, Rad, clamp01, useIds, type VectorProps } from "./shared.tsx";

/* Motion-sensor LED cabinet light — 1000×560. `install` 1→4 walks through charge / stick / snap / light-on. */

const WARM = "#FFE2A8";

export const CabinetLight: React.FC<VectorProps> = ({ params, ms }) => {
  const u = useIds();
  const inst = num(params, "install", 3);
  const shelf = num(params, "shelf", 0) > 0.5;
  const e1 = clamp01(inst - 1);
  const e2 = clamp01(inst - 2);
  const e3 = clamp01(inst - 3);
  const on = Math.max(clamp01(num(params, "light", 0)), e3);
  const sense = Math.max(clamp01(num(params, "sense", 0)), e3 > 0 && e3 < 1 ? 1 : 0);
  const drop = 120 * (1 - e2);
  const stripY = lerp(180 + drop - 16, 150, e1);
  const cable = inst < 2 ? 1 - e1 : 0;
  return (
    <g>
      <defs>
        <Lin
          id={u.id("alu")}
          stops={[
            [0, "#F4F6F8"],
            [0.5, "#C9CED4"],
            [1, "#9EA5AD"],
          ]}
        />
        <Lin
          id={u.id("diff")}
          stops={[
            [0, mix("#E9EDF0", "#FFF9EC", on)],
            [1, mix("#C5CBD1", "#FFE4B0", on)],
          ]}
        />
        <Lin
          id={u.id("cone")}
          stops={[
            [0, WARM, 0.6],
            [1, WARM, 0],
          ]}
        />
        <Rad
          id={u.id("halo")}
          stops={[
            [0, "#FFF1D2", 0.9],
            [0.5, WARM, 0.35],
            [1, WARM, 0],
          ]}
        />
        <Lin
          id={u.id("shelf")}
          stops={[
            [0, "#E7CDA6"],
            [0.8, "#CFAA7C"],
            [1, "#B88F60"],
          ]}
        />
      </defs>
      {on > 0.01 ? (
        <g opacity={on}>
          <polygon points={`110,${292 + drop} 890,${292 + drop} 1000,560 0,560`} fill={u.url("cone")} />
          <ellipse cx={500} cy={282 + drop} rx={540} ry={90} fill={u.url("halo")} />
        </g>
      ) : null}
      {shelf ? (
        <g>
          <rect x={0} y={20} width={1000} height={130} fill={u.url("shelf")} />
          <rect x={0} y={132} width={1000} height={18} fill="#A27A4E" />
          {[60, 92, 118].map((y) => (
            <path
              key={y}
              d={`M0,${y} C250,${y - 8} 520,${y + 10} 1000,${y - 4}`}
              stroke="#9C7448"
              strokeWidth={1.5}
              fill="none"
              opacity={0.4}
            />
          ))}
        </g>
      ) : null}
      {shelf && e1 > 0 ? <rect x={150} y={stripY} width={700} height={16} rx={5} fill="#3A3F46" /> : null}
      <g transform={`translate(0 ${drop})`}>
        <rect x={90} y={180} width={820} height={72} rx={32} fill={u.url("alu")} />
        <rect x={96} y={224} width={808} height={68} rx={30} fill={u.url("diff")} />
        <rect x={96} y={224} width={808} height={8} rx={4} fill="#ffffff" opacity={0.5} />
        {Array.from({ length: 32 }, (_, i) => (
          <circle
            key={i}
            cx={232 + i * 20}
            cy={262}
            r={4.5}
            fill={on > 0.05 ? "#FFFFFF" : "#E2E6EA"}
            opacity={0.6 + on * 0.4}
          />
        ))}
        <rect x={90} y={180} width={46} height={112} rx={26} fill="#F7F8F9" />
        <rect x={864} y={180} width={46} height={112} rx={26} fill="#F7F8F9" />
        <circle cx={170} cy={262} r={22} fill="#FBFBFB" stroke="#C9CED4" strokeWidth={2} />
        {[16, 11, 6].map((r) => (
          <circle key={r} cx={170} cy={262} r={r} fill="none" stroke="#D3D8DD" strokeWidth={1.5} />
        ))}
        <rect x={886} y={230} width={24} height={10} rx={5} fill="#2A2E34" />
        <circle
          cx={876}
          cy={206}
          r={4}
          fill={cable > 0.05 ? mix("#FF5A4A", "#5BFF7A", clamp01(ms / 1200)) : "#C9CED4"}
        />
        <text
          x={500}
          y={212}
          textAnchor="middle"
          fontFamily={FONT}
          fontWeight={700}
          fontSize={16}
          fill="#8E959E"
          letterSpacing={5}
        >
          MOTION SENSOR
        </text>
        {sense > 0.01
          ? [0, 1, 2].map((k) => {
              const r = ((ms / 6 + k * 70) % 210) + 30;
              return (
                <path
                  key={k}
                  d={`M${170 - r},${262 + r * 0.2} A${r},${r * 0.8} 0 0 0 ${170 + r},${262 + r * 0.2}`}
                  fill="none"
                  stroke="#38B6FF"
                  strokeWidth={4}
                  opacity={sense * (1 - r / 240) * 0.8}
                />
              );
            })
          : null}
        {cable > 0.01 ? (
          <g opacity={cable}>
            <rect x={906} y={226} width={30} height={18} rx={6} fill="#4A4F57" />
            <path
              d="M936,235 C980,235 990,300 990,560"
              fill="none"
              stroke="#F2F2F2"
              strokeWidth={10}
              strokeLinecap="round"
            />
          </g>
        ) : null}
      </g>
    </g>
  );
};

/* Open kitchen cabinet or wardrobe at night — 1080×1920. */

interface Bar {
  x: number;
  y: number;
  w: number;
  /** how far down the light reaches */
  reach: number;
}

const Jar: React.FC<{
  x: number;
  base: number;
  h: number;
  fill: string;
  pattern?: "penne" | "dots" | "grain";
}> = ({ x, base, h, fill, pattern }) => {
  const w = 130;
  const top = base - h;
  return (
    <g>
      <rect x={x} y={top + 30} width={w} height={h - 30} rx={18} fill={fill} />
      {pattern === "penne"
        ? Array.from({ length: 14 }, (_, i) => (
            <rect
              key={i}
              x={x + 12 + (i % 4) * 28}
              y={top + 50 + Math.floor(i / 4) * 40}
              width={22}
              height={9}
              rx={4}
              fill="#C98A2E"
              transform={`rotate(${((i * 37) % 60) - 30} ${x + 20 + (i % 4) * 28} ${top + 54 + Math.floor(i / 4) * 40})`}
            />
          ))
        : pattern === "dots"
          ? Array.from({ length: 40 }, (_, i) => (
              <circle
                key={i}
                cx={x + 10 + ((i * 29) % 110)}
                cy={top + 46 + ((i * 17) % (h - 50))}
                r={4}
                fill="#8A3A20"
              />
            ))
          : null}
      <rect
        x={x}
        y={top + 30}
        width={w}
        height={h - 30}
        rx={18}
        fill="#ffffff"
        opacity={0.18}
        stroke="#ffffff"
        strokeOpacity={0.7}
        strokeWidth={3}
      />
      <rect x={x + 14} y={top + 46} width={14} height={h - 70} rx={7} fill="#ffffff" opacity={0.35} />
      <rect x={x - 6} y={top} width={w + 12} height={34} rx={8} fill="#B07A4A" />
      <rect x={x - 6} y={top} width={w + 12} height={8} rx={4} fill="#ffffff" opacity={0.2} />
    </g>
  );
};

const Kitchen: React.FC = () => (
  <g>
    {/* top compartment */}
    <Jar x={200} base={760} h={260} fill="#EBB45A" pattern="penne" />
    <Jar x={370} base={760} h={230} fill="#B9512F" pattern="dots" />
    <Jar x={540} base={760} h={250} fill="#F2EEE4" />
    {Array.from({ length: 7 }, (_, i) => (
      <ellipse
        key={i}
        cx={810}
        cy={752 - i * 18}
        rx={96}
        ry={16}
        fill={i % 2 ? "#FFFFFF" : "#9DBFA8"}
        stroke="#C9D2CB"
        strokeWidth={2}
      />
    ))}
    {/* middle */}
    {["#C0392B", "#E67E22", "#27AE60", "#8E5A2B", "#F1C40F", "#7F8C8D"].map((c, i) => (
      <g key={c}>
        <rect x={196 + i * 56} y={980} width={46} height={130} rx={10} fill="#F7F1E6" opacity={0.85} />
        <rect x={196 + i * 56} y={1030} width={46} height={50} fill={c} />
        <rect x={200 + i * 56} y={958} width={38} height={26} rx={5} fill="#22252A" />
      </g>
    ))}
    {[560, 690].map((x) => (
      <g key={x}>
        <rect x={x} y={1000} width={100} height={110} rx={16} fill="#7FA38B" />
        <rect
          x={x + 92}
          y={1024}
          width={34}
          height={56}
          rx={16}
          fill="none"
          stroke="#7FA38B"
          strokeWidth={12}
        />
        <rect x={x + 8} y={1008} width={14} height={80} rx={7} fill="#ffffff" opacity={0.2} />
      </g>
    ))}
    {Array.from({ length: 4 }, (_, i) => (
      <path
        key={i}
        d={`M820,${1110 - i * 30} q50,22 100,0 l-8,-26 h-84 Z`}
        fill={i % 2 ? "#E9E2D6" : "#D9776A"}
      />
    ))}
    {/* bottom */}
    <rect x={196} y={1200} width={170} height={246} rx={6} fill="#E8862E" />
    <rect x={196} y={1200} width={170} height={60} fill="#F4B942" />
    <circle cx={281} cy={1350} r={46} fill="#ffffff" opacity={0.9} />
    <ellipse cx={281} cy={1356} rx={34} ry={14} fill="#E8862E" />
    <rect x={400} y={1220} width={58} height={226} rx={18} fill="#4C6B2A" />
    <rect x={414} y={1180} width={30} height={50} rx={6} fill="#2E3D18" />
    <rect x={406} y={1290} width={46} height={70} rx={6} fill="#F1E3B5" />
    {Array.from({ length: 4 }, (_, i) => (
      <path
        key={i}
        d={`M520,${1446 - i * 34} q90,30 180,0 l-12,-30 h-156 Z`}
        fill={i % 2 ? "#F1EDE6" : "#9DBFA8"}
      />
    ))}
    {Array.from({ length: 3 }, (_, i) => (
      <g key={i}>
        <rect
          x={740}
          y={1330 - i * 40}
          width={170}
          height={38}
          rx={8}
          fill={["#E9E2D6", "#D9776A", "#F4EEE4"][i]}
        />
        <rect x={740} y={1340 - i * 40} width={170} height={6} fill="#B86E0E" opacity={0.6} />
      </g>
    ))}
  </g>
);

const SHIRTS = ["#7FA38B", "#C8664B", "#F2E8D8", "#3E5370", "#D9A441", "#9A8FB8"];

const Wardrobe: React.FC = () => (
  <g>
    {/* folded sweaters on the top shelf */}
    {[200, 420, 640].map((x, s) =>
      Array.from({ length: 4 }, (_, i) => (
        <g key={`${x}-${i}`}>
          <rect
            x={x}
            y={500 - (i + 1) * 30}
            width={190}
            height={30}
            rx={10}
            fill={SHIRTS[(s * 2 + i) % SHIRTS.length]}
          />
          <rect
            x={x + 8}
            y={500 - (i + 1) * 30 + 22}
            width={174}
            height={4}
            rx={2}
            fill="#000"
            opacity={0.12}
          />
        </g>
      )),
    )}
    <rect x={154} y={612} width={772} height={12} rx={6} fill="#B9BFC6" />
    <rect x={154} y={612} width={772} height={4} rx={2} fill="#ffffff" opacity={0.6} />
    {SHIRTS.map((c, i) => {
      const x = 210 + i * 116;
      const len = [560, 640, 520, 700, 600, 560][i]!;
      return (
        <g key={c}>
          <path d={`M${x + 50},618 l-34,40 h68 Z`} fill="none" stroke="#8C939B" strokeWidth={4} />
          <path
            d={`M${x},660 q50,-14 100,0 l18,${len * 0.2} l-14,6 v${len * 0.8} h-108 v-${len * 0.8} l-14,-6 Z`}
            fill={c}
          />
          <path
            d={`M${x + 36},660 l14,26 l14,-26`}
            fill="none"
            stroke="#000"
            strokeOpacity={0.18}
            strokeWidth={3}
          />
          <rect x={x + 6} y={680} width={10} height={len * 0.9} fill="#000" opacity={0.08} />
        </g>
      );
    })}
    {[230, 470, 700].map((x, i) => (
      <g key={x}>
        <path
          d={`M${x},1500 q0,-50 40,-56 q30,0 40,30 l60,10 q20,6 20,16 Z`}
          fill={["#3B2A20", "#E9E2D6", "#7A2E2E"][i]}
        />
        <path
          d={`M${x + 80},1500 q0,-50 40,-56 q30,0 40,30 l60,10 q20,6 20,16 Z`}
          fill={["#3B2A20", "#E9E2D6", "#7A2E2E"][i]}
          opacity={0.85}
        />
      </g>
    ))}
  </g>
);

export const CabinetScene: React.FC<VectorProps> = ({ params, ms }) => {
  const u = useIds();
  const view = str(params, "view", "kitchen");
  const on = clamp01(num(params, "light", 0));
  const mounted = num(params, "mounted", 1) > 0.5;
  const door = clamp01(num(params, "door", 1));
  const sense = clamp01(num(params, "sense", 0));
  const ambient = clamp01(num(params, "ambient", 0.12));
  const kitchen = view !== "wardrobe";
  const box = kitchen ? { x: 120, y: 360, w: 840, h: 1120 } : { x: 120, y: 300, w: 840, h: 1240 };
  const t = 34;
  const inner = { x: box.x + t, y: box.y + t, w: box.w - 2 * t, h: box.h - 2 * t };
  const shelves = kitchen ? [760, 1110] : [500];
  const bars: Bar[] = kitchen
    ? [
        { x: 340, y: inner.y + 4, w: 400, reach: 760 - inner.y },
        { x: 340, y: 784 + 2, w: 400, reach: 1110 - 786 },
      ]
    : [{ x: 340, y: 524 + 2, w: 400, reach: 1500 - 526 }];
  const darkness = 0.94 * (1 - ambient);
  const doorEdge = lerp(box.w / 2, 80, door);
  return (
    <g>
      <defs>
        <pattern id={u.id("tile")} width="120" height="60" patternUnits="userSpaceOnUse">
          <rect width="120" height="60" fill="#F1ECE3" />
          <rect x="0" y="0" width="120" height="3" fill="#D6CFC2" />
          <rect x="0" y="0" width="3" height="30" fill="#D6CFC2" />
          <rect x="60" y="30" width="3" height="30" fill="#D6CFC2" />
          <rect x="0" y="30" width="120" height="3" fill="#D6CFC2" />
        </pattern>
        <Lin
          id={u.id("inner")}
          stops={[
            [0, kitchen ? "#C9BCA7" : "#BFAF98"],
            [1, kitchen ? "#DDD2C0" : "#D4C6B0"],
          ]}
        />
        <Lin
          id={u.id("cone")}
          stops={[
            [0, WARM, 0.55],
            [1, WARM, 0.05],
          ]}
        />
        <Rad
          id={u.id("hole")}
          stops={[
            [0, "#000000", 1],
            [0.7, "#000000", 0.85],
            [1, "#000000", 0],
          ]}
        />
        <Rad
          id={u.id("wash")}
          stops={[
            [0, "#FFD8A0", 0.5],
            [1, "#FFD8A0", 0],
          ]}
        />
        <Lin
          id={u.id("counter")}
          stops={[
            [0, "#A9A39A"],
            [1, "#77716A"],
          ]}
        />
        <Lin
          id={u.id("fall")}
          stops={[
            [0, "#000000", 1],
            [0.55, "#000000", 0.92],
            [1, "#000000", 0.55],
          ]}
        />
        <clipPath id={u.id("innerclip")}>
          <rect x={inner.x} y={inner.y} width={inner.w} height={inner.h} />
        </clipPath>
        <mask id={u.id("dark")} maskUnits="userSpaceOnUse" x={0} y={0} width={1080} height={1920}>
          <rect width={1080} height={1920} fill="#ffffff" />
          {mounted && on > 0.01 ? (
            <g opacity={on}>
              <g clipPath={u.url("innerclip")}>
                {bars.map((b, i) => (
                  <rect
                    key={i}
                    x={inner.x}
                    y={b.y}
                    width={inner.w}
                    height={b.reach + 30}
                    fill={u.url("fall")}
                  />
                ))}
              </g>
              <ellipse
                cx={540}
                cy={inner.y + inner.h * 0.5}
                rx={inner.w * 0.7}
                ry={inner.h * 0.62}
                fill={u.url("hole")}
                opacity={0.35}
              />
            </g>
          ) : null}
        </mask>
      </defs>
      {/* wall, backsplash, counter */}
      <rect width={1080} height={1920} fill="#E7E0D3" />
      {kitchen ? (
        <>
          <rect y={1480} width={1080} height={200} fill={u.url("tile")} />
          <rect y={1680} width={1080} height={60} fill={u.url("counter")} />
          <rect y={1740} width={1080} height={180} fill="#5C574F" />
          <rect y={1680} width={1080} height={6} fill="#ffffff" opacity={0.35} />
        </>
      ) : (
        <>
          <rect y={1540} width={1080} height={380} fill="#B8875A" />
          {Array.from({ length: 5 }, (_, i) => (
            <rect key={i} y={1580 + i * 72} width={1080} height={3} fill="#7A522E" opacity={0.3} />
          ))}
        </>
      )}
      {/* cabinet */}
      <rect x={box.x} y={box.y} width={box.w} height={box.h} rx={8} fill="#F1EADE" />
      <rect x={inner.x} y={inner.y} width={inner.w} height={inner.h} fill={u.url("inner")} />
      <rect x={inner.x} y={inner.y} width={inner.w} height={18} fill="#000" opacity={0.1} />
      {kitchen ? <Kitchen /> : <Wardrobe />}
      {shelves.map((y) => (
        <g key={y}>
          <rect x={inner.x} y={y} width={inner.w} height={24} fill="#F5EFE5" />
          <rect x={inner.x} y={y + 24} width={inner.w} height={16} fill="#000" opacity={0.08} />
        </g>
      ))}
      {/* light bars */}
      {mounted
        ? bars.map((b, i) => (
            <g key={i}>
              {on > 0.01 ? (
                <polygon
                  points={`${b.x},${b.y + 20} ${b.x + b.w},${b.y + 20} ${inner.x + inner.w},${b.y + b.reach} ${inner.x},${b.y + b.reach}`}
                  fill={u.url("cone")}
                  opacity={on}
                />
              ) : null}
              <rect x={b.x} y={b.y} width={b.w} height={22} rx={11} fill="#E9ECEF" />
              <rect
                x={b.x + 4}
                y={b.y + 10}
                width={b.w - 8}
                height={12}
                rx={6}
                fill={mix("#C9CED4", "#FFF6DD", on)}
              />
              <circle cx={b.x + 28} cy={b.y + 15} r={6} fill="#FBFBFB" stroke="#B9BFC6" strokeWidth={1.5} />
              {sense > 0.01
                ? [0, 1].map((k) => {
                    const r = ((ms / 6 + k * 90) % 180) + 24;
                    return (
                      <path
                        key={k}
                        d={`M${b.x + 28 - r},${b.y + 15 + r * 0.3} A${r},${r * 0.7} 0 0 0 ${b.x + 28 + r},${b.y + 15 + r * 0.3}`}
                        fill="none"
                        stroke="#38B6FF"
                        strokeWidth={5}
                        opacity={sense * (1 - r / 210)}
                      />
                    );
                  })
                : null}
            </g>
          ))
        : null}
      {/* open doors */}
      <polygon
        points={`${box.x},${box.y} ${box.x + doorEdge * (1 - door) - 80 * door},${box.y - 40 * door} ${box.x + doorEdge * (1 - door) - 80 * door},${box.y + box.h + 40 * door} ${box.x},${box.y + box.h}`}
        fill="#F4EEE4"
        stroke="#D8D0C2"
        strokeWidth={3}
      />
      <polygon
        points={`${box.x + box.w},${box.y} ${box.x + box.w - doorEdge * (1 - door) + 80 * door},${box.y - 40 * door} ${box.x + box.w - doorEdge * (1 - door) + 80 * door},${box.y + box.h + 40 * door} ${box.x + box.w},${box.y + box.h}`}
        fill="#EDE6DA"
        stroke="#D8D0C2"
        strokeWidth={3}
      />
      {/* night */}
      <rect width={1080} height={1920} fill="#04060D" opacity={darkness} mask={u.url("dark")} />
      {mounted && on > 0.01 ? (
        <g clipPath={u.url("innerclip")} opacity={on * 0.5} style={{ mixBlendMode: "screen" }}>
          {bars.map((b, i) => (
            <ellipse
              key={i}
              cx={b.x + b.w / 2}
              cy={b.y + 30}
              rx={inner.w * 0.55}
              ry={Math.min(260, b.reach * 0.7)}
              fill={u.url("wash")}
            />
          ))}
        </g>
      ) : null}
    </g>
  );
};
