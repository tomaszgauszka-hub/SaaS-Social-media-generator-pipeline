import type { NextRequest } from "next/server";
import { parseFxRates } from "@cre/config";
import { mapWebhookPayload, recordConversion } from "@cre/core";
import { errorMessage, safeEqual, sha256Hex } from "@cre/shared";
import { db, env } from "@/lib/db";
import { rateLimit } from "@/lib/rate-limit";

const MAX_BODY = 64 * 1024;

/**
 * Affiliate-network postback (S2S) endpoint: GET (query string) or POST (JSON / form). Authenticated with the
 * per-program token (only its SHA-256 is stored). Idempotent per (program, external order id).
 */
async function handle(request: NextRequest, programId: string): Promise<Response> {
  const program = await db().affiliateProgram.findUnique({ where: { id: programId } });
  if (!program || !program.isActive || !program.postbackSecretHash)
    return Response.json({ error: "not found" }, { status: 404 });
  const token = request.headers.get("x-postback-token") ?? request.nextUrl.searchParams.get("token") ?? "";
  if (!token || !safeEqual(sha256Hex(token), program.postbackSecretHash))
    return Response.json({ error: "unauthorized" }, { status: 401 });
  if (!rateLimit(`postback:${program.id}`, 600, 60_000).ok)
    return Response.json({ error: "rate limited" }, { status: 429 });

  let payload: Record<string, unknown> = Object.fromEntries(
    [...request.nextUrl.searchParams.entries()].filter(([k]) => k !== "token"),
  );
  if (request.method === "POST") {
    const length = Number(request.headers.get("content-length") ?? 0);
    if (length > MAX_BODY) return Response.json({ error: "payload too large" }, { status: 413 });
    const text = (await request.text()).slice(0, MAX_BODY);
    const type = request.headers.get("content-type") ?? "";
    try {
      payload = {
        ...payload,
        ...(type.includes("json")
          ? (JSON.parse(text) as Record<string, unknown>)
          : Object.fromEntries(new URLSearchParams(text))),
      };
    } catch {
      return Response.json({ error: "invalid body" }, { status: 400 });
    }
  }
  const mapped = mapWebhookPayload(
    payload,
    (program.conversionFieldMap ?? null) as Record<string, string> | null,
  );
  const fx = mapped.currency === "USD" ? 1 : parseFxRates(env().FX_RATES_USD)[mapped.currency];
  if (fx === undefined)
    return Response.json({ error: `no FX rate configured for ${mapped.currency}` }, { status: 422 });
  try {
    const res = await recordConversion(db(), {
      workspaceId: program.workspaceId,
      source: "webhook",
      affiliateProgramId: program.id,
      externalId: mapped.externalId ?? null,
      clickId: mapped.clickId ?? null,
      linkCode: mapped.linkCode ?? null,
      type: mapped.type,
      status: mapped.status,
      occurredAt: mapped.occurredAt,
      commissionMicros: mapped.commission,
      orderValueMicros: mapped.orderValue,
      currency: mapped.currency,
      fxRateToUsd: fx,
      raw: payload,
    });
    return Response.json({ ok: true, created: res.created, attributed: Boolean(res.attribution.projectId) });
  } catch (err) {
    console.error("postback failed", errorMessage(err));
    return Response.json({ error: "could not record conversion" }, { status: 500 });
  }
}

export async function GET(request: NextRequest, { params }: { params: Promise<{ programId: string }> }) {
  return handle(request, (await params).programId);
}

export async function POST(request: NextRequest, { params }: { params: Promise<{ programId: string }> }) {
  return handle(request, (await params).programId);
}
