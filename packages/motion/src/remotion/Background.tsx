import type { RenderPlan, ResolvedBeat } from "@cre/creative";
import type React from "react";
import { AbsoluteFill, useCurrentFrame, useVideoConfig } from "remotion";
import { isDark, mix, rgba, rng } from "./util.ts";

/**
 * Persistent kit background (material cues per category, never a plain gradient card) with slow motion, plus
 * per-beat background treatments (alt / dark / accent).
 */
export const Background: React.FC<{ plan: RenderPlan }> = ({ plan }) => {
  const frame = useCurrentFrame();
  const { fps, width: W, height: H } = useVideoConfig();
  const ms = (frame * 1000) / fps;
  const p = plan.style.palette;
  const kind = plan.style.background.kind;
  const drift = Math.sin(ms / 5200) * 14;
  switch (kind) {
    case "workshop":
      return (
        <AbsoluteFill
          style={{
            background: `linear-gradient(180deg, ${mix(p.bg2, "#000000", 0.05)} 0%, ${p.bg} 62%, ${mix(p.bg, "#000000", 0.35)} 100%)`,
          }}
        >
          <svg
            width={W}
            height={H}
            style={{ position: "absolute", inset: 0, transform: `translateY(${drift * 0.4}px)` }}
          >
            <defs>
              <pattern id="peg" width="54" height="54" patternUnits="userSpaceOnUse">
                <circle cx="27" cy="27" r="6.5" fill="#000" opacity="0.55" />
                <circle cx="27" cy="28.4" r="6.5" fill="#fff" opacity="0.05" />
              </pattern>
              <radialGradient id="spot" cx="50%" cy="34%" r="62%">
                <stop offset="0%" stopColor={p.glow} stopOpacity="0.18" />
                <stop offset="45%" stopColor={p.glow} stopOpacity="0.05" />
                <stop offset="100%" stopColor="#000" stopOpacity="0" />
              </radialGradient>
            </defs>
            <rect width={W} height={H * 0.78} fill="url(#peg)" opacity="0.9" />
            <rect y={H * 0.78} width={W} height={H * 0.22} fill={mix(p.bg, "#3b2a1c", 0.35)} />
            <rect y={H * 0.78} width={W} height={10} fill={rgba(p.glow, 0.12)} />
            {Array.from({ length: 7 }, (_, i) => (
              <rect key={i} y={H * 0.8 + i * 52} width={W} height={2} fill="#000" opacity={0.18} />
            ))}
            <rect width={W} height={H} fill="url(#spot)" />
          </svg>
        </AbsoluteFill>
      );
    case "tech_grid": {
      const off = (ms / 60) % 60;
      return (
        <AbsoluteFill
          style={{ background: `radial-gradient(120% 70% at 50% 30%, ${p.bg2} 0%, ${p.bg} 62%)` }}
        >
          <svg width={W} height={H} style={{ position: "absolute", inset: 0 }}>
            <defs>
              <pattern
                id="grid"
                width="60"
                height="60"
                patternUnits="userSpaceOnUse"
                patternTransform={`translate(${-off} ${off * 0.5})`}
              >
                <path d="M60 0H0V60" fill="none" stroke={p.accent} strokeOpacity="0.075" strokeWidth="1.5" />
              </pattern>
              <radialGradient id="glow" cx="50%" cy="42%" r="45%">
                <stop offset="0%" stopColor={p.accent} stopOpacity="0.16" />
                <stop offset="100%" stopColor={p.accent} stopOpacity="0" />
              </radialGradient>
              <linearGradient id="fade" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={p.bg} stopOpacity="0.9" />
                <stop offset="25%" stopColor={p.bg} stopOpacity="0" />
                <stop offset="80%" stopColor={p.bg} stopOpacity="0" />
                <stop offset="100%" stopColor={p.bg} stopOpacity="0.95" />
              </linearGradient>
            </defs>
            <rect width={W} height={H} fill="url(#grid)" />
            <rect width={W} height={H} fill="url(#glow)" />
            <rect width={W} height={H} fill="url(#fade)" />
          </svg>
        </AbsoluteFill>
      );
    }
    case "clean_home":
      return (
        <AbsoluteFill
          style={{
            background: `linear-gradient(170deg, ${mix(p.bg, "#ffffff", 0.45)} 0%, ${p.bg} 55%, ${p.bg2} 100%)`,
          }}
        >
          <svg width={W} height={H} style={{ position: "absolute", inset: 0 }}>
            <defs>
              <linearGradient id="shaft" x1="0" y1="0" x2="1" y2="1">
                <stop offset="0%" stopColor="#ffffff" stopOpacity="0.55" />
                <stop offset="100%" stopColor="#ffffff" stopOpacity="0" />
              </linearGradient>
            </defs>
            <g transform={`translate(${drift} 0)`} opacity="0.7">
              <polygon
                points={`${W * 0.55},0 ${W * 0.78},0 ${W * 0.35},${H} ${W * 0.08},${H}`}
                fill="url(#shaft)"
              />
              <polygon
                points={`${W * 0.84},0 ${W * 0.94},0 ${W * 0.62},${H} ${W * 0.5},${H}`}
                fill="url(#shaft)"
                opacity="0.6"
              />
            </g>
            <rect y={H * 0.86} width={W} height={H * 0.14} fill={rgba(p.bg2, 0.9)} />
            <rect y={H * 0.86} width={W} height={3} fill={rgba(p.ink, 0.08)} />
          </svg>
        </AbsoluteFill>
      );
    case "asphalt": {
      const r = rng(7);
      const streaks = Array.from({ length: 16 }, () => ({
        y: r() * H,
        len: 220 + r() * 520,
        speed: 1.4 + r() * 2.4,
        w: 1 + r() * 3,
        a: 0.08 + r() * 0.2,
        red: r() < 0.35,
      }));
      return (
        <AbsoluteFill
          style={{
            background: `radial-gradient(110% 60% at 70% 30%, ${p.bg2} 0%, ${p.bg} 60%, #070708 100%)`,
          }}
        >
          <svg width={W} height={H} style={{ position: "absolute", inset: 0 }}>
            <defs>
              <radialGradient id="red" cx="85%" cy="15%" r="55%">
                <stop offset="0%" stopColor={p.accent} stopOpacity="0.22" />
                <stop offset="100%" stopColor={p.accent} stopOpacity="0" />
              </radialGradient>
            </defs>
            <rect width={W} height={H} fill="url(#red)" />
            <g transform={`rotate(-14 ${W / 2} ${H / 2})`}>
              {streaks.map((s, i) => {
                const x = ((ms * s.speed * 0.6 + i * 977) % (W + s.len * 2)) - s.len;
                return (
                  <rect
                    key={i}
                    x={W - x}
                    y={s.y}
                    width={s.len}
                    height={s.w}
                    rx={s.w / 2}
                    fill={s.red ? p.accent : "#ffffff"}
                    opacity={s.a}
                  />
                );
              })}
            </g>
          </svg>
        </AbsoluteFill>
      );
    }
    case "studio_soft": {
      const r = rng(11);
      const bokeh = Array.from({ length: 14 }, () => ({
        x: r() * W,
        y: r() * H,
        rad: 40 + r() * 140,
        a: 0.08 + r() * 0.16,
        s: 0.4 + r(),
      }));
      return (
        <AbsoluteFill
          style={{
            background: `radial-gradient(90% 55% at 50% 38%, ${mix(p.bg, "#ffffff", 0.55)} 0%, ${p.bg} 52%, ${p.bg2} 100%)`,
          }}
        >
          <svg width={W} height={H} style={{ position: "absolute", inset: 0 }}>
            <defs>
              <radialGradient id="bk">
                <stop offset="0%" stopColor="#ffffff" stopOpacity="1" />
                <stop offset="70%" stopColor="#ffffff" stopOpacity="0.35" />
                <stop offset="100%" stopColor="#ffffff" stopOpacity="0" />
              </radialGradient>
            </defs>
            {bokeh.map((b, i) => (
              <circle
                key={i}
                cx={b.x + Math.sin(ms / 3000 + i) * 20 * b.s}
                cy={b.y - (ms / 90) * b.s * 0.3}
                r={b.rad}
                fill="url(#bk)"
                opacity={b.a}
              />
            ))}
          </svg>
        </AbsoluteFill>
      );
    }
    case "warm_home":
      return (
        <AbsoluteFill
          style={{
            background: `linear-gradient(180deg, ${mix(p.bg, "#ffffff", 0.3)} 0%, ${p.bg} 58%, ${p.bg2} 100%)`,
          }}
        >
          <svg width={W} height={H} style={{ position: "absolute", inset: 0 }}>
            <rect y={H * 0.74} width={W} height={H * 0.26} fill={mix(p.bg2, "#c98b4f", 0.45)} />
            {Array.from({ length: 6 }, (_, i) => (
              <rect key={i} x={0} y={H * 0.74 + i * 82} width={W} height={3} fill="#7a4a22" opacity="0.18" />
            ))}
            {Array.from({ length: 9 }, (_, i) => (
              <rect
                key={`v${i}`}
                x={((i * 263) % W) + (i % 2) * 120}
                y={H * 0.74 + (i % 3) * 82}
                width={3}
                height={82}
                fill="#7a4a22"
                opacity="0.14"
              />
            ))}
            <rect y={H * 0.74 - 18} width={W} height={18} fill="#ffffff" opacity="0.55" />
            <circle cx={W * 0.82} cy={H * 0.18} r={W * 0.36} fill="#ffffff" opacity="0.28" />
          </svg>
        </AbsoluteFill>
      );
    case "plain":
    default:
      return <AbsoluteFill style={{ background: `linear-gradient(180deg, ${p.bg2} 0%, ${p.bg} 100%)` }} />;
  }
};

export const BeatBackground: React.FC<{ plan: RenderPlan; beat: ResolvedBeat; ms: number }> = ({
  plan,
  beat,
}) => {
  const p = plan.style.palette;
  switch (beat.background) {
    case "alt":
      return (
        <AbsoluteFill
          style={{
            background: `radial-gradient(85% 60% at 50% 40%, ${mix(p.bg2, p.accent, 0.08)} 0%, ${p.bg} 75%)`,
          }}
        />
      );
    case "dark":
      // light kits: a deeper tone of the kit, not black (dark ink must stay readable)
      if (!isDark(p.bg))
        return (
          <AbsoluteFill
            style={{
              background: `radial-gradient(80% 55% at 50% 42%, ${mix(p.bg, "#ffffff", 0.35)} 0%, ${mix(p.bg2, "#000000", 0.1)} 100%)`,
            }}
          />
        );
      return (
        <AbsoluteFill
          style={{
            background: `radial-gradient(80% 55% at 50% 42%, ${mix(p.bg, "#ffffff", 0.06)} 0%, ${mix(p.bg, "#000000", 0.55)} 100%)`,
          }}
        />
      );
    case "accent":
      return <AbsoluteFill style={{ backgroundColor: p.accent }} />;
    case "media":
    case "kit":
    default:
      return null;
  }
};
