import { db, env } from "@/lib/db";

/** Liveness + database check for uptime monitors (no secrets, no counts). */
export async function GET() {
  const e = env();
  let database = "ok";
  try {
    await db().$queryRaw`SELECT 1`;
  } catch {
    database = "error";
  }
  return Response.json(
    {
      ok: database === "ok",
      database,
      mock: { ai: e.MOCK_AI, media: e.MOCK_MEDIA, social: e.MOCK_SOCIAL },
      publishingEnabled: e.PUBLISHING_ENABLED,
      time: new Date().toISOString(),
    },
    { status: database === "ok" ? 200 : 503, headers: { "Cache-Control": "no-store" } },
  );
}
