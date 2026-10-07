import {
  checklistItemBox,
  counterLayout,
  drawnBounds,
  listRows,
  specRowBoxes,
  stepRows,
  type Overlay,
  type Point,
  type RenderPlan,
  type ResolvedBeat,
  type ResolvedText,
  type TextColor,
} from "@cre/creative";
import type React from "react";
import { TextView } from "../TextView.tsx";
import { clamp01, ease, fontAlias, isDark, lerp, mix, prog, rgba, rng, spring } from "../util.ts";

type O<K extends Overlay["kind"]> = Extract<Overlay, { kind: K }>;

interface Props<K extends Overlay["kind"]> {
  plan: RenderPlan;
  beat: ResolvedBeat;
  overlay: O<K>;
  ms: number;
}

export function sliderPct(o: O<"slider">, ms: number): number {
  return lerp(o.fromPct, o.toPct, prog(ms, o.delayMs, o.durationMs, ease.inOutCubic));
}

export const OverlayView: React.FC<{ plan: RenderPlan; beat: ResolvedBeat; overlay: Overlay; ms: number }> = (
  props,
) => {
  const { overlay: o } = props;
  if (props.ms < o.delayMs - 1 && o.kind !== "slider") return null;
  switch (o.kind) {
    case "callout":
      return <Callout {...props} overlay={o} />;
    case "highlight":
      return <Highlight {...props} overlay={o} />;
    case "counter":
      return <Counter {...props} overlay={o} />;
    case "spec_list":
      return <SpecList {...props} overlay={o} />;
    case "checklist":
      return <Checklist {...props} overlay={o} />;
    case "steps":
      return <Steps {...props} overlay={o} />;
    case "slider":
      return <Slider {...props} overlay={o} />;
    case "badge":
      return <Badge {...props} overlay={o} />;
    case "particles":
      return <Particles {...props} overlay={o} />;
    case "light_sweep":
      return <LightSweep {...props} overlay={o} />;
    case "panel":
      return <Panel {...props} overlay={o} />;
    case "cursor":
      return <Cursor {...props} overlay={o} />;
    case "timer":
      return <Timer {...props} overlay={o} />;
    case "measure":
      return <Measure {...props} overlay={o} />;
    case "arrow":
      return <Arrow {...props} overlay={o} />;
  }
};

function text(beat: ResolvedBeat, key: string): ResolvedText | undefined {
  return beat.overlayTexts[key];
}

function withColor(t: ResolvedText, color: TextColor): ResolvedText {
  return { ...t, color, animation: t.animation === "none" ? "rise" : t.animation };
}

const Svg: React.FC<{ children: React.ReactNode; style?: React.CSSProperties }> = ({ children, style }) => (
  <svg
    width={1080}
    height={1920}
    style={{ position: "absolute", left: 0, top: 0, overflow: "visible", pointerEvents: "none", ...style }}
  >
    {children}
  </svg>
);

/* ------------------------------------------------------------------ callout ---------------------- */

const Callout: React.FC<Props<"callout">> = ({ plan, beat, overlay: o, ms }) => {
  const p = plan.style.palette;
  const st = plan.style.overlayStyle;
  const local = ms - o.delayMs;
  const t = text(beat, `${o.id}:${o.textSlot}`);
  const labelBounds = t ? drawnBounds(t) : o.label;
  const pad = st === "hairline" ? 0 : 18;
  const anchor: Point =
    o.side === "right"
      ? { x: labelBounds.x - pad - 12, y: labelBounds.y + labelBounds.h / 2 }
      : { x: labelBounds.x + labelBounds.w + pad + 12, y: labelBounds.y + labelBounds.h / 2 };
  const elbow: Point = { x: anchor.x + (o.side === "right" ? -46 : 46), y: anchor.y };
  const len = Math.hypot(elbow.x - o.target.x, elbow.y - o.target.y) + Math.abs(anchor.x - elbow.x);
  const draw = prog(local, 0, 420, ease.inOutCubic);
  const pop = spring(local, 0, { stiffness: 260, damping: 16 });
  const labelIn = prog(local, 300, 360, ease.outCubic);
  const ring = prog(local, 0, 700, ease.outCubic);
  const lineColor =
    st === "industrial" ? p.accent : st === "racing" ? p.accent : st === "hairline" ? p.accent2 : p.accent;
  const strokeW = st === "hairline" ? 2 : st === "tech" ? 3 : 4;
  const bg =
    st === "industrial"
      ? { background: p.accent, border: "none", radius: 4, color: "accentInk" as TextColor }
      : st === "racing"
        ? { background: p.accent, border: "none", radius: 2, color: "accentInk" as TextColor }
        : st === "tech"
          ? {
              background: rgba(p.bg2, 0.82),
              border: `1.5px solid ${rgba(p.accent, 0.6)}`,
              radius: 14,
              color: "ink" as TextColor,
            }
          : st === "soft" || st === "rounded"
            ? {
                background: p.surface,
                border: st === "rounded" ? `3px solid ${p.accent}` : "none",
                radius: st === "rounded" ? 999 : 18,
                color: "surfaceInk" as TextColor,
              }
            : { background: "transparent", border: "none", radius: 0, color: "ink" as TextColor };
  return (
    <>
      <Svg>
        <circle
          cx={o.target.x}
          cy={o.target.y}
          r={10 + ring * 22}
          fill="none"
          stroke={lineColor}
          strokeWidth={3}
          opacity={(1 - ring) * 0.9}
        />
        <polyline
          points={`${o.target.x},${o.target.y} ${elbow.x},${elbow.y} ${anchor.x},${anchor.y}`}
          fill="none"
          stroke={lineColor}
          strokeWidth={strokeW}
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeDasharray={st === "soft" ? "2 10" : `${len} ${len}`}
          strokeDashoffset={st === "soft" ? 0 : len * (1 - draw)}
          opacity={st === "soft" ? draw : 1}
        />
        <circle
          cx={o.target.x}
          cy={o.target.y}
          r={11 * pop}
          fill={lineColor}
          stroke={isDark(p.bg) ? "#000" : "#fff"}
          strokeWidth={3}
        />
        {st === "hairline" ? (
          <line
            x1={anchor.x}
            y1={anchor.y}
            x2={anchor.x + (o.side === "right" ? labelBounds.w + 12 : -labelBounds.w - 12)}
            y2={anchor.y}
            stroke={lineColor}
            strokeWidth={1.5}
            opacity={labelIn}
            transform={`translate(0 ${labelBounds.h / 2 + 10})`}
          />
        ) : null}
      </Svg>
      {t ? (
        <div
          style={{
            opacity: labelIn,
            transform: `translateX(${(1 - labelIn) * (o.side === "right" ? 30 : -30)}px)`,
          }}
        >
          {bg.background !== "transparent" ? (
            <div
              style={{
                position: "absolute",
                left: labelBounds.x - pad,
                top: labelBounds.y - pad * 0.7,
                width: labelBounds.w + pad * 2,
                height: labelBounds.h + pad * 1.4,
                background: bg.background,
                border: bg.border,
                borderRadius: bg.radius,
                transform: st === "racing" ? "skewX(-10deg)" : undefined,
                boxShadow:
                  st === "soft" || st === "rounded"
                    ? "0 14px 40px rgba(0,0,0,0.14)"
                    : st === "tech"
                      ? `0 0 30px ${rgba(p.accent, 0.18)}`
                      : "0 10px 30px rgba(0,0,0,0.35)",
              }}
            />
          ) : null}
          <TextView
            plan={plan}
            text={{ ...withColor(t, bg.color), animation: "none", delayMs: 0 }}
            ms={local}
            beatMs={beat.durationMs}
          />
        </div>
      ) : null}
    </>
  );
};

/* ------------------------------------------------------------------ highlight / measure / arrow ---- */

const Highlight: React.FC<Props<"highlight">> = ({ plan, overlay: o, ms }) => {
  const p = plan.style.palette;
  const local = ms - o.delayMs;
  const d = prog(local, 0, 600, ease.inOutCubic);
  const pulse = 0.5 + 0.5 * Math.sin((local / 900) * Math.PI * 2);
  const { x, y, w, h } = o.rect;
  if (o.shape === "ring") {
    const r = Math.min(w, h) / 2;
    const c = 2 * Math.PI * r;
    return (
      <Svg>
        <circle
          cx={x + w / 2}
          cy={y + h / 2}
          r={r + 14 + pulse * 8}
          fill="none"
          stroke={p.accent}
          strokeOpacity={0.18 * d}
          strokeWidth={14}
        />
        <circle
          cx={x + w / 2}
          cy={y + h / 2}
          r={r}
          fill="none"
          stroke={p.accent}
          strokeWidth={6}
          strokeDasharray={`${c} ${c}`}
          strokeDashoffset={c * (1 - d)}
          transform={`rotate(-90 ${x + w / 2} ${y + h / 2})`}
          strokeLinecap="round"
        />
      </Svg>
    );
  }
  const L = 46;
  const corners = [
    `M${x} ${y + L}V${y}H${x + L}`,
    `M${x + w - L} ${y}H${x + w}V${y + L}`,
    `M${x + w} ${y + h - L}V${y + h}H${x + w - L}`,
    `M${x + L} ${y + h}H${x}V${y + h - L}`,
  ];
  return (
    <Svg>
      {corners.map((c, i) => (
        <path
          key={i}
          d={c}
          fill="none"
          stroke={p.accent}
          strokeWidth={6}
          strokeLinecap="square"
          opacity={d}
          transform={`translate(${(1 - d) * (i === 0 || i === 3 ? -20 : 20)} ${(1 - d) * (i < 2 ? -20 : 20)})`}
        />
      ))}
    </Svg>
  );
};

const Measure: React.FC<Props<"measure">> = ({ plan, beat, overlay: o, ms }) => {
  const p = plan.style.palette;
  const local = ms - o.delayMs;
  const d = prog(local, 0, 600, ease.inOutCubic);
  const mx = (o.from.x + o.to.x) / 2;
  const my = (o.from.y + o.to.y) / 2;
  const a = { x: lerp(mx, o.from.x, d), y: lerp(my, o.from.y, d) };
  const b = { x: lerp(mx, o.to.x, d), y: lerp(my, o.to.y, d) };
  const ang = Math.atan2(o.to.y - o.from.y, o.to.x - o.from.x);
  const nx = -Math.sin(ang) * 16;
  const ny = Math.cos(ang) * 16;
  const t = text(beat, `${o.id}:${o.textSlot}`);
  return (
    <>
      <Svg>
        <line x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke={p.accent} strokeWidth={4} />
        {d > 0.95 ? (
          <>
            <line
              x1={o.from.x - nx}
              y1={o.from.y - ny}
              x2={o.from.x + nx}
              y2={o.from.y + ny}
              stroke={p.accent}
              strokeWidth={4}
            />
            <line
              x1={o.to.x - nx}
              y1={o.to.y - ny}
              x2={o.to.x + nx}
              y2={o.to.y + ny}
              stroke={p.accent}
              strokeWidth={4}
            />
          </>
        ) : null}
      </Svg>
      {t ? (
        <TextView plan={plan} text={{ ...t, animation: "rise" }} ms={local - 350} beatMs={beat.durationMs} />
      ) : null}
    </>
  );
};

const Arrow: React.FC<Props<"arrow">> = ({ plan, overlay: o, ms }) => {
  const p = plan.style.palette;
  const d = prog(ms - o.delayMs, 0, 500, ease.inOutCubic);
  const mx = (o.from.x + o.to.x) / 2 - (o.to.y - o.from.y) * o.curve;
  const my = (o.from.y + o.to.y) / 2 + (o.to.x - o.from.x) * o.curve;
  const path = `M${o.from.x} ${o.from.y} Q${mx} ${my} ${o.to.x} ${o.to.y}`;
  const len = Math.hypot(o.to.x - o.from.x, o.to.y - o.from.y) * 1.2;
  const ang = Math.atan2(o.to.y - my, o.to.x - mx);
  const head = 26;
  return (
    <Svg>
      <path
        d={path}
        fill="none"
        stroke={p.accent}
        strokeWidth={6}
        strokeLinecap="round"
        strokeDasharray={`${len} ${len}`}
        strokeDashoffset={len * (1 - d)}
      />
      {d > 0.9 ? (
        <path
          d={`M${o.to.x} ${o.to.y} L${o.to.x - head * Math.cos(ang - 0.45)} ${o.to.y - head * Math.sin(ang - 0.45)} M${o.to.x} ${o.to.y} L${o.to.x - head * Math.cos(ang + 0.45)} ${o.to.y - head * Math.sin(ang + 0.45)}`}
          stroke={p.accent}
          strokeWidth={6}
          strokeLinecap="round"
        />
      ) : null}
    </Svg>
  );
};

/* ------------------------------------------------------------------ counter ---------------------- */

const Counter: React.FC<Props<"counter">> = ({ plan, beat, overlay: o, ms }) => {
  const p = plan.style.palette;
  const local = ms - o.delayMs;
  const e = prog(local, 0, o.durationMs, ease.outExpo);
  const value = lerp(o.from, o.to, e);
  const fmt = new Intl.NumberFormat(plan.locale, {
    minimumFractionDigits: o.decimals,
    maximumFractionDigits: o.decimals,
  });
  const numberText = text(beat, `${o.id}:number`);
  const unitText = o.unitSlot ? text(beat, `${o.id}:${o.unitSlot}`) : undefined;
  const geo = counterLayout(o);
  const appear = prog(local, 0, 300, ease.outCubic);
  if (!numberText) return null;
  const shown: ResolvedText = {
    ...numberText,
    lines: [[{ text: fmt.format(value), emphasis: false }]],
    animation: "none",
    delayMs: 0,
  };
  const max = o.max ?? Math.max(o.to, 1);
  if (o.style === "gauge" && geo.dial) {
    const { cx, cy, r } = geo.dial;
    const sweep = 240;
    const start = 150;
    const arc = (deg: number) => {
      const a0 = (start * Math.PI) / 180;
      const a1 = ((start + deg) * Math.PI) / 180;
      const R = r - 24;
      const large = deg > 180 ? 1 : 0;
      return `M${cx + R * Math.cos(a0)} ${cy + R * Math.sin(a0)} A${R} ${R} 0 ${large} 1 ${cx + R * Math.cos(a1)} ${cy + R * Math.sin(a1)}`;
    };
    const frac = clamp01(value / max);
    const endA = ((start + sweep * frac) * Math.PI) / 180;
    const R = r - 24;
    return (
      <div style={{ opacity: appear }}>
        <Svg>
          <path
            d={arc(sweep)}
            fill="none"
            stroke={isDark(p.bg) ? "rgba(255,255,255,0.12)" : rgba(p.ink, 0.1)}
            strokeWidth={30}
            strokeLinecap="round"
          />
          {Array.from({ length: 13 }, (_, i) => {
            const a = ((start + (sweep * i) / 12) * Math.PI) / 180;
            return (
              <line
                key={i}
                x1={cx + (R - 34) * Math.cos(a)}
                y1={cy + (R - 34) * Math.sin(a)}
                x2={cx + (R - (i % 3 === 0 ? 64 : 48)) * Math.cos(a)}
                y2={cy + (R - (i % 3 === 0 ? 64 : 48)) * Math.sin(a)}
                stroke={p.inkMuted}
                strokeWidth={i % 3 === 0 ? 5 : 3}
                strokeLinecap="round"
              />
            );
          })}
          {frac > 0.001 ? (
            <path
              d={arc(sweep * frac)}
              fill="none"
              stroke={p.accent}
              strokeWidth={30}
              strokeLinecap="round"
            />
          ) : null}
          <circle cx={cx + R * Math.cos(endA)} cy={cy + R * Math.sin(endA)} r={22} fill={p.accent} />
          <circle
            cx={cx + R * Math.cos(endA)}
            cy={cy + R * Math.sin(endA)}
            r={40}
            fill={p.accent}
            opacity={0.25}
          />
        </Svg>
        <TextView plan={plan} text={shown} ms={local} beatMs={beat.durationMs} />
        {unitText ? (
          <TextView
            plan={plan}
            text={{ ...unitText, animation: "none", delayMs: 0 }}
            ms={local}
            beatMs={beat.durationMs}
          />
        ) : null}
      </div>
    );
  }
  // plain / bar: unit sits on the number's baseline right after the final number width
  const finalW = numberText.width;
  let unit: ResolvedText | undefined;
  if (unitText) {
    const nb = drawnBounds(numberText);
    const fitsRight = nb.x + finalW + 22 + unitText.width <= o.box.x + o.box.w;
    unit = fitsRight
      ? {
          ...unitText,
          box: {
            x: nb.x + finalW + 22,
            y: nb.y + numberText.lineHeightPx * 0.72 - unitText.lineHeightPx,
            w: unitText.width + 4,
            h: unitText.lineHeightPx,
          },
          align: "left",
          vAlign: "top",
          animation: "none",
          delayMs: 0,
        }
      : { ...unitText, animation: "none", delayMs: 0 };
  }
  return (
    <div style={{ opacity: appear }}>
      <TextView plan={plan} text={shown} ms={local} beatMs={beat.durationMs} />
      {unit ? <TextView plan={plan} text={unit} ms={local - 200} beatMs={beat.durationMs} /> : null}
      {o.style === "bar" ? (
        <div
          style={{
            position: "absolute",
            left: o.box.x,
            top: o.box.y + o.box.h - 26,
            width: o.box.w,
            height: 18,
            borderRadius: 9,
            background: isDark(p.bg) ? "rgba(255,255,255,0.12)" : rgba(p.ink, 0.1),
            overflow: "hidden",
          }}
        >
          <div
            style={{
              width: `${clamp01(value / max) * 100}%`,
              height: "100%",
              background: `linear-gradient(90deg, ${p.accent2}, ${p.accent})`,
              borderRadius: 9,
            }}
          />
        </div>
      ) : null}
    </div>
  );
};

/* ------------------------------------------------------------------ lists ------------------------- */

const SpecList: React.FC<Props<"spec_list">> = ({ plan, beat, overlay: o, ms }) => {
  const p = plan.style.palette;
  const rows = listRows(o.box, o.items.length);
  return (
    <>
      {o.items.map((it, i) => {
        const local = ms - o.delayMs - i * o.staggerMs;
        const e = prog(local, 0, 380, ease.outCubic);
        const b = specRowBoxes(rows[i]!);
        const label = text(beat, `${o.id}:${it.labelSlot}`);
        const value = text(beat, `${o.id}:${it.valueSlot}`);
        return (
          <div key={i} style={{ opacity: e, transform: `translateX(${(1 - e) * 40}px)` }}>
            {i > 0 ? (
              <div
                style={{
                  position: "absolute",
                  left: rows[i]!.x,
                  top: rows[i]!.y,
                  width: rows[i]!.w,
                  height: 2,
                  background: rgba(p.surfaceInk, 0.1),
                }}
              />
            ) : null}
            {label ? (
              <TextView
                plan={plan}
                text={{ ...label, color: "surfaceInk", animation: "none", delayMs: 0 }}
                ms={local}
                beatMs={beat.durationMs}
              />
            ) : null}
            {value ? (
              <TextView
                plan={plan}
                text={{ ...value, color: "surfaceInk", animation: "none", delayMs: 0 }}
                ms={local}
                beatMs={beat.durationMs}
              />
            ) : null}
            <div
              style={{
                position: "absolute",
                left: b.label.x - 22,
                top: b.label.y + b.label.h / 2 - 5,
                width: 10,
                height: 10,
                borderRadius: 2,
                background: p.accent,
                transform: "rotate(45deg)",
              }}
            />
          </div>
        );
      })}
    </>
  );
};

const Checklist: React.FC<Props<"checklist">> = ({ plan, beat, overlay: o, ms }) => {
  const p = plan.style.palette;
  const rows = listRows(o.box, o.itemSlots.length);
  return (
    <>
      {o.itemSlots.map((slot, i) => {
        const local = ms - o.delayMs - i * o.staggerMs;
        const b = checklistItemBox(rows[i]!);
        const pop = spring(local, 0, { stiffness: 260, damping: 15 });
        const check = prog(local, 120, 300, ease.outCubic);
        const t = text(beat, `${o.id}:${slot}`);
        const s = b.icon.w;
        return (
          <div key={slot}>
            <svg
              width={s}
              height={s}
              style={{
                position: "absolute",
                left: b.icon.x,
                top: b.icon.y,
                transform: `scale(${pop})`,
                overflow: "visible",
              }}
            >
              <circle cx={s / 2} cy={s / 2} r={s / 2} fill={p.accent} />
              <path
                d={`M${s * 0.28} ${s * 0.52} L${s * 0.44} ${s * 0.67} L${s * 0.74} ${s * 0.36}`}
                fill="none"
                stroke={p.accentInk}
                strokeWidth={s * 0.11}
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeDasharray="60"
                strokeDashoffset={60 * (1 - check)}
              />
            </svg>
            {t ? (
              <TextView
                plan={plan}
                text={{ ...t, animation: "slide_left", delayMs: 0, color: "surfaceInk" }}
                ms={local - 80}
                beatMs={beat.durationMs}
              />
            ) : null}
          </div>
        );
      })}
    </>
  );
};

const Steps: React.FC<Props<"steps">> = ({ plan, beat, overlay: o, ms }) => {
  const p = plan.style.palette;
  const rows = stepRows(o.box, o.itemSlots.length);
  const first = rows[0]!.badge;
  const last = rows[rows.length - 1]!.badge;
  const grow = prog(ms - o.delayMs, 0, o.staggerMs * (rows.length - 1) + 300, ease.linear);
  return (
    <>
      <div
        style={{
          position: "absolute",
          left: first.x + first.w / 2 - 3,
          top: first.y + first.h / 2,
          width: 6,
          height: (last.y - first.y) * grow,
          background: rgba(p.accent, 0.35),
          borderRadius: 3,
        }}
      />
      {o.itemSlots.map((slot, i) => {
        const local = ms - o.delayMs - i * o.staggerMs;
        if (local < 0) return null;
        const r = rows[i]!;
        const pop = spring(local, 0, { stiffness: 240, damping: 14 });
        const t = text(beat, `${o.id}:${slot}`);
        return (
          <div key={slot}>
            <div
              style={{
                position: "absolute",
                left: r.badge.x,
                top: r.badge.y,
                width: r.badge.w,
                height: r.badge.h,
                borderRadius: "50%",
                background: p.accent,
                color: p.accentInk,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                fontFamily: fontAlias(plan.style.fonts.STAT.family),
                fontWeight: plan.style.fonts.STAT.weight,
                fontSize: r.badge.h * 0.5,
                transform: `scale(${pop})`,
                boxShadow: `0 10px 30px ${rgba(p.accent, 0.35)}`,
              }}
            >
              {new Intl.NumberFormat(plan.locale).format(i + 1)}
            </div>
            {t ? (
              <TextView
                plan={plan}
                text={{ ...t, animation: "rise", delayMs: 0 }}
                ms={local - 100}
                beatMs={beat.durationMs}
              />
            ) : null}
          </div>
        );
      })}
    </>
  );
};

/* ------------------------------------------------------------------ slider / badge / panel ------- */

const Slider: React.FC<Props<"slider">> = ({ plan, overlay: o, ms }) => {
  const p = plan.style.palette;
  const pct = sliderPct(o, ms);
  const x = o.box.x + o.box.w * pct;
  const appear = prog(ms, o.delayMs - 200, 250);
  return (
    <div style={{ opacity: appear }}>
      <div
        style={{
          position: "absolute",
          left: x - 3,
          top: o.box.y,
          width: 6,
          height: o.box.h,
          background: "#ffffff",
          boxShadow: "0 0 30px rgba(0,0,0,0.45)",
        }}
      />
      <div
        style={{
          position: "absolute",
          left: x - 46,
          top: o.box.y + o.box.h * 0.5 - 46,
          width: 92,
          height: 92,
          borderRadius: "50%",
          background: "#ffffff",
          boxShadow: "0 12px 40px rgba(0,0,0,0.35)",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <svg width="56" height="28" viewBox="0 0 56 28">
          <path
            d="M18 4 L6 14 L18 24 M38 4 L50 14 L38 24"
            fill="none"
            stroke={mix(p.ink, "#333333", isDark(p.bg) ? 1 : 0)}
            strokeWidth="4"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </div>
    </div>
  );
};

const Badge: React.FC<Props<"badge">> = ({ plan, beat, overlay: o, ms }) => {
  const p = plan.style.palette;
  const local = ms - o.delayMs;
  const s = spring(local, 0, { stiffness: 230, damping: 16 });
  const t = text(beat, `${o.id}:${o.textSlot}`);
  const bg =
    o.tone === "accent"
      ? p.accent
      : o.tone === "surface"
        ? p.surface
        : o.tone === "dark"
          ? "rgba(10,10,12,0.72)"
          : "transparent";
  const radius =
    plan.style.overlayStyle === "industrial" || plan.style.overlayStyle === "racing"
      ? 6
      : Math.min(o.box.h / 2, plan.style.radius + 12);
  const isCta = o.tone === "accent" && o.box.h >= 96;
  const glow = isCta ? 0.5 + 0.5 * Math.sin((local / 1100) * Math.PI * 2) : 0;
  return (
    <div
      style={{
        transform: `scale(${(0.7 + 0.3 * s).toFixed(4)})`,
        transformOrigin: `${o.box.x + o.box.w / 2}px ${o.box.y + o.box.h / 2}px`,
        opacity: clamp01(local / 120),
      }}
    >
      <div
        style={{
          position: "absolute",
          left: o.box.x,
          top: o.box.y,
          width: o.box.w,
          height: o.box.h,
          borderRadius: radius,
          background: bg,
          border:
            o.tone === "outline"
              ? `3px solid ${p.accent}`
              : o.tone === "dark"
                ? "1.5px solid rgba(255,255,255,0.25)"
                : "none",
          boxShadow: isCta
            ? `0 18px 46px ${rgba(p.accent, 0.35 + glow * 0.2)}`
            : "0 10px 26px rgba(0,0,0,0.22)",
          transform: plan.style.overlayStyle === "racing" ? "skewX(-10deg)" : undefined,
        }}
      />
      {t ? (
        <TextView
          plan={plan}
          text={{
            ...t,
            animation: "none",
            delayMs: 0,
            color:
              o.tone === "accent"
                ? "accentInk"
                : o.tone === "surface"
                  ? "surfaceInk"
                  : o.tone === "dark"
                    ? "ink"
                    : t.color,
          }}
          ms={local}
          beatMs={beat.durationMs}
        />
      ) : null}
      {isCta ? (
        <svg
          width={44}
          height={44}
          style={{
            position: "absolute",
            left: o.box.x + o.box.w - 70,
            top: o.box.y + o.box.h / 2 - 22,
            transform: `translateX(${Math.sin((local / 500) * Math.PI) * 6}px)`,
          }}
        >
          <path
            d="M8 22 H34 M24 12 L34 22 L24 32"
            fill="none"
            stroke={p.accentInk}
            strokeWidth="5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      ) : null}
    </div>
  );
};

const Panel: React.FC<Props<"panel">> = ({ plan, overlay: o, ms }) => {
  const p = plan.style.palette;
  const e = prog(ms - o.delayMs, 0, 420, ease.outCubic);
  const bg =
    o.tone === "surface"
      ? p.surface
      : o.tone === "glass"
        ? rgba("#ffffff", 0.08)
        : o.tone === "dark"
          ? "rgba(8,8,10,0.72)"
          : o.tone === "accent"
            ? p.accent
            : o.tone === "scrim"
              ? "rgba(0,0,0,0.45)"
              : "transparent";
  return (
    <div
      style={{
        position: "absolute",
        left: o.box.x,
        top: o.box.y,
        width: o.box.w,
        height: o.box.h,
        borderRadius: plan.style.radius,
        background: bg,
        border: o.tone === "outline" || o.tone === "glass" ? `2px solid ${rgba(p.accent, 0.4)}` : "none",
        boxShadow: o.shadow
          ? isDark(p.bg)
            ? "0 30px 80px rgba(0,0,0,0.55)"
            : "0 26px 70px rgba(60,40,20,0.18)"
          : undefined,
        opacity: e,
        transform: `translateY(${(1 - e) * 60}px)`,
      }}
    />
  );
};

/* ------------------------------------------------------------------ effects ----------------------- */

const Particles: React.FC<Props<"particles">> = ({ plan, overlay: o, ms }) => {
  const p = plan.style.palette;
  const local = ms - o.delayMs;
  if (local < 0) return null;
  const r = rng(o.seed);
  const n = Math.round(18 + o.density * 70);
  const span = o.durationMs ?? 2400;
  const parts = Array.from({ length: n }, (_, i) => {
    const born = (i / n) * span + r() * 120;
    const life = 520 + r() * 680;
    return {
      born,
      life,
      sx: o.box.x + r() * o.box.w,
      sy: o.box.y + r() * o.box.h,
      a: r() * Math.PI * 2,
      v: 0.25 + r() * 0.6,
      size: r(),
      rot: r() * 360,
      k: r(),
    };
  });
  const color =
    o.variant === "crumbs"
      ? "#B07A43"
      : o.variant === "fur"
        ? "#C9A27A"
        : o.variant === "dust"
          ? "#E9DCC6"
          : o.variant === "light"
            ? p.glow
            : "#ffffff";
  return (
    <Svg>
      {parts.map((q, i) => {
        const age = local - q.born;
        if (age < 0 || age > q.life) return null;
        const t = age / q.life;
        let x: number;
        let y: number;
        if (o.direction === "in" && o.sink) {
          const e = ease.inCubic(t);
          x = lerp(q.sx, o.sink.x, e) + Math.sin(t * 9 + q.k * 6) * 10 * (1 - t);
          y = lerp(q.sy, o.sink.y, e);
        } else {
          const dist = q.v * age * 0.45;
          const dir =
            o.direction === "up"
              ? -Math.PI / 2 + (q.a - Math.PI) * 0.25
              : o.direction === "down"
                ? Math.PI / 2 + (q.a - Math.PI) * 0.25
                : o.direction === "left"
                  ? Math.PI + (q.a - Math.PI) * 0.25
                  : o.direction === "right"
                    ? (q.a - Math.PI) * 0.25
                    : q.a;
          x = q.sx + Math.cos(dir) * dist;
          y =
            q.sy +
            Math.sin(dir) * dist +
            (o.variant === "dust" || o.variant === "crumbs" ? 0.0006 * age * age : 0);
        }
        const alpha = Math.sin(Math.PI * t) * (o.variant === "light" ? 0.9 : 0.85);
        const size =
          o.variant === "fur"
            ? 14 + q.size * 18
            : o.variant === "crumbs"
              ? 6 + q.size * 9
              : o.variant === "sparkle"
                ? 8 + q.size * 14
                : o.variant === "light"
                  ? 6 + q.size * 12
                  : 3 + q.size * 6;
        const s = o.direction === "in" ? 1 - t * 0.7 : 1;
        if (o.variant === "fur")
          return (
            <path
              key={i}
              d={`M${x} ${y} q ${size * 0.4} ${-size * 0.6} ${size} ${-size * 0.2} t ${size * 0.6} ${size * 0.3}`}
              fill="none"
              stroke={color}
              strokeWidth={2.5}
              strokeLinecap="round"
              opacity={alpha}
              transform={`rotate(${q.rot + t * 90} ${x} ${y}) scale(1)`}
            />
          );
        if (o.variant === "crumbs")
          return (
            <polygon
              key={i}
              points={`${x},${y - size * s} ${x + size * 0.8 * s},${y + size * 0.3 * s} ${x - size * 0.6 * s},${y + size * 0.7 * s}`}
              fill={color}
              opacity={alpha}
              transform={`rotate(${q.rot + t * 200} ${x} ${y})`}
            />
          );
        if (o.variant === "sparkle")
          return (
            <path
              key={i}
              d={`M${x} ${y - size} L${x + size * 0.22} ${y - size * 0.22} L${x + size} ${y} L${x + size * 0.22} ${y + size * 0.22} L${x} ${y + size} L${x - size * 0.22} ${y + size * 0.22} L${x - size} ${y} L${x - size * 0.22} ${y - size * 0.22}Z`}
              fill={color}
              opacity={alpha}
            />
          );
        if (o.variant === "bubbles")
          return (
            <circle
              key={i}
              cx={x}
              cy={y}
              r={size}
              fill="none"
              stroke={color}
              strokeWidth={2}
              opacity={alpha}
            />
          );
        return (
          <circle
            key={i}
            cx={x}
            cy={y}
            r={size * s}
            fill={color}
            opacity={alpha}
            style={o.variant === "light" ? { filter: "blur(2px)" } : undefined}
          />
        );
      })}
    </Svg>
  );
};

const LightSweep: React.FC<Props<"light_sweep">> = ({ plan, overlay: o, ms }) => {
  const t = prog(ms - o.delayMs, 0, 1100, ease.inOutSine);
  if (t <= 0 || t >= 1) return null;
  const x = lerp(-0.6, 1.6, t);
  const dark = isDark(plan.style.palette.bg);
  return (
    <div
      style={{
        position: "absolute",
        left: o.box.x,
        top: o.box.y,
        width: o.box.w,
        height: o.box.h,
        background: `linear-gradient(${90 + o.angle}deg, rgba(255,255,255,0) ${(x - 0.18) * 100}%, rgba(255,255,255,${dark ? 0.16 : 0.45}) ${x * 100}%, rgba(255,255,255,0) ${(x + 0.18) * 100}%)`,
        mixBlendMode: dark ? "screen" : "soft-light",
        pointerEvents: "none",
      }}
    />
  );
};

const Cursor: React.FC<Props<"cursor">> = ({ overlay: o, ms }) => {
  const local = ms - o.delayMs;
  if (local < 0) return null;
  const segMs = 700;
  const seg = Math.min(o.path.length - 2, Math.floor(local / segMs));
  const t = ease.inOutCubic(clamp01((local - seg * segMs) / segMs));
  const a = o.path[seg]!;
  const b = o.path[seg + 1]!;
  const x = lerp(a.x, b.x, t);
  const y = lerp(a.y, b.y, t);
  return (
    <>
      {o.clickAtMs.map((c, i) => {
        const age = local - c;
        if (age < 0 || age > 600) return null;
        const e = age / 600;
        return (
          <div
            key={i}
            style={{
              position: "absolute",
              left: x - 10 - e * 50,
              top: y - 10 - e * 50,
              width: 20 + e * 100,
              height: 20 + e * 100,
              borderRadius: "50%",
              border: "4px solid rgba(255,255,255,0.9)",
              opacity: 1 - e,
            }}
          />
        );
      })}
      <svg
        width="64"
        height="80"
        viewBox="0 0 32 40"
        style={{
          position: "absolute",
          left: x - 6,
          top: y - 4,
          filter: "drop-shadow(0 6px 10px rgba(0,0,0,0.45))",
        }}
      >
        <path
          d="M3 2 L3 30 L10 23 L15 35 L20 33 L15 21 L25 21 Z"
          fill="#ffffff"
          stroke="#111111"
          strokeWidth="2"
          strokeLinejoin="round"
        />
      </svg>
    </>
  );
};

const Timer: React.FC<Props<"timer">> = ({ plan, beat, overlay: o, ms }) => {
  const p = plan.style.palette;
  const local = ms - o.delayMs;
  const run = clamp01(local / Math.max(1, beat.durationMs - o.delayMs - 200));
  const secs = Math.round(run * o.seconds);
  const digits = text(beat, `${o.id}:digits`);
  const label = o.labelSlot ? text(beat, `${o.id}:${o.labelSlot}`) : undefined;
  const R = o.box.h / 2 - 8;
  const cx = o.box.x + o.box.h / 2;
  const cy = o.box.y + o.box.h / 2;
  const c = 2 * Math.PI * R;
  const appear = prog(local, 0, 250);
  return (
    <div style={{ opacity: appear }}>
      <Svg>
        <circle cx={cx} cy={cy} r={R} fill={rgba(p.bg, 0.6)} stroke={rgba(p.ink, 0.2)} strokeWidth={10} />
        <circle
          cx={cx}
          cy={cy}
          r={R}
          fill="none"
          stroke={p.accent}
          strokeWidth={10}
          strokeDasharray={`${c} ${c}`}
          strokeDashoffset={c * (1 - run)}
          transform={`rotate(-90 ${cx} ${cy})`}
          strokeLinecap="round"
        />
        <rect x={cx - 9} y={o.box.y - 14} width={18} height={14} rx={4} fill={p.accent} />
      </Svg>
      {digits ? (
        <TextView
          plan={plan}
          text={{
            ...digits,
            animation: "none",
            delayMs: 0,
            lines: [[{ text: `00:${String(secs).padStart(2, "0")}`, emphasis: false }]],
          }}
          ms={local}
          beatMs={beat.durationMs}
        />
      ) : null}
      {label ? (
        <TextView
          plan={plan}
          text={{ ...label, animation: "slide_left", delayMs: 0 }}
          ms={local}
          beatMs={beat.durationMs}
        />
      ) : null}
    </div>
  );
};
