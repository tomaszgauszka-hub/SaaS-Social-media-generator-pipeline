import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // workspace packages (@cre/*) ship TypeScript source; Turbopack transpiles them automatically
  serverExternalPackages: ["@prisma/adapter-pg", "@aws-sdk/s3-request-presigner"],
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
