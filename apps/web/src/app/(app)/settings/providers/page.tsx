import type { Metadata } from "next";
import { resolveModelCatalog, resolveProviderSelection } from "@cre/config";
import { maskSecret } from "@cre/shared";
import { disconnectAccountAction, testProvidersAction } from "@/app/actions/settings";
import { ActionButton } from "@/components/action-button";
import { Badge, Card, Dl, PageHeader, StatusBadge, Table } from "@/components/ui";
import { requireUser } from "@/lib/auth";
import { db, env } from "@/lib/db";
import { date } from "@/lib/format";

export const metadata: Metadata = { title: "Settings · providers" };

const MESSAGES: Record<string, string> = {
  meta_not_configured: "Set META_APP_ID and META_APP_SECRET in the server environment first.",
  tiktok_not_configured: "Set TIKTOK_CLIENT_KEY and TIKTOK_CLIENT_SECRET in the server environment first.",
  invalid_oauth_state: "The connection attempt expired or was tampered with — start again.",
  no_facebook_page:
    "No Facebook Page was granted. Pages (and their linked Instagram professional accounts) are required.",
  oauth_exchange_failed: "The platform rejected the authorization code — see the server log.",
  no_instagram_account: "Connected the Facebook Page, but it has no linked Instagram professional account.",
};

export default async function ProvidersPage({
  searchParams,
}: {
  searchParams: Promise<{ connected?: string; error?: string; warning?: string }>;
}) {
  const user = await requireUser();
  const sp = await searchParams;
  const e = env();
  const sel = resolveProviderSelection(e);
  const models = resolveModelCatalog(e, sel);
  const prisma = db();
  const [brands, credentials] = await Promise.all([
    prisma.brand.findMany({
      where: { workspaceId: user.workspaceId },
      orderBy: { name: "asc" },
      include: { socialAccounts: { orderBy: { platform: "asc" } } },
    }),
    prisma.providerCredential.findMany({
      where: { workspaceId: user.workspaceId },
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        provider: true,
        label: true,
        status: true,
        expiresAt: true,
        scopes: true,
        lastError: true,
        createdAt: true,
      },
    }),
  ]);
  const admin = user.role === "OWNER" || user.role === "ADMIN";
  const key = (v: string | undefined) =>
    v ? <Badge tone="green">set {maskSecret(v)}</Badge> : <Badge tone="gray">not set</Badge>;

  return (
    <>
      <PageHeader
        title="Providers & connections"
        subtitle="API keys live in the server environment only. OAuth tokens are encrypted at rest (AES-256-GCM) and never sent to the browser."
        actions={
          admin ? (
            <ActionButton action={testProvidersAction} label="Run health checks" pendingLabel="Checking…" />
          ) : null
        }
      />
      {sp.connected ? (
        <p className="mb-4 rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-800">
          Connected {sp.connected === "meta" ? "Meta (Facebook Page + Instagram)" : "TikTok"}.
        </p>
      ) : null}
      {sp.error ? (
        <p className="mb-4 rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-800">
          {MESSAGES[sp.error] ?? `Connection failed: ${sp.error}`}
        </p>
      ) : null}
      {sp.warning ? (
        <p className="mb-4 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-900">
          {MESSAGES[sp.warning] ?? sp.warning}
        </p>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Safety switches">
          <Dl
            items={[
              [
                "Mock AI",
                e.MOCK_AI ? (
                  <Badge tone="violet">on — no LLM spend</Badge>
                ) : (
                  <Badge tone="amber">off — real LLM calls</Badge>
                ),
              ],
              [
                "Mock media",
                e.MOCK_MEDIA ? (
                  <Badge tone="violet">on — no image/video/TTS spend</Badge>
                ) : (
                  <Badge tone="amber">off — real media generation</Badge>
                ),
              ],
              [
                "Mock social",
                e.MOCK_SOCIAL ? (
                  <Badge tone="violet">on — nothing leaves the machine</Badge>
                ) : (
                  <Badge tone="amber">off — real platform APIs</Badge>
                ),
              ],
              [
                "Publishing",
                e.PUBLISHING_ENABLED ? (
                  <Badge tone="red">ENABLED — approved posts go public</Badge>
                ) : (
                  <Badge tone="green">kill switch on — nothing is posted</Badge>
                ),
              ],
              ["Hard daily cap (real money)", `$${e.HARD_DAILY_BUDGET_USD.toFixed(2)}`],
              ["Mock cost mode", sel.mock.costMode],
              ["App URL (tracking links)", e.APP_URL],
            ]}
          />
          <p className="mt-3 text-xs text-zinc-500">
            These are environment settings (restart required). They are deliberately not editable from the
            browser.
          </p>
        </Card>

        <Card title="Generation providers">
          <Table
            head={
              <>
                <th className="th">Capability</th>
                <th className="th">Provider</th>
                <th className="th">Model(s)</th>
              </>
            }
          >
            <tr>
              <td className="td">LLM</td>
              <td className="td">{sel.llm}</td>
              <td className="td text-xs">{models.llm.default}</td>
            </tr>
            <tr>
              <td className="td">Images</td>
              <td className="td">{sel.image}</td>
              <td className="td text-xs">
                {Object.entries(models.image)
                  .map(([k, v]) => `${k}: ${v}`)
                  .join(" · ")}
              </td>
            </tr>
            <tr>
              <td className="td">AI video</td>
              <td className="td">{sel.video}</td>
              <td className="td text-xs">
                {Object.entries(models.video)
                  .map(([k, v]) => `${k}: ${v}`)
                  .join(" · ")}
              </td>
            </tr>
            <tr>
              <td className="td">Background removal</td>
              <td className="td">{sel.bgRemoval}</td>
              <td className="td text-xs">{models.bgRemoval}</td>
            </tr>
            <tr>
              <td className="td">Voice-over</td>
              <td className="td">{sel.tts}</td>
              <td className="td text-xs">{models.tts}</td>
            </tr>
            <tr>
              <td className="td">Storage</td>
              <td className="td">{sel.storage}</td>
              <td className="td text-xs">
                {sel.storage === "s3" ? (e.S3_BUCKET ?? "—") : e.STORAGE_LOCAL_DIR}
              </td>
            </tr>
          </Table>
        </Card>

        <Card title="Server-side keys">
          <Dl
            items={[
              ["DEEPSEEK_API_KEY", key(e.DEEPSEEK_API_KEY)],
              ["OPENAI_API_KEY", key(e.OPENAI_API_KEY)],
              ["FAL_KEY", key(e.FAL_KEY)],
              ["ELEVENLABS_API_KEY", key(e.ELEVENLABS_API_KEY)],
              [
                "META_APP_ID / SECRET",
                <span key="m">
                  {key(e.META_APP_ID)} {key(e.META_APP_SECRET)}
                </span>,
              ],
              [
                "TIKTOK_CLIENT_KEY / SECRET",
                <span key="t">
                  {key(e.TIKTOK_CLIENT_KEY)} {key(e.TIKTOK_CLIENT_SECRET)}
                </span>,
              ],
              ["S3 access key", key(e.S3_ACCESS_KEY_ID)],
              ["CREDENTIALS_ENCRYPTION_KEY", key(e.CREDENTIALS_ENCRYPTION_KEY)],
              ["TRACKING_HASH_SECRET", key(e.TRACKING_HASH_SECRET)],
            ]}
          />
        </Card>

        <Card title="Stored credentials (encrypted)">
          {credentials.length === 0 ? (
            <p className="text-sm text-zinc-500">No OAuth tokens stored.</p>
          ) : (
            <ul className="space-y-2 text-sm">
              {credentials.map((c) => (
                <li key={c.id} className="flex flex-wrap items-center gap-2">
                  <strong>{c.label}</strong>
                  <Badge tone={c.status === "ACTIVE" ? "green" : "red"}>{c.status.toLowerCase()}</Badge>
                  <span className="text-xs text-zinc-500">
                    {c.provider} · expires {date(c.expiresAt, user.timezone)} · added{" "}
                    {date(c.createdAt, user.timezone)}
                  </span>
                  {c.lastError ? <span className="text-xs text-rose-700">{c.lastError}</span> : null}
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>

      <Card title="Social accounts" className="mt-4">
        <p className="mb-3 text-xs text-zinc-500">
          Official APIs only: Instagram Graph API (professional accounts via a Facebook Page), Facebook Pages
          API, TikTok Content Posting API. Unaudited TikTok apps can only post privately — see
          docs/SOCIAL_APIS.md.
        </p>
        <div className="space-y-4">
          {brands.map((b) => (
            <div key={b.id}>
              <div className="mb-2 flex flex-wrap items-center gap-2">
                <h3 className="text-sm font-semibold">{b.name}</h3>
                {admin ? (
                  <>
                    <a
                      href={`/api/oauth/meta/start?brandId=${b.id}`}
                      className={`btn-secondary min-h-8 px-3 text-xs ${e.META_APP_ID ? "" : "pointer-events-none opacity-50"}`}
                      aria-disabled={!e.META_APP_ID}
                    >
                      Connect Instagram + Facebook
                    </a>
                    <a
                      href={`/api/oauth/tiktok/start?brandId=${b.id}`}
                      className={`btn-secondary min-h-8 px-3 text-xs ${e.TIKTOK_CLIENT_KEY ? "" : "pointer-events-none opacity-50"}`}
                      aria-disabled={!e.TIKTOK_CLIENT_KEY}
                    >
                      Connect TikTok
                    </a>
                  </>
                ) : null}
              </div>
              <ul className="space-y-1 text-sm">
                {b.socialAccounts.map((a) => (
                  <li key={a.id} className="flex flex-wrap items-center gap-2">
                    <Badge tone="indigo">{a.platform.toLowerCase()}</Badge>
                    <span>{a.handle}</span>
                    <StatusBadge status={a.status} />
                    {admin && a.status !== "DISCONNECTED" && !a.isMock ? (
                      <ActionButton
                        action={disconnectAccountAction.bind(null, { accountId: a.id })}
                        label="Disconnect"
                        confirm="Disconnect this account? Its tokens are deleted."
                        className="btn-ghost min-h-7 px-2 text-xs"
                      />
                    ) : null}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      </Card>
    </>
  );
}
