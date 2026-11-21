import type { Person, StarredFilter } from "@alerting/shared";
import { Check, X } from "lucide-react";
import { Icon } from "../../components/Icon";
import { filterText } from "./helpers";

export function ProfilePicker({ people, currentId, onSelect }: { people: Person[]; currentId: string | null; onSelect(id: string): void }) {
  if (people.length === 0) return <p className="muted">No profiles available.</p>;
  return (
    <div className="profile-list" role="radiogroup" aria-label="Profile">
      {people.map((p) => {
        const on = p.id === currentId;
        return (
          <button key={p.id} type="button" role="radio" aria-checked={on} className="profile-item" onClick={() => onSelect(p.id)}>
            <span className="profile-text">
              <span>{p.name}</span>
              <span className="muted">{p.role}</span>
            </span>
            {on && <Icon as={Check} />}
          </button>
        );
      })}
    </div>
  );
}

export function StarredList({ starred, onApply, onRemove }: { starred: StarredFilter[]; onApply(text: string): void; onRemove(id: string): void }) {
  if (starred.length === 0) return <p className="muted">No starred filters yet.</p>;
  return (
    <ul className="starred-list">
      {starred.map((s) => {
        const text = filterText(s.filter);
        return (
          <li key={s.id}>
            <button type="button" className="starred-apply mono" title={text} onClick={() => onApply(text)}>
              {s.name}
            </button>
            <button type="button" className="icon-btn" aria-label={"Remove starred filter " + s.name} onClick={() => onRemove(s.id)}>
              <Icon as={X} />
            </button>
          </li>
        );
      })}
    </ul>
  );
}
