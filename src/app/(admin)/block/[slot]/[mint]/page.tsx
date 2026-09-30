"use client";
import React from "react";
import dynamic from "next/dynamic";
import { useParams } from "next/navigation";

const BlockDetailView = dynamic(() => import("@/components/block/BlockDetailView"), {
  ssr: false,
  loading: () => <div className="p-6 text-center text-gray-500 dark:text-gray-400">加载中...</div>,
});

export default function BlockPage() {
  const params = useParams<{ slot: string; mint: string }>();
  const slot = parseInt(params.slot, 10);
  if (Number.isNaN(slot)) {
    return <div className="p-6 text-center text-error-500">slot 不合法</div>;
  }
  return (
    <div className="space-y-4">
      <BlockDetailView slot={slot} mint={params.mint} />
    </div>
  );
}