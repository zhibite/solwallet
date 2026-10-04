"use client";
import React, { useEffect, useState } from "react";
import AddressCopy from "@/components/common/AddressCopy";
import { TrashBinIcon, PlusIcon } from "@/icons";
import { useConfirm } from "@/components/ui/confirm-dialog";

interface Wallet {
  id: number;
  address: string;
  label: string | null;
  created_at: string;
}

export default function WalletsPage() {
  const [wallets, setWallets] = useState<Wallet[]>([]);
  const { confirm } = useConfirm();
  const [address, setAddress] = useState('');
  const [label, setLabel] = useState('');
  const [loading, setLoading] = useState(true);

  const load = () => {
    setLoading(true);
    fetch('/api/wallets')
      .then((r) => r.json())
      .then((j) => { if (j.ok) setWallets(j.data); })
      .finally(() => setLoading(false));
  };

  useEffect(load, []);

  const add = async () => {
    if (!address) return;
    await fetch('/api/wallets', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ address, label: label || undefined }),
    });
    setAddress('');
    setLabel('');
    load();
  };

  const del = async (id: number) => {
    const w = wallets.find((x) => x.id === id);
    const ok = await confirm({
      title: '删除该钱包？',
      description: (
        <>
          将从自己的钱包列表移除{' '}
          <span className="font-mono">{w ? `${w.address.slice(0, 6)}…${w.address.slice(-4)}` : `#${id}`}</span>
          {w?.label && <> （{w.label}）</>}，之后 block 分析中的「我的账号」标记会重新计算。
        </>
      ),
      confirmText: '删除',
      variant: 'danger',
    });
    if (!ok) return;
    await fetch(`/api/wallets?id=${id}`, { method: 'DELETE' });
    load();
  };

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-semibold text-gray-800 dark:text-white/90">自己钱包</h1>
        <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">
          配置你自己的钱包地址，用于在 block 级分析中标记「我的账号」并计算排位
        </p>
      </div>

      <div className="bg-white dark:bg-zinc-800 shadow-sm rounded-lg border border-gray-200 dark:border-gray-700 p-4">
        <div className="flex flex-wrap gap-3 items-end">
          <div className="flex-1 min-w-[300px]">
            <label className="block text-xs text-gray-500 dark:text-gray-400 mb-1">钱包地址</label>
            <input
              type="text"
              value={address}
              onChange={(e) => setAddress(e.target.value.trim())}
              placeholder="Solana 地址..."
              className="w-full px-4 py-2 pr-10 rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-zinc-700 text-sm font-mono text-gray-800 dark:text-white/90 placeholder:text-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>
          <div className="w-40">
            <label className="block text-xs text-gray-500 dark:text-gray-400 mb-1">标签 (可选)</label>
            <input
              type="text"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder="主号 / 子号..."
              className="w-full px-4 py-2 pr-10 rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-zinc-700 text-sm text-gray-800 dark:text-white/90 placeholder:text-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>
          <button onClick={add} className="h-10 px-4 rounded-xl bg-brand-500 hover:bg-brand-600 text-white text-sm font-medium flex items-center gap-1.5">
            <PlusIcon className="w-4 h-4" />添加
          </button>
        </div>
      </div>

      <div className="bg-white dark:bg-zinc-800 shadow-sm rounded-lg border border-gray-200 dark:border-gray-700 overflow-hidden">
        <div className="px-4 py-3 border-b border-gray-200 dark:border-gray-700 text-sm font-medium text-gray-800 dark:text-white/90">
          共 {wallets.length} 个钱包
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 dark:bg-zinc-700/50 text-xs text-gray-500 dark:text-gray-400">
              <tr>
                <th className="px-3 py-2 text-left">地址</th>
                <th className="px-3 py-2 text-left">标签</th>
                <th className="px-3 py-2 text-left">添加时间</th>
                <th className="px-3 py-2 text-center">操作</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr><td colSpan={4} className="px-3 py-6 text-center text-gray-500 dark:text-gray-400">加载中...</td></tr>
              ) : wallets.length === 0 ? (
                <tr><td colSpan={4} className="px-3 py-6 text-center text-gray-500 dark:text-gray-400">未配置自己钱包</td></tr>
              ) : (
                wallets.map((w) => (
                  <tr key={w.id} className="border-b border-gray-100 dark:border-gray-700/50">
                    <td className="px-3 py-2"><AddressCopy address={w.address} length={6} /></td>
                    <td className="px-3 py-2 text-gray-800 dark:text-white/90">{w.label || '-'}</td>
                    <td className="px-3 py-2 text-xs text-gray-500 dark:text-gray-400">{new Date(w.created_at).toLocaleString()}</td>
                    <td className="px-3 py-2 text-center">
                      <button onClick={() => del(w.id)} className="text-error-500 hover:underline text-xs flex items-center gap-1 mx-auto">
                        <TrashBinIcon className="w-3 h-3" />删除
                      </button>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
