import { Settings } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Icon } from "./Icon";

const SECTIONS = ["Profile", "Notifications", "Theme", "Starred filters"];

export function SettingsMenu() {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div ref={ref}>
      <button
        type="button"
        className="icon-btn"
        aria-label="Settings"
        aria-expanded={open}
        aria-controls="settings-panel"
        onClick={() => setOpen((v) => !v)}
      >
        <Icon as={Settings} />
      </button>
      {open && (
        <div id="settings-panel" className="panel" role="dialog" aria-label="Settings">
          {SECTIONS.map((name) => (
            <section key={name}>
              <h2>{name}</h2>
              <p className="muted">Not set up yet.</p>
            </section>
          ))}
        </div>
      )}
    </div>
  );
}
