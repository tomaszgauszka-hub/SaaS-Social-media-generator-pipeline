import { z } from "zod";
import { DEMO_PRODUCTS, registerDemoProduct } from "../library/products.ts";
import {
  BACKGROUND_PRESETS,
  BLENDER_TEMPLATES,
  CAMERA_PRESETS,
  ENVIRONMENT_PRESETS,
  LIGHTING_PRESETS,
  MATERIAL_TYPES_3D,
  MOVEMENTS,
  PRODUCT_ACTIONS,
  Recipe3D,
  UNREAL_TEMPLATES,
} from "../contracts/recipe.ts";
import { AssetType3D } from "../contracts/asset.ts";
import { SafeId } from "@cre/reel/contracts";
import type { Render3DSetup } from "../setup.ts";

/*
 * Thin MCP orchestration layer over the 3D pipeline (JSON-RPC 2.0 over stdio, MCP tools). It exposes a closed
 * set of tools — capabilities, templates, recipe validation, a routing dry run, a preview / production render
 * through the same render worker the queue uses, and library reads. There is deliberately no tool that runs
 * code, and no approval tool: approving a clip for publication is the owner's decision in the panel.
 * Interactive scene building in Blender goes through the Blender MCP server (separate entry in .mcp.json).
 */

export const PROTOCOL_VERSION = "2025-06-18";

interface ToolDef<S extends z.ZodType> {
  name: string;
  description: string;
  input: S;
  run: (args: z.infer<S>, setup: Render3DSetup) => Promise<unknown>;
}

const tool = <S extends z.ZodType>(t: ToolDef<S>) => t as unknown as ToolDef<z.ZodType>;

export const TOOLS: ToolDef<z.ZodType>[] = [
  tool({
    name: "render3d_capabilities",
    description:
      "Which 3D engines this host can run (Blender / Unreal), their versions, GPU and why one is unavailable.",
    input: z.object({}).strict(),
    run: async (_a, s) => s.worker.capabilities(true),
  }),
  tool({
    name: "render3d_templates",
    description:
      "Closed vocabularies of the recipe: templates, camera / lighting / background / environment presets, product actions, storyboard material types and the DEMO_ONLY procedural products.",
    input: z.object({}).strict(),
    run: () =>
      Promise.resolve({
        blenderTemplates: BLENDER_TEMPLATES,
        unrealTemplates: UNREAL_TEMPLATES,
        cameraPresets: CAMERA_PRESETS,
        movements: MOVEMENTS,
        lightingPresets: LIGHTING_PRESETS,
        backgroundPresets: BACKGROUND_PRESETS,
        environmentPresets: ENVIRONMENT_PRESETS,
        productActions: PRODUCT_ACTIONS,
        materialTypes: MATERIAL_TYPES_3D,
        demoProducts: Object.fromEntries(
          Object.entries(DEMO_PRODUCTS).map(([id, d]) => [
            id,
            { description: d.description, actions: d.actions, parts: d.parts.map((p) => p.name) },
          ]),
        ),
      }),
  }),
  tool({
    name: "render3d_validate_recipe",
    description: "Validate a Recipe3D and return it normalised (defaults filled) or the validation errors.",
    input: z.object({ recipe: z.record(z.string(), z.unknown()) }).strict(),
    run: (a: { recipe: Record<string, unknown> }) => {
      const r = Recipe3D.safeParse(a.recipe);
      return Promise.resolve(
        r.success ? { ok: true, recipe: r.data } : { ok: false, issues: r.error.issues },
      );
    },
  }),
  tool({
    name: "render3d_route",
    description:
      "Dry run of the 3D render router: which engine (library reuse, 2D, Blender, Unreal, defer, blocked) would produce this recipe, why, estimated time and local cost. Renders nothing.",
    input: z
      .object({ recipe: z.record(z.string(), z.unknown()), valueScore: z.number().min(0).max(1).optional() })
      .strict(),
    run: async (a: { recipe: Record<string, unknown>; valueScore?: number }, s) => {
      const d = await s.worker.route({
        jobId: "mcp-route",
        recipe: Recipe3D.parse(a.recipe),
        ...(a.valueScore !== undefined ? { valueScore: a.valueScore } : {}),
      });
      return { ...d, existingAsset: d.existingAsset ? { assetId: d.existingAsset.assetId } : null };
    },
  }),
  tool({
    name: "render3d_render",
    description:
      "Render a recipe through the render worker (same router, cache, QA and library as the job queue). Blocks until done. Optionally registers a DEMO_ONLY procedural product first. Never publishes anything.",
    input: z
      .object({
        recipe: z.record(z.string(), z.unknown()),
        jobId: SafeId.optional(),
        demoProduct: z.enum(Object.keys(DEMO_PRODUCTS) as [string, ...string[]]).optional(),
      })
      .strict(),
    run: async (a: { recipe: Record<string, unknown>; jobId?: string; demoProduct?: string }, s) => {
      if (a.demoProduct) await registerDemoProduct(s.library, a.demoProduct);
      const r = await s.worker.run({
        jobId: a.jobId ?? `mcp-${Date.now().toString(36)}`,
        recipe: Recipe3D.parse(a.recipe),
        requireApprovedPreview: s.env.RENDER3D_REQUIRE_APPROVED_PREVIEW,
      });
      return {
        engine: r.decision.engine,
        reasons: r.decision.reasons,
        reused: r.reused,
        assetId: r.asset?.assetId ?? null,
        files: r.asset?.outputFiles.map((f) => ({ role: f.role, key: f.key })) ?? [],
        qa: r.qa
          ? {
              passed: r.qa.passed,
              score: r.qa.score,
              failed: r.qa.checks.filter((c) => !c.ok).map((c) => c.id),
            }
          : null,
        costUsd: r.cost?.usd ?? 0,
        renderMs: r.telemetry?.renderDurationMs ?? 0,
        approval: r.asset?.approval.status ?? null,
      };
    },
  }),
  tool({
    name: "render3d_library",
    description:
      "List 3D library assets (product models, clips …) with provenance, licence, fidelity and approval status.",
    input: z
      .object({
        assetType: AssetType3D.optional(),
        productId: z.string().max(120).optional(),
        limit: z.number().int().min(1).max(200).default(50),
      })
      .strict(),
    run: async (a: { assetType?: z.infer<typeof AssetType3D>; productId?: string; limit: number }, s) =>
      (
        await s.library.list({
          ...(a.assetType ? { assetType: a.assetType } : {}),
          ...(a.productId ? { productId: a.productId } : {}),
          limit: a.limit,
        })
      ).map((x) => ({
        assetId: x.assetId,
        assetType: x.assetType,
        template: x.template,
        quality: x.quality,
        fidelity: x.fidelity,
        demoOnly: x.isDemoOnly,
        license: x.license,
        approval: x.approval.status,
        qaScore: x.qa?.score ?? null,
        costUsd: x.renderCostEstimateUsd,
        createdAt: x.createdAt,
      })),
  }),
  tool({
    name: "render3d_asset",
    description: "Full metadata record of one 3D library asset.",
    input: z.object({ assetId: SafeId }).strict(),
    run: async (a: { assetId: string }, s) => (await s.library.get(a.assetId)) ?? { error: "not found" },
  }),
];

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: number | string | null;
  method: string;
  params?: Record<string, unknown>;
}

type Reply = Record<string, unknown> | null;

/** Handle one JSON-RPC message; returns the response object, or null for notifications. */
export async function handleMessage(msg: JsonRpcRequest, setup: () => Render3DSetup): Promise<Reply> {
  const ok = (result: unknown) => ({ jsonrpc: "2.0", id: msg.id ?? null, result });
  const fail = (code: number, message: string) => ({
    jsonrpc: "2.0",
    id: msg.id ?? null,
    error: { code, message },
  });
  const isNotification = msg.id === undefined || msg.id === null;
  switch (msg.method) {
    case "initialize":
      return ok({
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "render3d", version: "0.1.0" },
        instructions:
          "Local 3D production of this repo. Recipes name closed-set values only; renders run through the same worker, cache, QA and library as the job queue. Approval for publication is the owner's (panel), not a tool.",
      });
    case "ping":
      return ok({});
    case "tools/list":
      return ok({
        tools: TOOLS.map((t) => ({
          name: t.name,
          description: t.description,
          inputSchema: z.toJSONSchema(t.input, { io: "input" }),
        })),
      });
    case "tools/call": {
      const raw = msg.params?.name;
      const name = typeof raw === "string" ? raw : "";
      const t = TOOLS.find((x) => x.name === name);
      if (!t) return fail(-32602, `unknown tool ${name}`);
      const parsed = t.input.safeParse(msg.params?.arguments ?? {});
      if (!parsed.success)
        return ok({
          isError: true,
          content: [{ type: "text", text: `invalid arguments: ${parsed.error.message}` }],
        });
      try {
        const result = await t.run(parsed.data, setup());
        return ok({ content: [{ type: "text", text: JSON.stringify(result, null, 1) }] });
      } catch (e) {
        return ok({ isError: true, content: [{ type: "text", text: (e as Error).message.slice(0, 2000) }] });
      }
    }
    default:
      if (isNotification) return null; // notifications/initialized, notifications/cancelled …
      return fail(-32601, `method not found: ${msg.method}`);
  }
}
