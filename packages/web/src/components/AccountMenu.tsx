import { BellRing, ChevronDown, LogOut } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { useAccount } from "../account";
import { Icon } from "./Icon";

export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  return ((parts[0]?.[0] ?? "?") + (parts.length > 1 ? parts[parts.length - 1]![0] : "")).toUpperCase();
}

/** Top-right account button: who you are, Notification preferences, Sign out. */
export function AccountMenu() {
  const { state, signOut } = useAccount();
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

  if (state.status !== "signedIn") return null;
  const p = state.person;
  return (
    <div className="account-menu" ref={ref}>
      <button
        type="button"
        className="account-btn"
        aria-label={`Account: ${p.name}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="account-avatar" aria-hidden="true">
          {initials(p.name)}
        </span>
        <span className="account-name">{p.name}</span>
        <Icon as={ChevronDown} />
      </button>
      {open ? (
        <div className="account-pop" role="dialog" aria-label="Account">
          <div className="account-head">
            <span className="account-avatar large" aria-hidden="true">
              {initials(p.name)}
            </span>
            <div className="account-who">
              <span className="account-pop-name">{p.name}</span>
              <span className="muted">{p.role || "No role"}</span>
            </div>
          </div>
          <p className="muted account-perm">
            {p.canCreateRules ? "Can create and edit rules." : "Can't create rules."}
            {state.mock ? " Demo mode: kept in this browser." : ""}
          </p>
          <Link className="account-item" to="/settings/notifications" onClick={() => setOpen(false)}>
            <Icon as={BellRing} /> Notification preferences
          </Link>
          <button type="button" className="account-item" onClick={() => void signOut()}>
            <Icon as={LogOut} /> Sign out
          </button>
        </div>
      ) : null}
    </div>
  );
}
