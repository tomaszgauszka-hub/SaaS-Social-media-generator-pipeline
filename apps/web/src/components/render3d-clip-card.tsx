"use client";

import { useRef, useState, useTransition } from "react";
import { approveClip3dAction, regenerateClip3dAction, rejectClip3dAction } from "@/app/actions/render3d";
import { Badge } from "@/components/ui";
import type { ActionResult } from "@/lib/action-result";
import { APPROVAL_LABEL, fidelityBadge, materialLabel, templateLabel } from "@/lib/render3d-labels";

export interface ClipView {
  assetId: string;
  materialType: string | null;
  template: string | null;
  quality: string | null;
  engine: string;
  engineVersion: string | null;
  fidelity: string;
  isDemoOnly: boolean;
  isProductVerified: boolean;
  license: string;
  licenseEvidence: string;
  source: string;
  productModelId: string | null;
  renderTime: string;
  cost: string;
  qaScore: number | null;
  qaPassed: boolean | null;
  qaNote: string | null;
  failedChecks: { id: string; severity: string; message: string }[];
  approval: { status: string; by: string | null; at: string | null; note: string | null };
  files: {
    video: boolean;
    thumbnail: boolean;
    controlSheet: boolean;
    alphaVideo: boolean;
    metadata: boolean;
  };
  /** [width, height] */
  resolution: [number, number] | null;
  length: string;
  fps: number | null;
  created: string;
  device: string | null;
  host: string | null;
  recipeHash: string | null;
  /** a storyboard MediaRef.render3d value (packages/creative Render3DRef) */
  storyboardRef: string;
}

type Panel = null | "reject" | "use";

const fileUrl = (id: string, role: string) => `/api/render3d/${encodeURIComponent(id)}/${role}`;

export function Clip3DCard({ clip }: { clip: ClipView }) {
  const [panel, setPanel] = useState<Panel>(null);
  const [note, setNote] = useState("");
  const [result, setResult] = useState<ActionResult | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const idField = useRef<HTMLInputElement>(null);

  const run = (fn: () => Promise<ActionResult>) =>
    start(async () => {
      const r = await fn();
      setResult(r);
      if (r.ok) setPanel(null);
    });

  const copy = async (value: string, what: string, field?: HTMLInputElement | null) => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(what);
    } catch {
      // clipboard blocked (http / old browser): select the text so a long-press / Ctrl+C copies it
      field?.select();
      setCopied(null);
    }
  };

  const fid = fidelityBadge(clip.fidelity, clip.isDemoOnly);
  const approval = APPROVAL_LABEL[clip.approval.status] ?? { label: clip.approval.status, tone: "gray" };
  const [w, h] = clip.resolution ?? [1080, 1920];
  const toggle = (p: Panel) => setPanel(panel === p ? null : p);

  return (
    <article
      id={clip.assetId}
      className={`card flex scroll-mt-20 flex-col overflow-hidden ${clip.approval.status === "REJECTED" ? "opacity-70" : ""}`}
      aria-busy={pending}
    >
      <div className="bg-black">
        {clip.files.video ? (
          <video
            className="mx-auto max-h-[60vh] w-full object-contain"
            style={{ aspectRatio: `${w} / ${h}` }}
            src={fileUrl(clip.assetId, "video")}
            poster={clip.files.thumbnail ? fileUrl(clip.assetId, "thumbnail") : undefined}
            controls
            playsInline
            muted
            preload="metadata"
          />
        ) : clip.files.thumbnail ? (
          <img
            src={fileUrl(clip.assetId, "thumbnail")}
            alt={`${templateLabel(clip.template)} thumbnail`}
            className="mx-auto max-h-[60vh] w-full object-contain"
          />
        ) : (
          <div className="flex aspect-[9/16] max-h-[60vh] items-center justify-center text-sm text-zinc-400">
            No video file
          </div>
        )}
      </div>

      <div className="flex min-w-0 flex-1 flex-col gap-3 p-4">
        <div className="flex flex-wrap items-center gap-1.5">
          <Badge tone={fid.tone} title={fid.title}>
            {fid.label}
          </Badge>
          <Badge tone={approval.tone}>{approval.label}</Badge>
          {clip.quality ? (
            <Badge tone={clip.quality === "production" ? "indigo" : "gray"}>{clip.quality}</Badge>
          ) : null}
          {clip.qaScore !== null ? (
            <Badge tone={clip.qaPassed ? "green" : "amber"} title={clip.qaNote ?? undefined}>
              QA {Math.round(clip.qaScore)}/100
            </Badge>
          ) : null}
        </div>

        <div>
          <h3 className="leading-snug font-bold">{templateLabel(clip.template)}</h3>
          <p className="text-xs text-zinc-500">
            {materialLabel(clip.materialType)} · {clip.engine}
            {clip.engineVersion ? ` · ${clip.engineVersion}` : ""}
          </p>
        </div>

        <dl className="grid grid-cols-2 gap-x-3 gap-y-1 text-xs">
          <dt className="text-zinc-500">Render time</dt>
          <dd className="text-right tabular-nums">{clip.renderTime}</dd>
          <dt className="text-zinc-500">Local cost (est.)</dt>
          <dd className="text-right tabular-nums">{clip.cost}</dd>
          <dt className="text-zinc-500">Clip</dt>
          <dd className="text-right tabular-nums">
            {clip.length}
            {clip.resolution ? ` · ${w}×${h}` : ""}
            {clip.fps ? ` · ${clip.fps} fps` : ""}
          </dd>
          <dt className="text-zinc-500">Rendered</dt>
          <dd className="text-right">{clip.created}</dd>
        </dl>

        {clip.failedChecks.length ? (
          <ul className="space-y-1 text-xs" aria-label="Failed QA checks">
            {clip.failedChecks.map((c) => (
              <li key={c.id} className="flex gap-2">
                <span
                  className={`shrink-0 rounded px-1.5 font-semibold ${c.severity === "blocker" ? "bg-rose-100 text-rose-800" : "bg-amber-100 text-amber-900"}`}
                >
                  {c.severity}
                </span>
                <span className="min-w-0 break-words text-zinc-600">{c.message}</span>
              </li>
            ))}
          </ul>
        ) : clip.qaScore !== null ? (
          <p className="text-xs text-emerald-700">
            All technical QA checks passed — aesthetics need your review.
          </p>
        ) : null}

        {clip.approval.status !== "PENDING" && clip.approval.by ? (
          <p className="text-xs text-zinc-500">
            {clip.approval.status === "APPROVED" ? "Approved" : "Rejected"} by {clip.approval.by}
            {clip.approval.at ? ` · ${clip.approval.at}` : ""}
            {clip.approval.note ? <span className="block italic">“{clip.approval.note}”</span> : null}
          </p>
        ) : null}

        {result ? (
          <p
            role="status"
            className={`rounded-lg px-3 py-2 text-sm ${result.ok ? "bg-emerald-50 text-emerald-800" : "bg-rose-50 text-rose-800"}`}
          >
            {result.message}
          </p>
        ) : null}

        <div className="mt-auto grid grid-cols-2 gap-2">
          {clip.approval.status !== "APPROVED" ? (
            <button
              type="button"
              className="btn-success min-h-12 text-base sm:min-h-10 sm:text-sm"
              disabled={pending}
              onClick={() => run(() => approveClip3dAction({ assetId: clip.assetId }))}
            >
              ✓ Approve
            </button>
          ) : null}
          {clip.approval.status !== "REJECTED" ? (
            <button
              type="button"
              className="btn-secondary min-h-12 sm:min-h-10"
              disabled={pending}
              aria-expanded={panel === "reject"}
              onClick={() => toggle("reject")}
            >
              ✕ Reject
            </button>
          ) : null}
          <button
            type="button"
            className="btn-secondary min-h-12 sm:min-h-10"
            disabled={pending}
            onClick={() => run(() => regenerateClip3dAction({ assetId: clip.assetId }))}
          >
            ↻ Regenerate shot
          </button>
          <button
            type="button"
            className="btn-ghost min-h-12 ring-1 ring-zinc-200 sm:min-h-10"
            aria-expanded={panel === "use"}
            onClick={() => toggle("use")}
          >
            Use existing asset
          </button>
        </div>

        {panel === "reject" ? (
          <fieldset className="space-y-2 rounded-lg border border-zinc-200 p-3">
            <legend className="px-1 text-xs font-semibold text-zinc-500">Reject this clip</legend>
            <textarea
              value={note}
              onChange={(e) => setNote(e.target.value)}
              rows={2}
              maxLength={1000}
              placeholder="Optional note (what is wrong?)"
              className="input"
              aria-label="Rejection note"
            />
            <button
              type="button"
              className="btn-danger min-h-11 w-full sm:min-h-10 sm:w-auto"
              disabled={pending}
              onClick={() =>
                run(() => rejectClip3dAction({ assetId: clip.assetId, ...(note.trim() ? { note } : {}) }))
              }
            >
              Reject clip
            </button>
          </fieldset>
        ) : null}

        {panel === "use" ? (
          <fieldset className="space-y-2 rounded-lg border border-zinc-200 p-3">
            <legend className="px-1 text-xs font-semibold text-zinc-500">Use in a storyboard</legend>
            {clip.approval.status !== "APPROVED" ? (
              <p className="text-xs text-amber-800">Not approved yet — approve the clip before using it.</p>
            ) : null}
            {clip.isDemoOnly ? (
              <p className="text-xs text-rose-700">DEMO_ONLY: for demo storyboards only, never published.</p>
            ) : null}
            <label className="block">
              <span className="label">Asset ID</span>
              <span className="flex gap-2">
                <input
                  ref={idField}
                  readOnly
                  value={clip.assetId}
                  onFocus={(e) => e.currentTarget.select()}
                  className="input min-h-11 font-mono text-xs sm:min-h-10"
                />
                <button
                  type="button"
                  className="btn-secondary min-h-11 shrink-0 sm:min-h-10"
                  onClick={() => void copy(clip.assetId, "id", idField.current)}
                >
                  {copied === "id" ? "Copied" : "Copy"}
                </button>
              </span>
            </label>
            <details className="text-xs">
              <summary className="cursor-pointer py-1 text-zinc-600">MediaRef.render3d (JSON)</summary>
              <pre className="mt-1 overflow-x-auto rounded bg-zinc-50 p-2 font-mono text-[11px]">
                {clip.storyboardRef}
              </pre>
              <button
                type="button"
                className="btn-ghost mt-1 min-h-9 px-2 text-xs"
                onClick={() => void copy(clip.storyboardRef, "json")}
              >
                {copied === "json" ? "Copied" : "Copy JSON"}
              </button>
            </details>
          </fieldset>
        ) : null}

        <details className="text-xs">
          <summary className="cursor-pointer py-1 font-semibold text-zinc-600">
            Show source and licence
          </summary>
          <dl className="mt-1 space-y-1.5">
            <div>
              <dt className="text-zinc-500">Licence</dt>
              <dd className="break-words">{clip.license}</dd>
            </div>
            <div>
              <dt className="text-zinc-500">Licence evidence</dt>
              <dd className="break-words">{clip.licenseEvidence}</dd>
            </div>
            <div>
              <dt className="text-zinc-500">Fidelity</dt>
              <dd>
                {fid.title}
                {clip.isProductVerified ? " · product verified by the owner" : ""}
              </dd>
            </div>
            <div>
              <dt className="text-zinc-500">Product model</dt>
              <dd className="font-mono break-all">{clip.productModelId ?? "—"}</dd>
            </div>
            <div>
              <dt className="text-zinc-500">Source</dt>
              <dd className="font-mono break-all">{clip.source}</dd>
            </div>
            {clip.device || clip.host ? (
              <div>
                <dt className="text-zinc-500">Rendered on</dt>
                <dd className="break-words">{[clip.device, clip.host].filter(Boolean).join(" · ")}</dd>
              </div>
            ) : null}
            <div>
              <dt className="text-zinc-500">Asset ID</dt>
              <dd className="font-mono break-all">{clip.assetId}</dd>
            </div>
          </dl>
          <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1">
            {clip.files.controlSheet ? (
              <a
                href={fileUrl(clip.assetId, "control_sheet")}
                target="_blank"
                rel="noreferrer"
                className="underline"
              >
                Control sheet
              </a>
            ) : null}
            {clip.files.alphaVideo ? (
              <a
                href={fileUrl(clip.assetId, "alpha_video")}
                target="_blank"
                rel="noreferrer"
                className="underline"
              >
                Alpha video
              </a>
            ) : null}
            {clip.files.metadata ? (
              <a
                href={fileUrl(clip.assetId, "metadata")}
                target="_blank"
                rel="noreferrer"
                className="underline"
              >
                Render metadata (JSON)
              </a>
            ) : null}
          </div>
        </details>
      </div>
    </article>
  );
}
