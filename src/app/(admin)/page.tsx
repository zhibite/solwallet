"use client";
import React from "react";
import dynamic from "next/dynamic";

// 客户端动态加载，避免 SSR
const MonitorList = dynamic(() => import("@/components/monitor/MonitorList"), {
  ssr: false,
  loading: () => (
    <div className="p-6 text-center text-gray-500 dark:text-gray-400">加载中...</div>
  ),
});

export default function MonitorPage() {
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold text-gray-800 dark:text-white/90">跟单抢单监控</h1>
          <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">实时监控聪明钱地址，发现 buy 自动触发 block 级分析</p>
        </div>
      </div>
      <MonitorList />
    </div>
  );
}
