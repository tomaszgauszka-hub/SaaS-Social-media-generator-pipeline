import type { FontAsset } from "@cre/creative";
import type React from "react";
import { useEffect, useState } from "react";
import { cancelRender, continueRender, delayRender, staticFile } from "remotion";
import { fontAlias } from "./util.ts";

/**
 * Loads every font face of the plan (all unicode subsets) under its private alias before the first frame is
 * captured. The files are the same woff2 files the text-fit engine measured.
 */
export const FontGate: React.FC<{ fonts: FontAsset[]; children: React.ReactNode }> = ({
  fonts,
  children,
}) => {
  const [handle] = useState(() => delayRender("Loading fonts", { timeoutInMilliseconds: 60_000 }));
  useEffect(() => {
    const faces = fonts.flatMap((f) =>
      f.files.map((file) => {
        const face = new FontFace(
          fontAlias(f.family),
          `url("${staticFile(`fonts/${file.file}`)}") format("woff2")`,
          {
            weight: String(f.weight),
            style: f.style,
            unicodeRange: file.unicodeRange,
          },
        );
        document.fonts.add(face);
        return face.load();
      }),
    );
    Promise.all(faces)
      .then(() => continueRender(handle))
      .catch((err: unknown) => cancelRender(err instanceof Error ? err : new Error(String(err))));
  }, [fonts, handle]);
  return <>{children}</>;
};
