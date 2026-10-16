import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // workspace packages (@cre/*) ship TypeScript source; Turbopack transpiles them automatically
  serverExternalPackages: ["@prisma/adapter-pg", "@aws-sdk/s3-request-presigner"],
  turbopack: {
    resolveAlias: {
      // the web app needs only the pure part of @cre/render3d (contracts, router, library) — not the engines and
      // the reel factory behind its setup module (see src/lib/render3d-server-entry.js)
      "@cre/render3d": "./src/lib/render3d-server-entry.js",
    },
  },
  poweredByHeader: false,
  headers() {
    return Promise.resolve([
      {
        source: "/:path*",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
        ],
      },
    ]);
  },
};

export default nextConfig;
