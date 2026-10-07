import type { Brand } from "@cre/db";

/** Shared brand settings fields (server component; used inside an ActionForm). */
export function BrandFields({ brand }: { brand?: Brand }) {
  const colors = (brand?.colors ?? {
    primary: "#4F46E5",
    secondary: "#E0E7FF",
    accent: "#10B981",
    text: "#FFFFFF",
    background: "#0B0B0F",
  }) as Record<string, string>;
  const platforms = brand?.targetPlatforms ?? ["TIKTOK", "INSTAGRAM", "FACEBOOK"];
  const field = "block";
  return (
    <div className="grid gap-4 md:grid-cols-2">
      <label className={field}>
        <span className="label">Name</span>
        <input name="name" required defaultValue={brand?.name} className="input" maxLength={80} />
      </label>
      <label className={field}>
        <span className="label">Niche</span>
        <input name="niche" required defaultValue={brand?.niche} className="input" maxLength={120} />
      </label>
      <label className={`${field} md:col-span-2`}>
        <span className="label">Target audience</span>
        <input
          name="targetAudience"
          required
          defaultValue={brand?.targetAudience}
          className="input"
          maxLength={500}
        />
      </label>
      <label className={`${field} md:col-span-2`}>
        <span className="label">Tone of voice</span>
        <input
          name="toneOfVoice"
          required
          defaultValue={brand?.toneOfVoice}
          className="input"
          maxLength={500}
        />
      </label>
      <label className={field}>
        <span className="label">Language</span>
        <input name="language" defaultValue={brand?.language ?? "en"} className="input" maxLength={5} />
      </label>
      <label className={field}>
        <span className="label">Time zone (posting slots)</span>
        <input
          name="timezone"
          defaultValue={brand?.timezone ?? "UTC"}
          className="input"
          placeholder="Europe/Warsaw"
        />
      </label>
      <label className={field}>
        <span className="label">Countries (ISO, comma separated)</span>
        <input
          name="countries"
          defaultValue={brand?.countries.join(", ")}
          className="input"
          placeholder="US, CA"
        />
      </label>
      <label className={field}>
        <span className="label">Status</span>
        <select
          name="status"
          defaultValue={brand?.status === "PAUSED" ? "PAUSED" : "ACTIVE"}
          className="input"
        >
          <option value="ACTIVE">Active</option>
          <option value="PAUSED">Paused (no new content)</option>
        </select>
      </label>
      <fieldset className="md:col-span-2">
        <legend className="label">Target platforms</legend>
        <div className="flex flex-wrap gap-4 text-sm">
          {["TIKTOK", "INSTAGRAM", "FACEBOOK"].map((p) => (
            <label key={p} className="flex items-center gap-2">
              <input
                type="checkbox"
                name="targetPlatforms"
                value={p}
                defaultChecked={platforms.includes(p as never)}
                className="size-4"
              />
              {p.charAt(0) + p.slice(1).toLowerCase()}
            </label>
          ))}
        </div>
      </fieldset>
      <label className={`${field} md:col-span-2`}>
        <span className="label">CTA styles (one per line)</span>
        <textarea name="ctaStyles" rows={2} defaultValue={brand?.ctaStyles.join("\n")} className="input" />
      </label>
      <label className={`${field} md:col-span-2`}>
        <span className="label">Content rules (one per line — fed to every prompt)</span>
        <textarea
          name="contentRules"
          rows={3}
          defaultValue={brand?.contentRules.join("\n")}
          className="input"
        />
      </label>
      <label className={field}>
        <span className="label">Banned words (comma separated — QA blocks them)</span>
        <textarea
          name="bannedWords"
          rows={2}
          defaultValue={brand?.bannedWords.join(", ")}
          className="input"
        />
      </label>
      <label className={field}>
        <span className="label">Compliance notes</span>
        <textarea
          name="complianceNotes"
          rows={2}
          defaultValue={brand?.complianceNotes ?? ""}
          className="input"
        />
      </label>
      <label className={field}>
        <span className="label">Production tier ceiling</span>
        <select name="maxTier" defaultValue={brand?.maxTier ?? "TIER_1"} className="input">
          <option value="TIER_0">Tier 0 — programmatic (≈$0.01)</option>
          <option value="TIER_1">Tier 1 — cheap AI images</option>
          <option value="TIER_2">Tier 2 — better images + optional AI shot</option>
          <option value="TIER_3">Tier 3 — premium (proven winners only)</option>
        </select>
      </label>
      <label className={field}>
        <span className="label">Template</span>
        <select
          name="defaultTemplateKey"
          defaultValue={brand?.defaultTemplateKey ?? "vertical-bold"}
          className="input"
        >
          <option value="vertical-bold">Vertical Bold</option>
          <option value="vertical-clean">Vertical Clean</option>
        </select>
      </label>
      <label className={field}>
        <span className="label">QA threshold (0-100)</span>
        <input
          name="qaThreshold"
          type="number"
          min={40}
          max={100}
          defaultValue={brand?.qaThreshold ?? 70}
          className="input"
        />
      </label>
      <label className={field}>
        <span className="label">Ideas per cycle</span>
        <input
          name="ideasPerCycle"
          type="number"
          min={1}
          max={10}
          defaultValue={brand?.ideasPerCycle ?? 2}
          className="input"
        />
      </label>
      <label className={field}>
        <span className="label">TTS voice id (optional)</span>
        <input name="voiceId" defaultValue={brand?.voiceId ?? ""} className="input" />
      </label>
      <div className="flex flex-col gap-2 text-sm md:col-span-2 sm:flex-row sm:flex-wrap sm:gap-6">
        {(
          [
            ["ttsEnabled", "Voice-over (TTS)", brand?.ttsEnabled ?? false],
            [
              "allowAiVideo",
              "Allow AI video shots (only when evidence justifies)",
              brand?.allowAiVideo ?? true,
            ],
            ["autoIdeationEnabled", "Automatic daily ideation", brand?.autoIdeationEnabled ?? false],
            ["experimentsEnabled", "A/B experiments", brand?.experimentsEnabled ?? false],
          ] as const
        ).map(([name, label, checked]) => (
          <label key={name} className="flex items-center gap-2">
            <input type="checkbox" name={name} defaultChecked={checked} className="size-4" />
            {label}
          </label>
        ))}
      </div>
      <fieldset className="md:col-span-2">
        <legend className="label">Brand colours</legend>
        <div className="flex flex-wrap gap-4">
          {["primary", "secondary", "accent", "text", "background"].map((c) => (
            <label key={c} className="flex items-center gap-2 text-sm">
              <input
                type="color"
                name={`color_${c}`}
                defaultValue={colors[c] ?? "#000000"}
                className="h-9 w-12 rounded border border-zinc-300"
              />
              {c}
            </label>
          ))}
        </div>
      </fieldset>
      <label className={`${field} md:col-span-2`}>
        <span className="label">Description</span>
        <textarea name="description" rows={2} defaultValue={brand?.description ?? ""} className="input" />
      </label>
    </div>
  );
}
