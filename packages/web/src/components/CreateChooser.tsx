import type { LucideIcon } from "lucide-react";
import { Children, type ReactNode } from "react";
import { Icon } from "./Icon";

/** True when at least one child renders something (false/null/"" don't count). */
const hasContent = (c: ReactNode) => Children.toArray(c).length > 0;

export interface CreateOption {
  id: string;
  icon: LucideIcon;
  title: string;
  description: string;
}

/**
 * "How do you want to create it?" Shared by every configuration page (rules, sources,
 * schemas): pick a way, and the chosen option's panel opens below.
 */
export function CreateChooser({
  title,
  intro,
  options,
  selected,
  onSelect,
  children,
}: {
  title: string;
  intro: string;
  options: CreateOption[];
  selected: string | null;
  onSelect: (id: string) => void;
  /** Content for the selected option (paste box, file picker, examples...). */
  children?: ReactNode;
}) {
  return (
    <div className="chooser">
      <header className="page-header">
        <div>
          <h1>{title}</h1>
          <p className="page-intro">{intro}</p>
        </div>
      </header>
      <div className="chooser-grid" role="radiogroup" aria-label="How to create it">
        {options.map((o) => (
          <button
            key={o.id}
            type="button"
            role="radio"
            aria-checked={selected === o.id}
            className={selected === o.id ? "choice selected" : "choice"}
            onClick={() => onSelect(o.id)}
          >
            <span className="choice-icon">
              <Icon as={o.icon} />
            </span>
            <span className="choice-title">{o.title}</span>
            <span className="choice-text">{o.description}</span>
          </button>
        ))}
      </div>
      {hasContent(children) && <div className="chooser-panel">{children}</div>}
    </div>
  );
}
