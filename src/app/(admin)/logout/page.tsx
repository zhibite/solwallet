"use client";
import { useRouter } from "next/navigation";

export default function LogoutPage() {
  const router = useRouter();
  return (
    <div className="flex flex-col items-center justify-center min-h-[400px] space-y-4">
      <h1 className="text-xl font-semibold">退出登录？</h1>
      <p className="text-sm text-gray-500">当前为单机模式，本地未启用认证</p>
      <button
        onClick={() => router.push('/')}
        className="h-10 px-5 rounded bg-brand-500 hover:bg-brand-600 text-white text-sm font-medium"
      >
        返回首页
      </button>
    </div>
  );
}
