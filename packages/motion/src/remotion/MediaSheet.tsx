import type { MediaRef, Palette } from "@cre/creative";
import type React from "react";
import { AbsoluteFill, useCurrentFrame, useVideoConfig } from "remotion";
import { VECTORS } from "./demo-media/registry.tsx";
import { fontAlias } from "./util.ts";

/**
 * Review sheet for one illustration: drawn contained on a neutral checker, with every anchor marked — used to
 * keep anchors (callout targets, macro focus points) aligned with the drawing.
 */
export type MediaSheetProps = {
  media: MediaRef | null;
  palette: Palette | null;
  showAnchors: boolean;
};

export const MediaSheet: React.FC<MediaSheetProps> = ({ media, palette, showAnchors }) => {
  const frame = useCurrentFrame();
  const { fps, width: W, height: H } = useVideoConfig();
  if (!media || !palette) return null;
  const V = VECTORS[media.src];
  const pad = 40;
  const s = Math.min((W - pad * 2) / media.width, (H - 200 - pad * 2) / media.height);
  const w = media.width * s;
  const h = media.height * s;
  const x = (W - w) / 2;
  const y = 160 + (H - 160 - h) / 2;
  return (
    <AbsoluteFill
      style={{ background: "repeating-conic-gradient(#d9d9d9 0% 25%, #f2f2f2 0% 50%) 50% / 40px 40px" }}
    >
      <div
        style={{
          position: "absolute",
          left: 40,
          top: 40,
          fontFamily: fontAlias("Inter"),
          fontWeight: 700,
          fontSize: 40,
          color: "#222",
        }}
      >
        {media.src} · {media.width}×{media.height}
      </div>
      <svg
        width={w}
        height={h}
        viewBox={`0 0 ${media.width} ${media.height}`}
        style={{ position: "absolute", left: x, top: y, outline: "2px dashed rgba(0,0,0,0.35)" }}
      >
        {V ? (
          <V.Component params={media.params} ms={(frame * 1000) / fps} beatMs={3000} palette={palette} />
        ) : null}
      </svg>
      {showAnchors
        ? Object.entries(media.anchors).map(([name, a]) => (
            <div key={name} style={{ position: "absolute", left: x + a.x * w, top: y + a.y * h }}>
              <div
                style={{
                  position: "absolute",
                  left: -9,
                  top: -9,
                  width: 18,
                  height: 18,
                  borderRadius: 9,
                  background: "#ff1f6b",
                  border: "3px solid #fff",
                }}
              />
              <div
                style={{
                  position: "absolute",
                  left: 14,
                  top: -14,
                  fontFamily: fontAlias("Inter"),
                  fontWeight: 700,
                  fontSize: 22,
                  color: "#fff",
                  background: "rgba(0,0,0,0.7)",
                  padding: "2px 8px",
                  borderRadius: 6,
                  whiteSpace: "nowrap",
                }}
              >
                {name}
              </div>
            </div>
          ))
        : null}
    </AbsoluteFill>
  );
};
