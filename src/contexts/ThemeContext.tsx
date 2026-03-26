/* eslint-disable react-refresh/only-export-components */
import React, { createContext, useContext, useState, useEffect, useCallback } from "react";

interface ThemeContextType {
  isDark: boolean;
  toggleDark: () => void;
  darknessLevel: number;
  setDarknessLevel: (v: number) => void;
}

const ThemeContext = createContext<ThemeContextType>({
  isDark: false,
  toggleDark: () => {},
  darknessLevel: 1,
  setDarknessLevel: () => {},
});

export const useTheme = () => useContext(ThemeContext);

export const ThemeProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [isDark, setIsDark] = useState(false);
  const [darknessLevel, setDarknessLevel] = useState(1);

  useEffect(() => {
    document.documentElement.classList.toggle("dark", isDark);
  }, [isDark]);

  useEffect(() => {
    document.documentElement.style.setProperty("--darkness-level", String(darknessLevel));
  }, [darknessLevel]);

  const toggleDark = useCallback(() => setIsDark((p) => !p), []);

  return (
    <ThemeContext.Provider value={{ isDark, toggleDark, darknessLevel, setDarknessLevel }}>
      {children}
    </ThemeContext.Provider>
  );
};
