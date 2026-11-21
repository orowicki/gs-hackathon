import { Moon, Sun } from "lucide-react";
import { useTheme } from "../theme";
import { Icon } from "./Icon";

/** Top-bar button: one click flips dark and light. */
export function ThemeToggle() {
  const [theme, setTheme] = useTheme();
  const next = theme === "dark" ? "light" : "dark";
  return (
    <button
      type="button"
      className="icon-btn"
      aria-label={`Switch to ${next} theme`}
      title={`Switch to ${next} theme`}
      onClick={() => setTheme(next)}
    >
      <Icon as={theme === "dark" ? Sun : Moon} />
    </button>
  );
}

/** The same choice as a labelled control, for the Settings panel. */
export function ThemeChoice() {
  const [theme, setTheme] = useTheme();
  return (
    <div className="segmented" role="radiogroup" aria-label="Theme">
      {(["dark", "light"] as const).map((t) => (
        <button
          key={t}
          type="button"
          role="radio"
          aria-checked={theme === t}
          className={theme === t ? "segment active" : "segment"}
          onClick={() => setTheme(t)}
        >
          {t === "dark" ? "Dark" : "Light"}
        </button>
      ))}
    </div>
  );
}
