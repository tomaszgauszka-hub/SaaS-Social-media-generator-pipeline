import type { NextRequest } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { CLIP_TYPES, parseAsset } from "@/lib/render3d";
import { storage } from "@/lib/storage";
import { streamStorageObject } from "@/lib/stream";

/**
 * Authenticated file streaming for the 3D library (clip video, thumbnail, control sheet, alpha video, metadata).
 * Same auth as /api/assets/[id]: a signed-in user of the clip's workspace. The storage key is always looked up
 * from the Render3DAsset record — the request only names the clip and a whitelisted role.
 */
const ROLES = new Set(["video", "thumbnail", "control_sheet", "alpha_video", "metadata"]);
const ASSET_ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,119}$/;

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ assetId: string; role: string }> },
) {
  const user = await getCurrentUser();
  if (!user) return new Response("Unauthorized", { status: 401 });
  const { assetId, role } = await params;
  if (!ROLES.has(role) || !ASSET_ID.test(assetId) || assetId.includes("..")) {
    return new Response("Not found", { status: 404 });
  }
  const row = await db().render3DAsset.findUnique({
    where: { id: assetId },
    select: { workspaceId: true, assetType: true, record: true },
  });
  if (!row || row.workspaceId !== user.workspaceId || !CLIP_TYPES.includes(row.assetType)) {
    return new Response("Not found", { status: 404 });
  }
  const file = parseAsset(row.record)?.outputFiles.find((f) => f.role === role);
  if (!file) return new Response("Not found", { status: 404 });
  return streamStorageObject(request, storage(), file.key, file.contentType);
}
