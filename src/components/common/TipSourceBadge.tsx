/**
 * TipSourceBadge
 *  把 TipSource 类型显示成一个带颜色的小徽章，方便 UI 各处复用。
 *
 *  - 'jito'           : 紫色（jito 经典）
 *  - 'helius_sender'  : 蓝色（helius 品牌色）
 *  - 'landx'          : 绿色（landx 品牌色）
 *  - 'zero_slot'      : 黄色（0slot 强调色）
 *  - 'unknown'        : 灰色（未识别通道；可能是新通道 / 数据问题）
 *  - null             : 不渲染（不显示徽章）
 *
 *  用法：
 *    <TipSourceBadge value={trade.tip_source} />
 *    <TipSourceBadge value={buyer.tip_source} compact />
 */
import React from 'react';
import type { TipSource } from '@/lib/types';

const COLORS: Record<TipSource, string> = {
  jito: 'bg-purple-500/15 text-purple-700 dark:text-purple-400 ring-purple-500/30',
  helius_sender: 'bg-blue-500/15 text-blue-700 dark:text-blue-400 ring-blue-500/30',
  landx: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-400 ring-emerald-500/30',
  zero_slot: 'bg-amber-500/15 text-amber-700 dark:text-amber-400 ring-amber-500/30',
  unknown: 'bg-gray-500/15 text-gray-600 dark:text-gray-400 ring-gray-500/30',
};

const LABELS: Record<TipSource, string> = {
  jito: 'Jito',
  helius_sender: 'Helius Sender',
  landx: 'LandX',
  zero_slot: '0slot',
  unknown: '未知',
};

const FULL_LABELS: Record<TipSource, string> = {
  jito: 'Jito tip',
  helius_sender: 'Helius Sender tip',
  landx: 'LandX tip',
  zero_slot: '0slot tip',
  unknown: '未知 tip 通道',
};

/**
 * 窄列（compact）专用短标，固定 3~4 字符，方便在 monitor 列表里一眼辨认。
 * 不用 value.slice(0, 4) 是因为 helius_sender 截 4 字符会得到 "heli"——看不出是 Helius。
 */
const SHORT_LABELS: Record<TipSource, string> = {
  jito: 'Jito',
  helius_sender: 'Hel',
  landx: 'LndX',
  zero_slot: '0sl',
  unknown: '?',
};

interface Props {
  value: TipSource | null | undefined;
  compact?: boolean;
  /** 显示完整 label（含 "tip"），默认紧凑只显示通道名 */
  showTipWord?: boolean;
}

export default function TipSourceBadge({ value, compact, showTipWord }: Props) {
  if (!value) return null;
  const color = COLORS[value];
  const text = showTipWord
    ? FULL_LABELS[value]
    : compact
    ? SHORT_LABELS[value]
    : LABELS[value];
  return (
    <span
      className={`inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-mono ring-1 ring-inset ${color}`}
      title={FULL_LABELS[value]}
    >
      {text}
    </span>
  );
}