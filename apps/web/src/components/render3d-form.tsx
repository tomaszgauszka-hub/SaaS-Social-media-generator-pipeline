"use client";

import { startTransition, useActionState, useState, type ReactNode } from "react";
import { render3dFormAction, type Render3DFormState } from "@/app/actions/render3d";
import type { FormField, ProductOption, RoutePreview } from "@/lib/render3d";
import {
  ENGINE_MODE_LABEL,
  fidelityBadge,
  humanize,
  localCostLabel,
  materialLabel,
  ROUTE_ENGINE_LABEL,
  templateLabel,
} from "@/lib/render3d-labels";

export interface MaterialDefaults {
  template: string;
  camera: string;
  movement: string;
  lighting: string;
  background: string;
  environment: string;
  durationSec: number;
}

export interface Render3DFormOptions {
  products: ProductOption[];
  materialTypes: string[];
  defaults: Record<string, MaterialDefaults>;
  templateMaterial: Record<string, string>;
  engines: string[];
  blenderTemplates: string[];
  unrealTemplates: string[];
  structuralTemplates: string[];
  cameras: string[];
  movements: string[];
  lightings: string[];
  backgrounds: string[];
  environments: string[];
  stationOnline: boolean;
  requireApprovedPreview: boolean;
}

type Intent = "check" | "preview" | "production";

const TAP = "min-h-11 sm:min-h-10";

function templatesFor(engine: string, o: Render3DFormOptions): string[] {
  if (engine === "BLENDER") return o.blenderTemplates;
  if (engine === "UNREAL") return o.unrealTemplates;
  return [...o.blenderTemplates, ...o.unrealTemplates];
}

/** Keep the template valid for the engine: the material type's default, else the first allowed one. */
function fitTemplate(current: string, engine: string, material: string, o: Render3DFormOptions): string {
  const allowed = templatesFor(engine, o);
  if (allowed.includes(current)) return current;
  const preferred = o.defaults[material]?.template;
  if (preferred && allowed.includes(preferred)) return preferred;
  return allowed[0] ?? current;
}

function Field({
  label,
  error,
  hint,
  className = "",
  children,
}: {
  label: string;
  error?: string | undefined;
  hint?: ReactNode;
  className?: string;
  children: ReactNode;
}) {
  return (
    <label className={`block min-w-0 ${className}`}>
      <span className="label">{label}</span>
      {children}
      {error ? (
        <span role="alert" className="mt-1 block text-xs font-semibold text-rose-700">
          {error}
        </span>
      ) : hint ? (
        <span className="mt-1 block text-xs text-zinc-500">{hint}</span>
      ) : null}
    </label>
  );
}

function RouteBox({ route, stale }: { route: RoutePreview; stale: boolean }) {
  const tone =
    route.engine === "BLOCKED"
      ? "border-rose-200 bg-rose-50"
      : route.engine === "DEFER"
        ? "border-amber-200 bg-amber-50"
        : "border-zinc-200 bg-zinc-50";
  return (
    <section
      aria-label="Router decision"
      className={`rounded-lg border p-3 text-sm ${tone} ${stale ? "opacity-60" : ""}`}
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs font-semibold tracking-wide text-zinc-500 uppercase">Router decision</span>
        <span className="font-semibold">{ROUTE_ENGINE_LABEL[route.engine] ?? route.engine}</span>
        {stale ? <span className="text-xs text-zinc-500">(form changed — check again)</span> : null}
      </div>
      <p className="mt-1 text-xs text-zinc-600">
        {templateLabel(route.askedTemplate)}
        {route.template && route.template !== route.askedTemplate
          ? ` → rendered as ${templateLabel(route.template)}`
          : ""}{" "}
        · {route.quality}
      </p>
      {route.estimate ? (
        <p className="mt-2 font-semibold tabular-nums">
          ≈{" "}
          {route.estimate.seconds < 90
            ? `${route.estimate.seconds} s`
            : `${Math.round(route.estimate.seconds / 60)} min`}{" "}
          on {route.estimate.engine} {route.estimate.device} · ≈ {localCostLabel(route.estimate.costUsd)}{" "}
          local cost
          <span className="block text-xs font-normal text-zinc-500">
            {route.estimate.frames} frames at {route.estimate.size} ·{" "}
            {route.estimate.source === "telemetry" ? "from recent render telemetry" : "default timing model"}
            {route.estimate.planning ? " · planning estimate while the station is offline" : ""} · energy +
            hardware wear, no paid services
          </span>
        </p>
      ) : null}
      {route.existingAssetId ? (
        <p className="mt-2 text-xs">
          Existing clip:{" "}
          <a href={`#${route.existingAssetId}`} className="font-mono font-semibold text-brand-700 underline">
            {route.existingAssetId}
          </a>
        </p>
      ) : null}
      <ul className="mt-2 list-disc space-y-0.5 pl-5 text-xs text-zinc-700">
        {route.reasons.map((r, i) => (
          <li key={i} className="break-words">
            {r}
          </li>
        ))}
      </ul>
      {route.rejected.length ? (
        <details className="mt-2 text-xs text-zinc-600">
          <summary className="cursor-pointer py-1">Alternatives not chosen ({route.rejected.length})</summary>
          <ul className="list-disc space-y-0.5 pl-5">
            {route.rejected.map((r, i) => (
              <li key={i} className="break-words">
                <strong>{ROUTE_ENGINE_LABEL[r.engine] ?? r.engine}:</strong> {r.why}
              </li>
            ))}
          </ul>
        </details>
      ) : null}
      {route.production ? (
        <p
          className={`mt-2 rounded px-2 py-1 text-xs ${route.production.ready ? "bg-emerald-100 text-emerald-900" : "bg-amber-100 text-amber-900"}`}
        >
          {route.production.message}
        </p>
      ) : null}
    </section>
  );
}

/** "Generate 3D material": recipe fields (prefilled per material type), router dry run and render buttons. */
export function Render3DForm({ options: o }: { options: Render3DFormOptions }) {
  const [state, formAction, pending] = useActionState<Render3DFormState | null, FormData>(
    render3dFormAction,
    null,
  );
  const firstMaterial = o.materialTypes[0] ?? "3D_PRODUCT_HERO";
  const d0 = o.defaults[firstMaterial];
  const [productId, setProductId] = useState(o.products[0]?.assetId ?? "");
  const [material, setMaterial] = useState(firstMaterial);
  const [engine, setEngine] = useState("AUTO");
  const [template, setTemplate] = useState(d0?.template ?? o.blenderTemplates[0] ?? "");
  const [camera, setCamera] = useState(d0?.camera ?? o.cameras[0] ?? "");
  const [movement, setMovement] = useState(d0?.movement ?? "slow");
  const [lighting, setLighting] = useState(d0?.lighting ?? o.lightings[0] ?? "");
  const [background, setBackground] = useState(d0?.background ?? o.backgrounds[0] ?? "");
  const [environment, setEnvironment] = useState(d0?.environment ?? "");
  const [focus, setFocus] = useState("");
  const [duration, setDuration] = useState(String(d0?.durationSec ?? 4));
  const [intent, setIntent] = useState<Intent>("preview");
  const [changedAfter, setChangedAfter] = useState<Render3DFormState | null>(null);

  const product = o.products.find((p) => p.assetId === productId) ?? null;
  const parts = product?.parts ?? [];
  const templates = templatesFor(engine, o);
  const fe: Partial<Record<FormField, string>> = state?.fieldErrors ?? {};
  const stale = state !== null && changedAfter === state;
  const touched = () => setChangedAfter(state);

  const applyMaterial = (m: string) => {
    const d = o.defaults[m];
    setMaterial(m);
    if (!d) return;
    setTemplate(fitTemplate(d.template, engine, m, o));
    setCamera(d.camera);
    setMovement(d.movement);
    setLighting(d.lighting);
    setBackground(d.background);
    setEnvironment(d.environment);
    setDuration(String(d.durationSec));
  };

  const fid = product ? fidelityBadge(product.fidelity, product.isDemoOnly) : null;
  const clipMaterial = o.templateMaterial[template];
  const structural = o.structuralTemplates.includes(template) && product && !product.structureVerified;

  return (
    <form
      className="space-y-4"
      aria-busy={pending}
      onChange={touched}
      onSubmit={(e) => {
        // explicit submit (no automatic form reset after the action: the recipe stays for the next take)
        e.preventDefault();
        const submitter = e.nativeEvent.submitter;
        const data = new FormData(e.currentTarget, submitter);
        startTransition(() => formAction(data));
      }}
    >
      {!o.stationOnline ? (
        <p className="rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-900">
          The render station is offline — you can still queue renders: they wait in the queue and start by
          themselves when the station is back.
        </p>
      ) : null}
      <div className="grid gap-3 sm:grid-cols-2">
        <Field
          label="Product model"
          className="sm:col-span-2"
          error={fe.productAssetId}
          hint={
            product ? (
              <>
                <span
                  className={`font-semibold ${fid?.tone === "red" ? "text-rose-700" : fid?.tone === "amber" ? "text-amber-800" : "text-zinc-700"}`}
                >
                  {fid?.label}
                </span>{" "}
                · {product.license}
                {product.demo && !product.registered ? " · added to the library on the first render" : ""}
              </>
            ) : null
          }
        >
          <select
            name="productAssetId"
            value={productId}
            onChange={(e) => {
              setProductId(e.target.value);
              const next = o.products.find((p) => p.assetId === e.target.value);
              if (!next?.parts.some((p) => p.name === focus)) setFocus("");
            }}
            className={`input ${TAP}`}
          >
            {o.products.some((p) => !p.demo) ? (
              <optgroup label="Your product models">
                {o.products
                  .filter((p) => !p.demo)
                  .map((p) => (
                    <option key={p.assetId} value={p.assetId}>
                      {p.label}
                    </option>
                  ))}
              </optgroup>
            ) : null}
            <optgroup label="Demo products (DEMO_ONLY, never published)">
              {o.products
                .filter((p) => p.demo)
                .map((p) => (
                  <option key={p.assetId} value={p.assetId}>
                    {p.label}
                  </option>
                ))}
            </optgroup>
          </select>
        </Field>

        <Field label="Material type" error={fe.materialType}>
          <select
            name="materialType"
            value={material}
            onChange={(e) => applyMaterial(e.target.value)}
            className={`input ${TAP}`}
          >
            {o.materialTypes.map((m) => (
              <option key={m} value={m}>
                {materialLabel(m)}
              </option>
            ))}
          </select>
        </Field>

        <Field
          label="Engine"
          error={fe.engine}
          hint={
            engine === "2D_ONLY"
              ? "No 3D render: the reel's 2D pipeline animates the product media."
              : engine === "EXISTING_ASSET"
                ? "Only reuses a clip with exactly this recipe — never renders."
                : null
          }
        >
          <select
            name="engine"
            value={engine}
            onChange={(e) => {
              setEngine(e.target.value);
              setTemplate((t) => fitTemplate(t, e.target.value, material, o));
            }}
            className={`input ${TAP}`}
          >
            {o.engines.map((m) => (
              <option key={m} value={m}>
                {ENGINE_MODE_LABEL[m] ?? m}
              </option>
            ))}
          </select>
        </Field>

        <Field
          label="Scene template"
          className="sm:col-span-2"
          error={fe.template}
          hint={
            structural
              ? "This template shows the product's construction — the selected model has no verified part structure, so the router will block it."
              : clipMaterial && clipMaterial !== material
                ? `The clip will be labelled “${materialLabel(clipMaterial)}”.`
                : null
          }
        >
          <select
            name="template"
            value={template}
            onChange={(e) => setTemplate(e.target.value)}
            className={`input ${TAP}`}
          >
            {templates.some((t) => o.blenderTemplates.includes(t)) ? (
              <optgroup label="Blender">
                {templates
                  .filter((t) => o.blenderTemplates.includes(t))
                  .map((t) => (
                    <option key={t} value={t}>
                      {templateLabel(t)}
                      {o.structuralTemplates.includes(t) && product && !product.structureVerified
                        ? " (needs verified parts)"
                        : ""}
                    </option>
                  ))}
              </optgroup>
            ) : null}
            {templates.some((t) => o.unrealTemplates.includes(t)) ? (
              <optgroup label="Unreal Engine 5 (cinematic)">
                {templates
                  .filter((t) => o.unrealTemplates.includes(t))
                  .map((t) => (
                    <option key={t} value={t}>
                      {templateLabel(t)}
                    </option>
                  ))}
              </optgroup>
            ) : null}
          </select>
        </Field>

        <Field label="Camera" error={fe.camera}>
          <select
            name="camera"
            value={camera}
            onChange={(e) => setCamera(e.target.value)}
            className={`input ${TAP}`}
          >
            {o.cameras.map((c) => (
              <option key={c} value={c}>
                {humanize(c)}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Camera movement" error={fe.movement}>
          <select
            name="movement"
            value={movement}
            onChange={(e) => setMovement(e.target.value)}
            className={`input ${TAP}`}
          >
            {o.movements.map((m) => (
              <option key={m} value={m}>
                {humanize(m)}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Lighting" error={fe.lighting}>
          <select
            name="lighting"
            value={lighting}
            onChange={(e) => setLighting(e.target.value)}
            className={`input ${TAP}`}
          >
            {o.lightings.map((l) => (
              <option key={l} value={l}>
                {humanize(l)}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Background" error={fe.background}>
          <select
            name="background"
            value={background}
            onChange={(e) => setBackground(e.target.value)}
            className={`input ${TAP}`}
          >
            {o.backgrounds.map((b) => (
              <option key={b} value={b}>
                {humanize(b)}
              </option>
            ))}
          </select>
        </Field>
        <Field
          label="Environment"
          error={fe.environment}
          hint={
            !environment && (template === "LIFESTYLE" || background === "environment")
              ? "Required for lifestyle scenes and the “environment” background."
              : null
          }
        >
          <select
            name="environment"
            value={environment}
            onChange={(e) => setEnvironment(e.target.value)}
            className={`input ${TAP}`}
          >
            <option value="">None (studio)</option>
            {o.environments.map((v) => (
              <option key={v} value={v}>
                {humanize(v)}
              </option>
            ))}
          </select>
        </Field>
        <Field
          label="Focus part"
          error={fe.focus}
          hint={parts.length ? null : "This model has no named parts."}
        >
          <select
            name="focus"
            value={focus}
            onChange={(e) => setFocus(e.target.value)}
            className={`input ${TAP}`}
            disabled={!parts.length}
          >
            <option value="">Whole product</option>
            {parts.map((p) => (
              <option key={p.name} value={p.name}>
                {humanize(p.name)} · {p.role}
                {p.internal ? " (internal)" : ""}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Duration (seconds)" error={fe.durationSec} hint="0.5 – 20 s">
          <input
            name="durationSec"
            type="number"
            inputMode="decimal"
            min={0.5}
            max={20}
            step={0.5}
            value={duration}
            onChange={(e) => setDuration(e.target.value)}
            className={`input ${TAP}`}
          />
        </Field>
      </div>

      {fe._form ? (
        <p role="alert" className="text-sm font-semibold text-rose-700">
          {fe._form}
        </p>
      ) : null}

      <div className="grid grid-cols-1 gap-2 sm:flex sm:flex-wrap sm:items-center">
        <button
          type="submit"
          name="intent"
          value="preview"
          onClick={() => setIntent("preview")}
          disabled={pending}
          className="btn-primary min-h-12 text-base sm:min-h-10 sm:text-sm"
        >
          {pending && intent === "preview" ? "Queuing…" : "Render preview"}
        </button>
        <button
          type="submit"
          name="intent"
          value="production"
          onClick={() => setIntent("production")}
          disabled={pending}
          className="btn-secondary min-h-12 text-base sm:min-h-10 sm:text-sm"
        >
          {pending && intent === "production" ? "Queuing…" : "Render production"}
        </button>
        <button
          type="submit"
          name="intent"
          value="check"
          onClick={() => setIntent("check")}
          disabled={pending}
          className="btn-ghost min-h-12 text-base ring-1 ring-zinc-200 sm:min-h-10 sm:text-sm"
        >
          {pending && intent === "check" ? "Checking…" : "Check route"}
        </button>
      </div>
      <p className="text-xs text-zinc-500">
        Preview: half resolution, 24 samples. Production: full resolution, 96 samples
        {o.requireApprovedPreview
          ? " — needs an approved preview of the same recipe (the render worker checks it again)"
          : ""}
        . “Check route” is a dry run: nothing is queued or saved.
      </p>

      {state ? (
        <p
          role="status"
          className={`rounded-lg px-3 py-2 text-sm ${state.ok ? "bg-emerald-50 text-emerald-800" : "bg-rose-50 text-rose-800"} ${stale ? "opacity-60" : ""}`}
        >
          {state.message}
          {state.jobId ? <span className="block font-mono text-xs opacity-70">job {state.jobId}</span> : null}
        </p>
      ) : null}
      {state?.route ? <RouteBox route={state.route} stale={stale} /> : null}
    </form>
  );
}
