import type { NextConfig } from "next";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const nextConfig: NextConfig = {
  reactStrictMode: true,
  /** Monorepo: trace files from repo root when API lockfile sits above `client/` */
  outputFileTracingRoot: path.join(__dirname, ".."),
};

export default nextConfig;
