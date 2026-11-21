import { Check, Copy } from "lucide-react";
import { useState } from "react";
import { Icon } from "./Icon";

/** A command or snippet with a copy button (styles: .src-copy* in sources.css, global). */
export function CopyBox({ label, text, multiline = false }: { label: string; text: string; multiline?: boolean }) {
  const [done, setDone] = useState(false);
  return (
    <div className="src-copy">
      <span className="field-label">{label}</span>
      <div className={multiline ? "src-copy-row multiline" : "src-copy-row"}>
        {multiline ? <pre>{text}</pre> : <code>{text}</code>}
        <button
          type="button"
          className="icon-btn"
          aria-label={`Copy ${label.toLowerCase()}`}
          onClick={() => {
            void navigator.clipboard?.writeText(text).then(() => {
              setDone(true);
              setTimeout(() => setDone(false), 1200);
            });
          }}
        >
          <Icon as={done ? Check : Copy} />
        </button>
      </div>
    </div>
  );
}

