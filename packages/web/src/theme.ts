import { useEffect, useState } from "react";

export type Theme = "dark" | "light";
const KEY = "alerting.theme";
const listeners = new Set<(t: Theme) => void>();

export function readTheme(): Theme {
  try {
    return localStorage.getItem(KEY) === "light" ? "light" : "dark";
  } catch {
    return "dark";
  }
}

/** Sets <html data-theme>, remembers the choice and tells every useTheme() caller. */
export function applyTheme(t: Theme): void {
  document.documentElement.dataset.theme = t;
  try {
    localStorage.setItem(KEY, t);
  } catch {
    /* storage unavailable: the choice lasts until reload */
  }
  for (const l of listeners) l(t);
}

export function useTheme(): [Theme, (t: Theme) => void] {
  const [theme, setTheme] = useState<Theme>(readTheme);
  useEffect(() => {
    listeners.add(setTheme);
    return () => {
      listeners.delete(setTheme);
    };
  }, []);
  return [theme, applyTheme];
}
