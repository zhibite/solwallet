"use client";
import React, { useEffect, useState } from "react";

/** 相对时间显示：刚刚 / X分钟前 / X小时前 / X天前 / YYYY-MM-DD */
export default function RelativeTime({ iso }: { iso: string | null | undefined }) {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);

  if (!iso) return <span className="text-gray-400">-</span>;
  const ts = new Date(iso).getTime();
  if (Number.isNaN(ts)) return <span className="text-gray-400">-</span>;

  const diffSec = Math.floor((now - ts) / 1000);
  let label: string;
  if (diffSec < 60) label = '刚刚';
  else if (diffSec < 3600) label = `${Math.floor(diffSec / 60)}分钟前`;
  else if (diffSec < 86400) label = `${Math.floor(diffSec / 3600)}小时前`;
  else if (diffSec < 86400 * 7) label = `${Math.floor(diffSec / 86400)}天前`;
  else {
    const d = new Date(ts);
    label = `${d.getMonth() + 1}-${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  }

  return (
    <span className="font-mono text-xs text-gray-600 dark:text-gray-400" title={new Date(ts).toISOString()}>
      {label}
    </span>
  );
}
