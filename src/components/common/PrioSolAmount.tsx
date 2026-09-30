"use client";
import React from "react";
import SolAmount from "./SolAmount";

/**
 * 把 lamports 自动换算成 SOL 后用 SolAmount 显示。
 * 适用于：DB 存的是 prio_lamports（bigint lamports），UI 想直接看 SOL。
 */
export default function PrioSolAmount({
  value,
  decimals = 6,
  signed = false,
}: {
  value: number | string | null | undefined;
  decimals?: number;
  signed?: boolean;
}) {
  if (value === null || value === undefined || value === "") return <SolAmount value={null} />;
  const n = typeof value === "string" ? parseFloat(value) : value;
  if (!Number.isFinite(n)) return <SolAmount value={null} />;
  return <SolAmount value={n / 1e9} decimals={decimals} signed={signed} />;
}
