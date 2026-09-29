"use client";

/**
 * NoFlash component - prevents dark mode flash on page load
 *
 * This script runs before React hydrates, reading the DOM's dark class
 * (set by a prior inline script in <head>) to determine the initial theme.
 * Without this, pages would flash white before dark mode kicks in.
 */
export function NoFlash() {
  return (
    <script
      dangerouslySetInnerHTML={{
        __html: `
          (function() {
            var theme = localStorage.getItem('theme');
            if (
              theme === 'dark' ||
              (theme === null && window.matchMedia('(prefers-color-scheme: dark)').matches)
            ) {
              document.documentElement.classList.add('dark');
            } else {
              document.documentElement.classList.remove('dark');
            }
          })();
        `,
      }}
    />
  );
}
