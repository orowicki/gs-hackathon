import { Lock, Pencil, Plus, Search, Trash2, Users, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useSearchParams } from "react-router-dom";
import type { Group, Person } from "../../../../shared/src/types/people";
import { useCurrentPerson } from "../../account";
import { initials } from "../../components/AccountMenu";
import { Icon } from "../../components/Icon";
import * as api from "./api";
import {
  emptyGroup,
  emptyPerson,
  groupPayload,
  personPayload,
  toggleMember,
  validateGroup,
  validatePerson,
  type Errors,
  type GroupDraft,
  type PersonDraft,
} from "./model";
import "./people.css";

const describe = (e: unknown) =>
  e instanceof api.HttpError
    ? e.status === 403
      ? "your account can't change people or groups"
      : `HTTP ${e.status}`
    : e instanceof Error
      ? e.message
      : String(e);

type Editing<T> = { id: string | null; draft: T } | null;
type Tab = "people" | "groups";

function Avatar({ name, size = "md" }: { name: string; size?: "sm" | "md" }) {
  return (
    <span className={`pg-avatar pg-avatar-${size}`} aria-hidden="true">
      {initials(name)}
    </span>
  );
}

export function PeoplePage() {
  const me = useCurrentPerson();
  // Without accounts (no provider) everything stays editable, as before.
  const canManage = me ? me.canCreateRules === true : true;
  const [params, setParams] = useSearchParams();
  const tab: Tab = params.get("tab") === "groups" ? "groups" : "people";
  const [query, setQuery] = useState("");

  const [people, setPeople] = useState<Person[]>([]);
  const [groups, setGroups] = useState<Group[]>([]);
  const [peopleErr, setPeopleErr] = useState<string | null>(null);
  const [groupsErr, setGroupsErr] = useState<string | null>(null);
  const [actionErr, setActionErr] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [pEdit, setPEdit] = useState<Editing<PersonDraft>>(null);
  const [gEdit, setGEdit] = useState<Editing<GroupDraft>>(null);

  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const loadSeq = useRef(0);

  const load = useCallback(async () => {
    const seq = ++loadSeq.current;
    const [p, g] = await Promise.allSettled([api.listPeople(), api.listGroups()]);
    if (seq !== loadSeq.current) return;
    if (p.status === "fulfilled") {
      setPeople(p.value);
      setPeopleErr(null);
    } else setPeopleErr(describe(p.reason));
    if (g.status === "fulfilled") {
      setGroups(g.value);
      setGroupsErr(null);
    } else setGroupsErr(describe(g.reason));
    setLoaded(true);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const run = async (action: "save" | "delete", fn: () => Promise<unknown>) => {
    if (busyRef.current) return false;
    busyRef.current = true;
    setBusy(true);
    try {
      setActionErr(null);
      await fn();
      await load();
      return true;
    } catch (e) {
      setActionErr(`Couldn't ${action}: ${describe(e)}`);
      return false;
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };

  const removePerson = async (id: string) => {
    const affected = groups.filter((g) => g.memberIds.includes(id));
    for (const g of affected) {
      await api.updateGroup(g.id, { name: g.name, memberIds: g.memberIds.filter((m) => m !== id) });
    }
    await api.deletePerson(id);
  };

  const names = useMemo(() => new Map(people.map((p) => [p.id, p.name])), [people]);
  const groupsOf = useMemo(() => {
    const m = new Map<string, Group[]>();
    for (const g of groups) for (const id of g.memberIds) m.set(id, [...(m.get(id) ?? []), g]);
    return m;
  }, [groups]);

  const q = query.trim().toLowerCase();
  const shownPeople = q
    ? people.filter((p) => [p.name, p.role, p.ntfyTopic ?? ""].some((s) => s.toLowerCase().includes(q)))
    : people;
  const shownGroups = q
    ? groups.filter(
        (g) => g.name.toLowerCase().includes(q) || g.memberIds.some((id) => (names.get(id) ?? id).toLowerCase().includes(q)),
      )
    : groups;

  const setTab = (t: Tab) => {
    setQuery("");
    setParams((p) => {
      const n = new URLSearchParams(p);
      if (t === "people") n.delete("tab");
      else n.set("tab", t);
      return n;
    });
  };

  const editPerson = (p: Person) =>
    setPEdit({
      id: p.id,
      draft: { name: p.name, role: p.role, canCreateRules: p.canCreateRules, ntfyTopic: p.ntfyTopic ?? "" },
    });

  return (
    <main className="page people-page">
      <header className="pg-header">
        <div>
          <h1>People &amp; groups</h1>
          <p className="muted pg-intro">Everyone here can sign in and be notified. Rules route alerts to people or groups.</p>
        </div>
      </header>

      <div className="pg-tabs" role="tablist" aria-label="People and groups">
        <button type="button" role="tab" aria-selected={tab === "people"} className="pg-tab" onClick={() => setTab("people")}>
          People <span className="pg-count">{people.length}</span>
        </button>
        <button type="button" role="tab" aria-selected={tab === "groups"} className="pg-tab" onClick={() => setTab("groups")}>
          Groups <span className="pg-count">{groups.length}</span>
        </button>
      </div>

      {!canManage ? (
        <p className="pg-readonly">
          <Icon as={Lock} /> You can view people and groups. Only accounts that can create rules can add, change or delete
          them; you can still edit your own details.
        </p>
      ) : null}
      {actionErr && (
        <p role="alert" className="load-error">
          {actionErr}
        </p>
      )}

      <div className="pg-toolbar">
        <label className="pg-search">
          <Icon as={Search} />
          <input
            type="search"
            aria-label={tab === "people" ? "Search people" : "Search groups"}
            placeholder={tab === "people" ? "Search by name, role or topic" : "Search by group or member"}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </label>
        {canManage ? (
          tab === "people" ? (
            <button type="button" className="btn primary pg-add" onClick={() => setPEdit({ id: null, draft: emptyPerson() })}>
              <Icon as={Plus} /> Add person
            </button>
          ) : (
            <button type="button" className="btn primary pg-add" onClick={() => setGEdit({ id: null, draft: emptyGroup() })}>
              <Icon as={Plus} /> Add group
            </button>
          )
        ) : null}
      </div>

      {tab === "people" ? (
        <section aria-label="People list">
          {peopleErr && (
            <p role="alert" className="load-error">
              Couldn't load people ({peopleErr})
            </p>
          )}
          {!peopleErr && loaded && people.length === 0 && <p className="muted pg-empty">No people yet.</p>}
          {people.length > 0 && (
            <div className="pg-table-wrap">
              <table aria-label="People" className="pg-table">
                <thead>
                  <tr>
                    <th>Name</th>
                    <th>Role</th>
                    <th>Permission</th>
                    <th>Groups</th>
                    <th>Phone topic</th>
                    <th>
                      <span className="sr-only">Actions</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {shownPeople.map((p) => {
                    const mine = me?.id === p.id;
                    return (
                      <tr key={p.id}>
                        <td>
                          <span className="pg-name">
                            <Avatar name={p.name} />
                            <span>{p.name}</span>
                            {mine ? <span className="pg-you">You</span> : null}
                          </span>
                        </td>
                        <td>{p.role}</td>
                        <td>
                          <span className={p.canCreateRules ? "pg-badge editor" : "pg-badge"}>
                            {p.canCreateRules ? "Creates rules" : "Viewer"}
                          </span>
                        </td>
                        <td>
                          <span className="pg-chips">
                            {(groupsOf.get(p.id) ?? []).map((g) => (
                              <span key={g.id} className="pg-chip">
                                {g.name}
                              </span>
                            ))}
                          </span>
                        </td>
                        <td className="mono">{p.ntfyTopic || <span className="muted">—</span>}</td>
                        <td>
                          <RowActions>
                            {canManage || mine ? (
                              <IconButton label={`Edit ${p.name}`} onClick={() => editPerson(p)}>
                                <Icon as={Pencil} />
                              </IconButton>
                            ) : null}
                            {canManage ? (
                              <IconButton
                                label={`Delete ${p.name}`}
                                danger
                                disabled={busy || Boolean(groupsErr)}
                                title={groupsErr ? "Groups failed to load; reload before deleting" : undefined}
                                onClick={() => {
                                  if (window.confirm(`Delete ${p.name}?`)) void run("delete", () => removePerson(p.id));
                                }}
                              >
                                <Icon as={Trash2} />
                              </IconButton>
                            ) : null}
                          </RowActions>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              {shownPeople.length === 0 ? <p className="muted pg-empty">No one matches “{query}”.</p> : null}
            </div>
          )}
        </section>
      ) : (
        <section aria-label="Groups list">
          {groupsErr && (
            <p role="alert" className="load-error">
              Couldn't load groups ({groupsErr})
            </p>
          )}
          {!groupsErr && loaded && groups.length === 0 && <p className="muted pg-empty">No groups yet.</p>}
          {groups.length > 0 && (
            <div className="pg-table-wrap">
              <table aria-label="Groups" className="pg-table">
                <thead>
                  <tr>
                    <th>Name</th>
                    <th>Members</th>
                    <th>
                      <span className="sr-only">Actions</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {shownGroups.map((g) => {
                    const memberNames = g.memberIds.map((id) => names.get(id) ?? `unknown (${id})`);
                    return (
                      <tr key={g.id}>
                        <td>
                          <span className="pg-name">
                            <span className="pg-avatar pg-avatar-md pg-group-icon" aria-hidden="true">
                              <Icon as={Users} />
                            </span>
                            <span>{g.name}</span>
                          </span>
                        </td>
                        <td>
                          <span className="pg-members">
                            <span className="pg-stack" aria-hidden="true">
                              {memberNames.slice(0, 5).map((n, i) => (
                                <Avatar key={i} name={n} size="sm" />
                              ))}
                            </span>
                            <span>{memberNames.length === 0 ? <span className="muted">No members</span> : memberNames.join(", ")}</span>
                          </span>
                        </td>
                        <td>
                          {canManage ? (
                            <RowActions>
                              <IconButton
                                label={`Edit group ${g.name}`}
                                onClick={() => setGEdit({ id: g.id, draft: { name: g.name, memberIds: g.memberIds } })}
                              >
                                <Icon as={Pencil} />
                              </IconButton>
                              <IconButton
                                label={`Delete group ${g.name}`}
                                danger
                                disabled={busy}
                                onClick={() => {
                                  if (window.confirm(`Delete group ${g.name}?`)) void run("delete", () => api.deleteGroup(g.id));
                                }}
                              >
                                <Icon as={Trash2} />
                              </IconButton>
                            </RowActions>
                          ) : null}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              {shownGroups.length === 0 ? <p className="muted pg-empty">No group matches “{query}”.</p> : null}
            </div>
          )}
        </section>
      )}

      {pEdit && (
        <Drawer title={pEdit.id ? `Edit ${pEdit.draft.name}` : "Add person"} onClose={() => setPEdit(null)}>
          <PersonForm
            key={pEdit.id ?? "new"}
            initial={pEdit.draft}
            busy={busy}
            canGrant={canManage}
            onCancel={() => setPEdit(null)}
            onSave={async (d) => {
              const body = personPayload(d);
              const ok = await run("save", () => (pEdit.id ? api.updatePerson(pEdit.id, body) : api.createPerson(body)));
              if (ok) setPEdit(null);
            }}
          />
        </Drawer>
      )}
      {gEdit && (
        <Drawer title={gEdit.id ? `Edit group ${gEdit.draft.name}` : "Add group"} onClose={() => setGEdit(null)}>
          <GroupForm
            key={gEdit.id ?? "new"}
            initial={gEdit.draft}
            busy={busy}
            people={people}
            onCancel={() => setGEdit(null)}
            onSave={async (d) => {
              const body = groupPayload(d);
              const ok = await run("save", () => (gEdit.id ? api.updateGroup(gEdit.id, body) : api.createGroup(body)));
              if (ok) setGEdit(null);
            }}
          />
        </Drawer>
      )}
    </main>
  );
}

function RowActions({ children }: { children: ReactNode }) {
  return <div className="pg-actions">{children}</div>;
}

function IconButton(props: {
  label: string;
  onClick(): void;
  children: ReactNode;
  danger?: boolean;
  disabled?: boolean;
  title?: string;
}) {
  return (
    <button
      type="button"
      className={props.danger ? "pg-icon-btn danger" : "pg-icon-btn"}
      aria-label={props.label}
      title={props.title ?? props.label}
      disabled={props.disabled}
      onClick={props.onClick}
    >
      {props.children}
    </button>
  );
}

/** Grafana-style side drawer for the forms. */
function Drawer({ title, onClose, children }: { title: string; onClose(): void; children: ReactNode }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div className="pg-drawer-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <aside className="pg-drawer" role="dialog" aria-label={title}>
        <header className="pg-drawer-head">
          <h2>{title}</h2>
          <button type="button" className="pg-icon-btn" aria-label="Close" onClick={onClose}>
            <Icon as={X} />
          </button>
        </header>
        <div className="pg-drawer-body">{children}</div>
      </aside>
    </div>
  );
}

function FieldError({ msg }: { msg?: string }) {
  return msg ? (
    <span className="field-error" role="alert">
      {msg}
    </span>
  ) : null;
}

function PersonForm(props: {
  initial: PersonDraft;
  busy: boolean;
  canGrant: boolean;
  onSave: (d: PersonDraft) => void;
  onCancel: () => void;
}) {
  const [d, setD] = useState(props.initial);
  const [errs, setErrs] = useState<Errors>({});
  return (
    <form
      aria-label="Person form"
      noValidate
      onSubmit={(ev) => {
        ev.preventDefault();
        const e = validatePerson(d);
        setErrs(e);
        if (Object.keys(e).length === 0) props.onSave(d);
      }}
    >
      <label>
        Name
        <input type="text" autoFocus value={d.name} onChange={(e) => setD({ ...d, name: e.target.value })} />
      </label>
      <FieldError msg={errs.name} />
      <label>
        Role
        <input type="text" value={d.role} onChange={(e) => setD({ ...d, role: e.target.value })} />
      </label>
      <FieldError msg={errs.role} />
      <label>
        Phone topic (ntfy)
        <input
          type="text"
          className="mono"
          value={d.ntfyTopic ?? ""}
          onChange={(e) => setD({ ...d, ntfyTopic: e.target.value })}
        />
      </label>
      <span className="muted pg-help">Alerts are pushed to this ntfy topic on the person's phone.</span>
      <FieldError msg={errs.ntfyTopic} />
      <label className="check pg-perm">
        <input
          type="checkbox"
          checked={d.canCreateRules}
          disabled={!props.canGrant}
          onChange={(e) => setD({ ...d, canCreateRules: e.target.checked })}
        />
        <span>
          Can create rules
          <span className="muted pg-help">
            {props.canGrant
              ? "Also lets them add, change and delete people and groups."
              : "Only accounts that can create rules can change this."}
          </span>
        </span>
      </label>
      <div className="pg-form-actions">
        <button type="submit" className="btn primary" disabled={props.busy}>
          Save
        </button>
        <button type="button" className="btn" onClick={props.onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}

function GroupForm(props: {
  initial: GroupDraft;
  busy: boolean;
  people: Person[];
  onSave: (d: GroupDraft) => void;
  onCancel: () => void;
}) {
  const [d, setD] = useState(props.initial);
  const [errs, setErrs] = useState<Errors>({});
  return (
    <form
      aria-label="Group form"
      noValidate
      onSubmit={(ev) => {
        ev.preventDefault();
        const e = validateGroup(d);
        setErrs(e);
        if (Object.keys(e).length === 0) props.onSave(d);
      }}
    >
      <label>
        Group name
        <input type="text" autoFocus value={d.name} onChange={(e) => setD({ ...d, name: e.target.value })} />
      </label>
      <FieldError msg={errs.name} />
      <fieldset>
        <legend>
          Members <span className="muted">({d.memberIds.length} selected)</span>
        </legend>
        {props.people.length === 0 && <span className="muted">No people available.</span>}
        <div className="pg-member-list">
          {props.people.map((p) => (
            <label key={p.id} className="check pg-member">
              <input
                type="checkbox"
                checked={d.memberIds.includes(p.id)}
                onChange={() => setD({ ...d, memberIds: toggleMember(d.memberIds, p.id) })}
              />
              <Avatar name={p.name} size="sm" />
              <span>{p.name}</span>
              <span className="muted pg-member-role">{p.role}</span>
            </label>
          ))}
        </div>
      </fieldset>
      <div className="pg-form-actions">
        <button type="submit" className="btn primary" disabled={props.busy}>
          Save
        </button>
        <button type="button" className="btn" onClick={props.onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}
