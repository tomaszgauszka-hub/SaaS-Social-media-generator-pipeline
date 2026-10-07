import type { RenderPlan } from "@cre/creative";
import type React from "react";
import { Composition, registerRoot } from "remotion";
import { FontGate } from "./FontGate.tsx";
import { MediaSheet, type MediaSheetProps } from "./MediaSheet.tsx";
import { Reel } from "./Reel.tsx";

/** Remotion entry: the creative reel (props = a resolved RenderPlan) and the media review sheet. */
type ReelProps = {
  plan: RenderPlan | null;
};
type SheetProps = MediaSheetProps & { fonts: RenderPlan["fonts"] };

const CreativeReel: React.FC<ReelProps> = ({ plan }) =>
  plan ? (
    <FontGate fonts={plan.fonts}>
      <Reel plan={plan} />
    </FontGate>
  ) : null;

const Sheet: React.FC<SheetProps> = ({ fonts, ...rest }) => (
  <FontGate fonts={fonts}>
    <MediaSheet {...rest} />
  </FontGate>
);

const Root: React.FC = () => (
  <>
    <Composition
      id="CreativeReel"
      component={CreativeReel}
      width={1080}
      height={1920}
      fps={30}
      durationInFrames={30}
      defaultProps={{ plan: null }}
      calculateMetadata={({ props }) =>
        props.plan
          ? {
              durationInFrames: props.plan.durationInFrames,
              fps: props.plan.format.fps,
              width: props.plan.format.width,
              height: props.plan.format.height,
            }
          : {}
      }
    />
    <Composition
      id="MediaSheet"
      component={Sheet}
      width={1080}
      height={1920}
      fps={30}
      durationInFrames={90}
      defaultProps={{ media: null, palette: null, showAnchors: true, fonts: [] }}
    />
  </>
);

registerRoot(Root);
