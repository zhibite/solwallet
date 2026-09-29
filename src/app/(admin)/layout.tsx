"use client";

import { useSidebar } from "@/context/SidebarContext";
import AppHeader from "@/layout/AppHeader";
import AppSidebar from "@/layout/AppSidebar";
import Backdrop from "@/layout/Backdrop";
import React from "react";

export default function AdminLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const { isExpanded, isMobileOpen, isInitialized } = useSidebar();

  // Wait for initialization before rendering to avoid flash
  if (!isInitialized) {
    return null;
  }

  // Dynamic class for main content margin based on sidebar state
  // Only expand when explicitly toggled (isExpanded), not on hover
  const mainContentMargin = isMobileOpen
    ? "ml-0"
    : isExpanded
    ? "lg:ml-[240px]"
    : "lg:ml-[90px]";

  return (
    <div className="min-h-screen xl:flex bg-white dark:bg-zinc-900">
      {/* Sidebar and Backdrop */}
      <AppSidebar />
      <Backdrop />
      {/* Main Content Area */}
      <div
        className={`flex-1 transition-all duration-300 ease-in-out ${mainContentMargin} bg-white dark:bg-zinc-900`}
      >
        {/* Header */}
        <AppHeader />
        {/* Page Content */}
        <div className="p-4 mx-auto max-w-(--breakpoint-2xl) md:p-6 bg-white dark:bg-zinc-900">{children}</div>
      </div>
    </div>
  );
}
