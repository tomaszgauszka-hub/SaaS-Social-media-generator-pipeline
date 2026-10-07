import { NextResponse, type NextRequest } from "next/server";

/**
 * Optimistic check only: signed-out visitors of app pages go to /login without a database round trip.
 * Real authorization happens server-side in every page, server action and route handler.
 */
const PUBLIC_PREFIXES = [
  "/login",
  "/go/",
  "/b/",
  "/api/webhooks/",
  "/api/health",
  "/api/oauth/",
  "/_next/",
  "/favicon",
];

export function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;
  if (PUBLIC_PREFIXES.some((p) => pathname.startsWith(p)) || pathname === "/") return NextResponse.next();
  if (!request.cookies.has("cre_session")) {
    if (pathname.startsWith("/api/")) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    const url = request.nextUrl.clone();
    url.pathname = "/login";
    url.search = "";
    return NextResponse.redirect(url);
  }
  return NextResponse.next();
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
