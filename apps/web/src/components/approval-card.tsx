"use client";

import { useState, useTransition } from "react";
import { approveAction, editTextAction, regenerateAction, rejectAction } from "@/app/actions/content";
import type { ActionResult } from "@/lib/action-result";

export interface ApprovalItem {
  id: string;
  title: string;
  brandName: string;
  productTitle: string | null;
  hook: string;
  cta: string;
  qaScore: number | null;
  qaFindings: { severity: string; message: string; platform?: string }[];
  tier: string | null;
  tierReason: string | null;
  costUsd: string;
  duration: string;
  videoAssetId: string | null;
  coverAssetId: string | null;
  aiGenerated: boolean;
  regenerationCount: number;
  scenes: { id: string; label: string }[];
  variants: {
    id: string;
    platform: string;
    caption: string;
    disclosure: string | null;
    link: string | null;
    firstComment: string | null;
  }[];
}

const REASONS: [string, string][] = [
  ["WEAK_HOOK", "Weak hook"],
  ["BAD_IMAGE", "Bad image"],
  ["BAD_VIDEO", "Bad video"],
  ["INCORRECT_PRODUCT", "Incorrect product"],
  ["BAD_VOICE", "Bad voice"],
  ["BAD_CTA", "Bad CTA"],
  ["FACTUAL_PROBLEM", "Factual problem"],
  ["OTHER", "Other"],
];

const SCOPES: [string, string, string][] = [
  ["HOOK", "Hook only", "new hook + captions, everything else reused"],
  ["CAPTION", "Captions only", "platform captions, video unchanged"],
  ["SCRIPT", "Script", "new script; unchanged images are reused"],
  ["IMAGE", "One image", "regenerate a single scene image"],
  ["VIDEO_SCENE", "One AI shot", "regenerate a single AI video scene"],
  ["VOICE", "Voice-over", "new voice take"],
  ["ENTIRE", "Entire content", "start over from research"],
];

type Panel = null | "reject" | "regenerate" | "edit" | "platforms";

const PLATFORM_LABEL: Record<string, string> = {
  TIKTOK: "TikTok",
  INSTAGRAM: "Instagram",
  FACEBOOK: "Facebook",
};

export function ApprovalCard({ item }: { item: ApprovalItem }) {
  const [panel, setPanel] = useState<Panel>(null);
  const [tab, setTab] = useState(item.variants[0]?.id ?? "");
  const [result, setResult] = useState<ActionResult | null>(null);
  const [pending, startTransition] = useTransition();
  const [reasons, setReasons] = useState<string[]>([]);
  const [note, setNote] = useState("");
  const [scope, setScope] = useState("HOOK");
  const [sceneId, setSceneId] = useState(item.scenes[0]?.id ?? "");
  const [hook, setHook] = useState(item.hook);
  const [cta, setCta] = useState(item.cta);
  const [captions, setCaptions] = useState<Record<string, string>>(
    Object.fromEntries(item.variants.map((v) => [v.id, v.caption])),
  );
  const [selected, setSelected] = useState<string[]>(item.variants.map((v) => v.id));
  const done = result?.ok === true;

  const run = (fn: () => Promise<ActionResult>) =>
    startTransition(async () => {
      const r = await fn();
      setResult(r);
      if (r.ok) setPanel(null);
    });

  const active = item.variants.find((v) => v.id === tab);

  return (
    <article id={item.id} className={`card overflow-hidden ${done ? "opacity-60" : ""}`} aria-busy={pending}>
      <div className="grid gap-0 md:grid-cols-[minmax(0,300px)_1fr]">
        <div className="bg-black">
          {item.videoAssetId ? (
            <video
              className="mx-auto aspect-[9/16] max-h-[70vh] w-full object-contain"
              src={`/api/assets/${item.videoAssetId}`}
              poster={item.coverAssetId ? `/api/assets/${item.coverAssetId}` : undefined}
              controls
              playsInline
              preload="metadata"
            />
          ) : (
            <div className="flex aspect-[9/16] items-center justify-center text-sm text-zinc-400">
              No video
            </div>
          )}
        </div>
        <div className="min-w-0 space-y-3 p-4">
          <div>
            <div className="flex flex-wrap items-center gap-1.5 text-xs">
              <span className="rounded-full bg-zinc-100 px-2 py-0.5 font-semibold text-zinc-700">
                {item.brandName}
              </span>
              <span
                className={`rounded-full px-2 py-0.5 font-semibold ${item.qaScore !== null && item.qaScore >= 85 ? "bg-emerald-100 text-emerald-800" : "bg-amber-100 text-amber-900"}`}
              >
                QA {item.qaScore ?? "—"}/100
              </span>
              {item.tier ? (
                <span
                  className="rounded-full bg-indigo-100 px-2 py-0.5 font-semibold text-indigo-800"
                  title={item.tierReason ?? undefined}
                >
                  {item.tier.replace("_", " ")}
                </span>
              ) : null}
              <span className="rounded-full bg-zinc-100 px-2 py-0.5 font-semibold text-zinc-700">
                cost {item.costUsd}
              </span>
              <span className="rounded-full bg-zinc-100 px-2 py-0.5 font-semibold text-zinc-700">
                {item.duration}
              </span>
              {item.aiGenerated ? (
                <span className="rounded-full bg-violet-100 px-2 py-0.5 font-semibold text-violet-800">
                  AI label
                </span>
              ) : null}
              {item.regenerationCount ? (
                <span className="rounded-full bg-zinc-100 px-2 py-0.5 text-zinc-600">
                  regenerated ×{item.regenerationCount}
                </span>
              ) : null}
            </div>
            <h2 className="mt-2 text-lg leading-snug font-bold">{item.title}</h2>
            {item.productTitle ? <p className="text-xs text-zinc-500">{item.productTitle}</p> : null}
          </div>

          <div className="rounded-lg bg-zinc-50 px-3 py-2 text-sm">
            <span className="text-xs font-semibold text-zinc-500 uppercase">Hook</span>
            <p className="font-semibold">{item.hook.replace(/\*/g, "")}</p>
          </div>

          {item.qaFindings.length ? (
            <ul className="space-y-1 text-xs">
              {item.qaFindings.map((f, i) => (
                <li key={i} className="flex gap-2">
                  <span
                    className={`shrink-0 rounded px-1.5 font-semibold ${f.severity === "major" ? "bg-amber-100 text-amber-900" : "bg-zinc-100 text-zinc-600"}`}
                  >
                    {f.severity}
                  </span>
                  <span className="text-zinc-600">
                    {f.platform ? `[${PLATFORM_LABEL[f.platform] ?? f.platform}] ` : ""}
                    {f.message}
                  </span>
                </li>
              ))}
            </ul>
          ) : null}

          {item.variants.length ? (
            <div>
              <div className="flex gap-1 overflow-x-auto" role="tablist" aria-label="Platform captions">
                {item.variants.map((v) => (
                  <button
                    key={v.id}
                    type="button"
                    role="tab"
                    aria-selected={tab === v.id}
                    onClick={() => setTab(v.id)}
                    className={`rounded-t-lg px-3 py-1.5 text-xs font-semibold ${tab === v.id ? "bg-zinc-900 text-white" : "bg-zinc-100 text-zinc-600"}`}
                  >
                    {PLATFORM_LABEL[v.platform] ?? v.platform}
                  </button>
                ))}
              </div>
              {active ? (
                <div
                  role="tabpanel"
                  className="rounded-b-lg rounded-tr-lg border border-zinc-200 p-3 text-sm"
                >
                  <p className="max-h-48 overflow-y-auto whitespace-pre-wrap break-words">{active.caption}</p>
                  {active.firstComment ? (
                    <p className="mt-2 text-xs text-zinc-500">First comment: {active.firstComment}</p>
                  ) : null}
                  <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-xs text-zinc-500">
                    {active.disclosure ? <span>Disclosure: {active.disclosure}</span> : null}
                    {active.link ? <span className="break-all">Link: {active.link}</span> : null}
                  </div>
                </div>
              ) : null}
            </div>
          ) : (
            <p className="rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-900">
              No platform variant passed QA.
            </p>
          )}

          {result ? (
            <p
              role="status"
              className={`rounded-lg px-3 py-2 text-sm ${result.ok ? "bg-emerald-50 text-emerald-800" : "bg-rose-50 text-rose-800"}`}
            >
              {result.message}
            </p>
          ) : null}

          {!done ? (
            <div className="grid grid-cols-2 gap-2 sm:flex sm:flex-wrap">
              <button
                type="button"
                className="btn-success col-span-2 min-h-12 text-base sm:min-h-10 sm:text-sm"
                disabled={pending || item.variants.length === 0}
                onClick={() => run(() => approveAction({ projectId: item.id }))}
              >
                ✓ Approve all {item.variants.length > 1 ? `(${item.variants.length})` : ""}
              </button>
              <button
                type="button"
                className="btn-secondary"
                disabled={pending}
                onClick={() => setPanel(panel === "reject" ? null : "reject")}
                aria-expanded={panel === "reject"}
              >
                ✕ Reject
              </button>
              <button
                type="button"
                className="btn-secondary"
                disabled={pending}
                onClick={() => setPanel(panel === "regenerate" ? null : "regenerate")}
                aria-expanded={panel === "regenerate"}
              >
                ↻ Regenerate
              </button>
              <button
                type="button"
                className="btn-ghost"
                disabled={pending}
                onClick={() => setPanel(panel === "edit" ? null : "edit")}
                aria-expanded={panel === "edit"}
              >
                ✎ Edit text
              </button>
              {item.variants.length > 1 ? (
                <button
                  type="button"
                  className="btn-ghost"
                  disabled={pending}
                  onClick={() => setPanel(panel === "platforms" ? null : "platforms")}
                  aria-expanded={panel === "platforms"}
                >
                  Choose platforms
                </button>
              ) : null}
            </div>
          ) : null}

          {panel === "platforms" ? (
            <fieldset className="space-y-2 rounded-lg border border-zinc-200 p-3">
              <legend className="px-1 text-xs font-semibold text-zinc-500">Approve only</legend>
              {item.variants.map((v) => (
                <label key={v.id} className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={selected.includes(v.id)}
                    onChange={(e) =>
                      setSelected((s) => (e.target.checked ? [...s, v.id] : s.filter((x) => x !== v.id)))
                    }
                    className="size-4"
                  />
                  {PLATFORM_LABEL[v.platform] ?? v.platform}
                </label>
              ))}
              <button
                type="button"
                className="btn-success"
                disabled={pending || selected.length === 0}
                onClick={() => run(() => approveAction({ projectId: item.id, variantIds: selected }))}
              >
                Approve {selected.length} platform(s)
              </button>
            </fieldset>
          ) : null}

          {panel === "reject" ? (
            <fieldset className="space-y-3 rounded-lg border border-zinc-200 p-3">
              <legend className="px-1 text-xs font-semibold text-zinc-500">
                Why? (helps the next generation)
              </legend>
              <div className="flex flex-wrap gap-2">
                {REASONS.map(([value, label]) => {
                  const on = reasons.includes(value);
                  return (
                    <button
                      key={value}
                      type="button"
                      aria-pressed={on}
                      onClick={() => setReasons((r) => (on ? r.filter((x) => x !== value) : [...r, value]))}
                      className={`rounded-full px-3 py-1.5 text-xs font-semibold ${on ? "bg-rose-600 text-white" : "bg-zinc-100 text-zinc-700"}`}
                    >
                      {label}
                    </button>
                  );
                })}
              </div>
              <textarea
                value={note}
                onChange={(e) => setNote(e.target.value)}
                rows={2}
                maxLength={2000}
                placeholder="Optional note"
                className="input"
                aria-label="Rejection note"
              />
              <button
                type="button"
                className="btn-danger"
                disabled={pending || reasons.length === 0}
                onClick={() =>
                  run(() => rejectAction({ projectId: item.id, reasons, ...(note ? { note } : {}) }))
                }
              >
                Reject
              </button>
            </fieldset>
          ) : null}

          {panel === "regenerate" ? (
            <fieldset className="space-y-3 rounded-lg border border-zinc-200 p-3">
              <legend className="px-1 text-xs font-semibold text-zinc-500">
                Regenerate only what is wrong
              </legend>
              <div className="grid gap-2 sm:grid-cols-2">
                {SCOPES.map(([value, label, hint]) => (
                  <label
                    key={value}
                    className={`flex cursor-pointer gap-2 rounded-lg border p-2 text-sm ${scope === value ? "border-brand-500 bg-brand-50" : "border-zinc-200"}`}
                  >
                    <input
                      type="radio"
                      name={`scope-${item.id}`}
                      value={value}
                      checked={scope === value}
                      onChange={() => setScope(value)}
                      className="mt-1"
                    />
                    <span>
                      <span className="block font-semibold">{label}</span>
                      <span className="text-xs text-zinc-500">{hint}</span>
                    </span>
                  </label>
                ))}
              </div>
              {scope === "IMAGE" || scope === "VIDEO_SCENE" ? (
                <select
                  value={sceneId}
                  onChange={(e) => setSceneId(e.target.value)}
                  className="input"
                  aria-label="Scene"
                >
                  {item.scenes.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.label}
                    </option>
                  ))}
                </select>
              ) : null}
              <textarea
                value={note}
                onChange={(e) => setNote(e.target.value)}
                rows={2}
                maxLength={2000}
                placeholder="What should change? (fed to the generator)"
                className="input"
                aria-label="Regeneration note"
              />
              <button
                type="button"
                className="btn-primary"
                disabled={pending}
                onClick={() =>
                  run(() =>
                    regenerateAction({
                      projectId: item.id,
                      scope,
                      ...(scope === "IMAGE" || scope === "VIDEO_SCENE" ? { sceneId } : {}),
                      ...(note ? { note } : {}),
                    }),
                  )
                }
              >
                Regenerate
              </button>
            </fieldset>
          ) : null}

          {panel === "edit" ? (
            <fieldset className="space-y-3 rounded-lg border border-zinc-200 p-3">
              <legend className="px-1 text-xs font-semibold text-zinc-500">
                Edit text (wrap words in *asterisks* to highlight)
              </legend>
              <label className="block">
                <span className="label">Hook (on screen)</span>
                <input
                  value={hook}
                  onChange={(e) => setHook(e.target.value)}
                  maxLength={140}
                  className="input"
                />
              </label>
              <label className="block">
                <span className="label">CTA (on screen)</span>
                <input
                  value={cta}
                  onChange={(e) => setCta(e.target.value)}
                  maxLength={90}
                  className="input"
                />
              </label>
              {item.variants.map((v) => (
                <label key={v.id} className="block">
                  <span className="label">{PLATFORM_LABEL[v.platform] ?? v.platform} caption</span>
                  <textarea
                    value={captions[v.id] ?? ""}
                    onChange={(e) => setCaptions((c) => ({ ...c, [v.id]: e.target.value }))}
                    rows={5}
                    maxLength={2200}
                    className="input font-mono text-xs"
                  />
                </label>
              ))}
              <button
                type="button"
                className="btn-primary"
                disabled={pending}
                onClick={() => {
                  const changedCaptions = Object.fromEntries(
                    Object.entries(captions).filter(
                      ([id, text]) => item.variants.find((v) => v.id === id)?.caption !== text,
                    ),
                  );
                  run(() =>
                    editTextAction({
                      projectId: item.id,
                      ...(hook !== item.hook ? { hook } : {}),
                      ...(cta !== item.cta ? { cta } : {}),
                      ...(Object.keys(changedCaptions).length ? { variantCaptions: changedCaptions } : {}),
                    }),
                  );
                }}
              >
                Save edits
              </button>
            </fieldset>
          ) : null}
        </div>
      </div>
    </article>
  );
}
