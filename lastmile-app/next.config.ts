import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: false,
  reactCompiler: true,
  output: "standalone",
  serverExternalPackages: ["snowflake-sdk", "pg"],
};

export default nextConfig;
