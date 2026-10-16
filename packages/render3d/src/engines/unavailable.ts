import os from "node:os";
import {
  EngineUnavailableError,
  type EngineCapabilities,
  type EngineId,
  type EngineRenderOutput,
  type RenderEngine,
} from "../contracts/engine.ts";

/** An engine that is not installed / configured on this host: probes as unavailable with the reason. */
export class UnavailableEngine implements RenderEngine {
  constructor(
    readonly id: EngineId,
    private readonly reason: string,
  ) {}

  probe(): Promise<EngineCapabilities> {
    return Promise.resolve({
      engine: this.id,
      available: false,
      version: null,
      reason: this.reason,
      gpu: { available: false, name: null, vramMb: null },
      renderers: [],
      host: os.hostname(),
    });
  }

  render(): Promise<EngineRenderOutput> {
    return Promise.reject(new EngineUnavailableError(this.id, this.reason));
  }
}
