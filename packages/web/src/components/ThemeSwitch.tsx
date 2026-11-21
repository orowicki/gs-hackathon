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
