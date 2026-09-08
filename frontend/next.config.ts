import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  allowedDevOrigins: ["erp.elliottnotrica.com"],
  turbopack: {
    resolveAlias: { canvas: "./empty-module.js" },
  },
  typescript: {
    ignoreBuildErrors: true,
  },
  experimental: {
    staleTimes: { dynamic: 0, static: 0 },
  },
  redirects: async () => [
    // The investor room renders at its own path; the generic portal view would
    // show a bare file list and ignore every tile. Links already sent out —
    // and the room's own slug — have to land in the right place.
    { source: "/portal/investors", destination: "/investors", permanent: false },
  ],
  headers: async () => [
    {
      source: "/(.*)",
      headers: [{ key: "Cache-Control", value: "no-store, must-revalidate" }],
    },
  ],
};

export default nextConfig;
