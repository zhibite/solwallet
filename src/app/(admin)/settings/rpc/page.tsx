"use client";
import React from "react";
import dynamic from "next/dynamic";

const RpcStatusPage = dynamic(() => import("@/components/rpc/RpcStatusPage"), {
  ssr: false,
  loading: () => <div className="p-6 text-center text-gray-500">加载中...</div>,
});

export default function Page() {
  return (
    <div className="space-y-4">
      <RpcStatusPage />
    </div>
  );
}
