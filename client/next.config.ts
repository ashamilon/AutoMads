import type { NextConfig } from "next";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const nextConfig: NextConfig = {
  reactStrictMode: true,
  /** Monorepo: trace files from repo root when API lockfile sits above `client/` */
  outputFileTracingRoot: path.join(__dirname, ".."),
  /**
   * Hide the Next.js dev indicator (the small "N" badge in the bottom-left
   * corner that shows during local dev). The marketing surface needs to look
   * production-ready even when running `npm run dev`. Setting this to `false`
   * disables BOTH the static-route badge and the build-activity spinner.
   *
   * Production builds never show the indicator anyway; this is purely a
   * dev-mode quality-of-life tweak.
   */
  devIndicators: false,
};

export default nextConfig;
