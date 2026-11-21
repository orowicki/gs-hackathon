import { LogOut, Settings } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { useAccount } from "../account";
import { Icon } from "./Icon";

/** "Signed in as <name> (role)" and Sign out: the account section of the gear panel. */
export function AccountSection() {
  const { state, signOut } = useAccount();
  if (state.status !== "signedIn") return <p className="muted">Not signed in.</p>;
  const p = state.person;
  return (
    <div className="account-section">
      <p>
        Signed in as <strong>{p.name}</strong>
        {p.role ? <span className="muted"> ({p.role})</span> : null}
      </p>
      <p className="muted">
        {p.canCreateRules ? "Can create and edit rules." : "Can't create rules."}
        {state.mock ? " Demo mode: kept in this browser." : ""}
      </p>
      <button type="button" className="btn account-signout" onClick={() => void signOut()}>
        <Icon as={LogOut} /> Sign out
      </button>
    </div>
  );
}

const SECTIONS = ["Account", "Notifications", "Starred filters"];

/** sections replaces the placeholder text under a heading (e.g. Profile) with real content. */
export function SettingsMenu({ sections = {} }: { sections?: Partial<Record<string, ReactNode>> }) {
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
              {sections[name] ?? (name === "Account" ? <AccountSection /> : <p className="muted">Not set up yet.</p>)}
            </section>
          ))}
        </div>
      )}
    </div>
  );
}
