"use client";
import React, { useState } from "react";
import { CopyIcon, CheckLineIcon } from "@/icons";

export default function AddressCopy({ address, length = 6 }: { address: string; length?: number }) {
  const [copied, setCopied] = useState(false);
  const short = address.length > length * 2 + 3
    ? `${address.slice(0, length)}...${address.slice(-length)}`
    : address;

  const handleCopy = () => {
    navigator.clipboard.writeText(address).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };

  return (
    <button
      onClick={handleCopy}
      className="inline-flex items-center gap-1 font-mono text-xs text-gray-700 dark:text-gray-300 hover:text-brand-500 transition-colors"
      title={address}
    >
      <span>{short}</span>
      {copied ? <CheckLineIcon className="w-3 h-3 text-success-500" /> : <CopyIcon className="w-3 h-3 opacity-60 dark:opacity-70" />}
    </button>
  );
}
