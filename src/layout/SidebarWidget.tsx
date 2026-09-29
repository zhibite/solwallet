import React from "react";

export default function SidebarWidget() {
  return (
    <div
      className={`
        mx-auto mb-10 w-full max-w-60 rounded-2xl bg-gray-50 px-4 py-5 text-center dark:bg-zinc-700/50`}
    >
      <h3 className="mb-2 font-semibold text-gray-800 dark:text-white/90">
        SolWallet v1.0
      </h3>
      <p className="mb-3 text-gray-500 text-theme-sm dark:text-gray-400">
        Solana 跟单抢单监控 · 复刻自原版截图
      </p>
      <div className="text-xs text-gray-400 dark:text-gray-500">
        <a
          href="https://docs.helius.dev"
          target="_blank"
          rel="nofollow"
          className="hover:text-brand-500"
        >
          Helius 文档
        </a>
      </div>
    </div>
  );
}
