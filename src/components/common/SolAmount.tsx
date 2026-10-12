"use client";
import React from "react";

export default function SolAmount({
  value,
  decimals = 4,
  signed = false,
  className,
}: {
  value: number | string | null | undefined;
  decimals?: number;
  signed?: boolean;
  /** 外部覆盖色：传了就用传入的（用于 tip/prio 等强制上色场景），不传走默认 + 符号色。 */
  className?: string;
}) {
  if (value === null || value === undefined || value === '') return <span className="text-gray-400 dark:text-gray-500">-</span>;
  const n = typeof value === 'string' ? parseFloat(value) : value;
  if (Number.isNaN(n)) return <span className="text-gray-400 dark:text-gray-500">-</span>;
  const isPositive = n > 0;
  const isNegative = n < 0;
  let color = className ?? 'text-gray-700 dark:text-gray-300';
  if (!className) {
    if (signed && isPositive) color = 'text-success-500';
    if (signed && isNegative) color = 'text-error-500';
  }

  const formatted = n.toFixed(decimals);
  const sign = isPositive ? '+' : '';

  return (
    <span className={`font-mono text-xs ${color}`}>
      {signed && isPositive ? sign : ''}{formatted}
    </span>
  );
}
