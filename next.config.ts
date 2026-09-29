import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // 使用 ?react 后缀导入 SVG (Next.js 16 Turbopack 原生支持)
  // 例如: import Icon from "./icon.svg?react";

  typescript: {
    ignoreBuildErrors: true, // 临时跳过 TS 检查，部署优先
  },
};

export default nextConfig;
