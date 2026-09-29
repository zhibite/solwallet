"use client";
import React, { useEffect, useState } from "react";

export default function ApiSettingsPage() {
  const [heliusKey, setHeliusKey] = useState('');
  const [birdeyeKey, setBirdeyeKey] = useState('');
  const [rpcs, setRpcs] = useState('');
  const [webhookUrl, setWebhookUrl] = useState('');
  const [useWebhook, setUseWebhook] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    fetch('/api/settings')
      .then((r) => r.json())
      .then((j) => {
        if (j.ok) {
          const s = j.data;
          setHeliusKey(s.HELIUS_API_KEY || '');
          setBirdeyeKey(s.BIRDEYE_API_KEY || '');
          setRpcs(s.SOLANA_RPCS || '');
          setWebhookUrl(s.WEBHOOK_URL || '');
          setUseWebhook(s.HELIUS_USE_WEBHOOK === 'true');
        }
      });
  }, []);

  const save = async () => {
    await fetch('/api/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        HELIUS_API_KEY: heliusKey,
        BIRDEYE_API_KEY: birdeyeKey,
        SOLANA_RPCS: rpcs,
        WEBHOOK_URL: webhookUrl,
        HELIUS_USE_WEBHOOK: String(useWebhook),
      }),
    });
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-semibold text-gray-900 dark:text-white">API 配置</h1>
        <p className="text-sm text-gray-500 mt-1">
          配置 Solana 数据源。修改后重启服务生效。
        </p>
      </div>

      <div className="bg-white dark:bg-zinc-900 rounded-lg border border-gray-200 dark:border-zinc-700 p-4 space-y-4">
        <Field label="Helius API Key" value={heliusKey} onChange={setHeliusKey} placeholder="从 https://dashboard.helius.dev 获取" secret />
        <Field label="Birdeye API Key (可选)" value={birdeyeKey} onChange={setBirdeyeKey} placeholder="价格 fallback 用" secret />
        <Field label="Solana RPC (逗号分隔)" value={rpcs} onChange={setRpcs} placeholder="https://api.mainnet-beta.solana.com" />
        <Field label="Webhook URL" value={webhookUrl} onChange={setWebhookUrl} placeholder="https://your-domain.com/api/webhooks/helius" />
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={useWebhook} onChange={(e) => setUseWebhook(e.target.checked)} className="rounded" />
          启用 Helius Webhook（需要公网可访问的域名）
        </label>

        <div className="flex items-center gap-3 pt-2">
          <button onClick={save} className="h-10 px-5 rounded bg-brand-500 hover:bg-brand-600 text-white text-sm font-medium">
            保存
          </button>
          {saved && <span className="text-sm text-success-500">已保存</span>}
        </div>
      </div>

      <div className="bg-blue-50 dark:bg-blue-500/10 border border-blue-200 dark:border-blue-500/30 rounded-lg p-4 text-xs text-blue-900 dark:text-blue-300">
        <p className="font-medium mb-1">💡 提示</p>
        <ul className="list-disc list-inside space-y-1">
          <li>Helius Free tier 提供 100K credits/月，足以测试</li>
          <li>无 Webhook 时自动轮询 getSignaturesForAddress（约 5 秒延迟）</li>
          <li>生产环境建议用 ngrok / cloudflared 暴露 localhost:3000 给 webhook</li>
        </ul>
      </div>
    </div>
  );
}

function Field({ label, value, onChange, placeholder, secret }: { label: string; value: string; onChange: (v: string) => void; placeholder?: string; secret?: boolean }) {
  return (
    <div>
      <label className="block text-xs text-gray-500 mb-1">{label}</label>
      <input
        type={secret ? 'password' : 'text'}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="w-full h-10 px-3 rounded border border-gray-300 dark:border-zinc-700 bg-white dark:bg-zinc-800 text-sm font-mono"
      />
    </div>
  );
}
