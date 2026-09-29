"use client";
import React from "react";
import dynamic from "next/dynamic";
import { useParams } from "next/navigation";

const BlockDetail = dynamic(() => import("@/components/block/BlockDetail"), {
  ssr: false,
  loading: () => <div className="p-6 text-center text-gray-500 dark:text-gray-400">加载中...</div>,
});

export default function BlockPage() {
  const params = useParams();
  return (
    <div className="space-y-4">
      <BlockDetail key={`${params.slot}-${params.mint}`} />
    </div>
  );
}
