"use client";

import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Modal } from "@/components/ui/modal";

/** 弹框视觉风格。danger 用于删除/清空，warning 用于不可撤销的批量操作 */
export type ConfirmVariant = "info" | "success" | "warning" | "danger";

export interface ConfirmOptions {
  /** 标题，一句话说清要做什么 */
  title: string;
  /** 补充说明：影响范围、不可撤销提示等 */
  description?: React.ReactNode;
  /** 确认按钮文案，默认「确定」 */
  confirmText?: string;
  /** 取消按钮文案，默认「取消」 */
  cancelText?: string;
  /** 视觉风格，默认 info */
  variant?: ConfirmVariant;
  /** 隐藏取消按钮（纯通知用） */
  hideCancel?: boolean;
}

interface ConfirmContextValue {
  /** 返回 Promise<boolean>：确认 true，取消 false */
  confirm: (options: ConfirmOptions) => Promise<boolean>;
  /** 纯提示弹框，只有一个确定按钮。返回 Promise<void> */
  alert: (options: ConfirmOptions) => Promise<void>;
}

const ConfirmContext = createContext<ConfirmContextValue | null>(null);

/**
 * 用法：
 *   const { confirm, alert } = useConfirm();
 *   if (!(await confirm({ title: '删除目标', variant: 'danger' }))) return;
 *   await alert({ title: '已删除', variant: 'success' });
 */
export function useConfirm(): ConfirmContextValue {
  const ctx = useContext(ConfirmContext);
  if (!ctx) throw new Error("useConfirm 必须在 <ConfirmProvider> 内使用");
  return ctx;
}

const VARIANT_STYLES: Record<
  ConfirmVariant,
  { iconBg: string; iconColor: string; confirmBtn: string; ring: string }
> = {
  info: {
    iconBg: "bg-brand-50 dark:bg-brand-500/10",
    iconColor: "text-brand-500",
    confirmBtn:
      "bg-brand-500 hover:bg-brand-600 focus-visible:ring-brand-500/30 text-white",
    ring: "ring-brand-500/20",
  },
  success: {
    iconBg: "bg-success-50 dark:bg-success-500/10",
    iconColor: "text-success-500",
    confirmBtn:
      "bg-success-600 hover:bg-success-700 focus-visible:ring-success-500/30 text-white",
    ring: "ring-success-500/20",
  },
  warning: {
    iconBg: "bg-warning-50 dark:bg-warning-500/10",
    iconColor: "text-warning-500",
    confirmBtn:
      "bg-warning-600 hover:bg-warning-700 focus-visible:ring-warning-500/30 text-white",
    ring: "ring-warning-500/20",
  },
  danger: {
    iconBg: "bg-error-50 dark:bg-error-500/10",
    iconColor: "text-error-500",
    confirmBtn:
      "bg-error-600 hover:bg-error-700 focus-visible:ring-error-500/30 text-white",
    ring: "ring-error-500/20",
  },
};

function VariantIcon({ variant }: { variant: ConfirmVariant }) {
  const common = {
    width: 24,
    height: 24,
    viewBox: "0 0 24 24",
    fill: "none",
    xmlns: "http://www.w3.org/2000/svg",
  };
  if (variant === "success") {
    return (
      <svg {...common} aria-hidden="true">
        <path
          d="M22 11.08V12a10 10 0 1 1-5.93-9.14"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <path
          d="m9 11 3 3L22 4"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    );
  }
  if (variant === "warning" || variant === "danger") {
    return (
      <svg {...common} aria-hidden="true">
        <path
          d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0Z"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <path
          d="M12 9v4M12 17h.01"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    );
  }
  return (
    <svg {...common} aria-hidden="true">
      <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="2" />
      <path
        d="M12 16v-4M12 8h.01"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

interface PendingState extends ConfirmOptions {
  kind: "confirm" | "alert";
  resolve: (value: boolean) => void;
}

/**
 * 全局确认弹框 Provider。挂在根 layout，一次挂载全局可用。
 * 提供 confirm / alert 两个 Promise 风格 API，替代浏览器原生弹窗。
 */
export function ConfirmProvider({ children }: { children: React.ReactNode }) {
  const [pending, setPending] = useState<PendingState | null>(null);
  const resolverRef = useRef<((value: boolean) => void) | null>(null);

  const close = useCallback((result: boolean) => {
    setPending(null);
    const resolve = resolverRef.current;
    resolverRef.current = null;
    resolve?.(result);
  }, []);

  const open = useCallback(
    (kind: "confirm" | "alert", options: ConfirmOptions) =>
      new Promise<boolean>((resolve) => {
        // 上一个弹框未处理完时，直接以取消收尾，避免 resolver 泄漏
        resolverRef.current?.(false);
        resolverRef.current = resolve;
        setPending({ ...options, kind, resolve });
      }),
    []
  );

  const confirm = useCallback(
    (options: ConfirmOptions) => open("confirm", options),
    [open]
  );
  const alert = useCallback(
    (options: ConfirmOptions) =>
      open("alert", options).then(() => undefined),
    [open]
  );

  const value = useMemo(() => ({ confirm, alert }), [confirm, alert]);

  const isOpen = pending !== null;
  const hideCancel = pending?.kind === "alert" || pending?.hideCancel === true;

  // Esc 取消；纯提示弹框 Esc = 关闭
  useEffect(() => {
    if (!isOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        close(false);
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [isOpen, close]);

  // 卸载时兜底 resolve，避免调用方 await 永久挂起
  useEffect(() => () => resolverRef.current?.(false), []);

  const variant = pending?.variant ?? "info";
  const styles = VARIANT_STYLES[variant];

  return (
    <ConfirmContext.Provider value={value}>
      {children}

      <Modal
        isOpen={isOpen}
        onClose={() => close(false)}
        showCloseButton={false}
        showBackdrop={false}
        className="max-w-md w-[calc(100vw-2rem)] p-6 sm:p-7 shadow-2xl ring-1 ring-black/5 dark:ring-white/10"
      >
        {pending && (
          <div
            role="alertdialog"
            aria-modal="true"
            aria-label={pending.title}
            className="flex flex-col items-center text-center"
          >
            <div
              className={`flex h-14 w-14 shrink-0 items-center justify-center rounded-full ${styles.iconBg} ${styles.iconColor} ring-8 ${styles.ring}`}
            >
              <VariantIcon variant={variant} />
            </div>

            <h3 className="mt-5 text-lg font-semibold text-gray-900 dark:text-white/90">
              {pending.title}
            </h3>

            {pending.description && (
              <div className="mt-2 max-w-sm text-sm leading-relaxed text-gray-500 dark:text-gray-400">
                {pending.description}
              </div>
            )}

            <div className="mt-7 flex w-full flex-col-reverse gap-2 sm:flex-row sm:justify-center">
              {!hideCancel && (
                <button
                  type="button"
                  autoFocus
                  onClick={() => close(false)}
                  className="h-11 w-full rounded-xl border border-gray-300 bg-white px-6 text-sm font-medium text-gray-700 transition-colors hover:bg-gray-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gray-400/40 dark:border-gray-700 dark:bg-zinc-800 dark:text-gray-300 dark:hover:bg-zinc-700"
                >
                  {pending.cancelText ?? "取消"}
                </button>
              )}
              <button
                type="button"
                autoFocus={hideCancel}
                onClick={() => close(true)}
                className={`h-11 w-full rounded-xl px-6 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 ${styles.confirmBtn}`}
              >
                {pending.confirmText ?? (pending.kind === "alert" ? "知道了" : "确定")}
              </button>
            </div>
          </div>
        )}
      </Modal>
    </ConfirmContext.Provider>
  );
}

export default ConfirmProvider;
