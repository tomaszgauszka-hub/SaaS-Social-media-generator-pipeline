import type { VectorDef } from "./shared.tsx";
import { CarInterior, CarMat, CarVacuum } from "./automotive.tsx";
import { LedMirror, VanityScene } from "./beauty.tsx";
import { DeskAfter, DeskBefore, Hub, HubScreen } from "./gadgets.tsx";
import { CabinetLight, CabinetScene } from "./home.tsx";
import { DogScene, GroomKit, SofaScene } from "./pet.tsx";
import {
  SunFlatlay,
  SunMineral,
  SunOutdoor,
  SunPodium,
  SunTexture,
  SunTube,
  SunVanity,
} from "./sunscreen.tsx";
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
  car_vacuum: { Component: CarVacuum },
  car_interior: { Component: CarInterior },
  car_mat: { Component: CarMat },
  led_mirror: { Component: LedMirror },
  vanity_scene: { Component: VanityScene },
  groom_kit: { Component: GroomKit },
  dog_scene: { Component: DogScene },
  sofa_scene: { Component: SofaScene },
  sun_tube: { Component: SunTube },
  sun_podium: { Component: SunPodium },
  sun_vanity: { Component: SunVanity },
  sun_mineral: { Component: SunMineral },
  sun_texture: { Component: SunTexture },
  sun_outdoor: { Component: SunOutdoor },
  sun_flatlay: { Component: SunFlatlay },
};
