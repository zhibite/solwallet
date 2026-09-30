"use client";

import type React from "react";
import { createContext, useState, useContext, useEffect } from "react";

type Theme = "light" | "dark";

type ThemeContextType = {
  theme: Theme;
  toggleTheme: () => void;
};

const ThemeContext = createContext<ThemeContextType | undefined>(undefined);

export const ThemeProvider: React.FC<{ children: React.ReactNode }> = ({
  children,
}) => {
  const [theme, setTheme] = useState<Theme | undefined>(undefined);
  const [isInitialized, setIsInitialized] = useState(false);

  useEffect(() => {
    // Read the current dark class state (already set by NoFlash before hydration)
    const isDarkMode = document.documentElement.classList.contains("dark");
    const initialTheme: Theme = isDarkMode ? "dark" : "light";

    setTheme(initialTheme);
    setIsInitialized(true);
  }, []);

  useEffect(() => {
    if (!isInitialized) return;
    localStorage.setItem("theme", theme ?? "light");
    document.documentElement.classList.toggle("dark", theme === "dark");
  }, [theme, isInitialized]);

  const toggleTheme = () => {
    setTheme((prevTheme) => (prevTheme === "light" ? "dark" : "light"));
  };

  return (
    <ThemeContext.Provider value={{
      theme: theme || "light",
      toggleTheme
    }}>
      {children}
    </ThemeContext.Provider>
  );
};

export const useTheme = () => {
  const context = useContext(ThemeContext);
  if (context === undefined) {
    throw new Error("useTheme must be used within a ThemeProvider");
  }
  return context;
};
