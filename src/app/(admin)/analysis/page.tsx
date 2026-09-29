"use client";
import React from "react";
import dynamic from "next/dynamic";

const AnalysisForm = dynamic(() => import("@/components/analysis/AnalysisForm"), {
  ssr: false,
  loading: () => <div className="p-6 text-center text-gray-500 dark:text-gray-400">加载中...</div>,
});

export default function AnalysisPage() {
  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-semibold text-gray-800 dark:text-white/90">跟单目标分析</h1>
        <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">对任意目标地址做历史 PnL 分析，判断其盈利能力</p>
      </div>
      <AnalysisForm />
    </div>
  );
}
