import type { VectorDef } from "./shared.tsx";
import { DeskAfter, DeskBefore, Hub, HubScreen } from "./gadgets.tsx";
import { CabinetLight, CabinetScene } from "./home.tsx";
import { Drill, DrillWork } from "./tools.tsx";

/** Renderer registry of the parametric demo illustrations (keys = DEMO_MEDIA keys in @cre/creative/benchmark). */
export const VECTORS: Record<string, VectorDef> = {
  drill: { Component: Drill },
  drill_work: { Component: DrillWork },
  hub: { Component: Hub },
  hub_screen: { Component: HubScreen },
  desk_before: { Component: DeskBefore },
  desk_after: { Component: DeskAfter },
  cabinet_light: { Component: CabinetLight },
  cabinet_scene: { Component: CabinetScene },
};
