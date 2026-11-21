import { useCallback, useEffect, useState } from "react";
import type { Group, Person } from "../../../../shared/src/types/people";
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
  e instanceof api.HttpError ? `HTTP ${e.status}` : e instanceof Error ? e.message : String(e);

type Editing<T> = { id: string | null; draft: T } | null;

export function PeoplePage() {
  const [people, setPeople] = useState<Person[]>([]);
  const [groups, setGroups] = useState<Group[]>([]);
  const [peopleErr, setPeopleErr] = useState<string | null>(null);
  const [groupsErr, setGroupsErr] = useState<string | null>(null);
  const [actionErr, setActionErr] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [pEdit, setPEdit] = useState<Editing<PersonDraft>>(null);
  const [gEdit, setGEdit] = useState<Editing<GroupDraft>>(null);

  const load = useCallback(async () => {
    const [p, g] = await Promise.allSettled([api.listPeople(), api.listGroups()]);
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

  const run = async (fn: () => Promise<unknown>) => {
    try {
      setActionErr(null);
      await fn();
      await load();
      return true;
    } catch (e) {
      setActionErr(`Couldn't save: ${describe(e)}`);
      return false;
    }
  };

  const names = new Map(people.map((p) => [p.id, p.name]));

  return (
    <main className="page people-page">
      <h1>People &amp; groups</h1>
      {actionErr && (
        <p role="alert" className="load-error">
          {actionErr}
        </p>
      )}

      <section aria-labelledby="people-h">
        <div className="section-head">
          <h2 id="people-h">People</h2>
          <button type="button" onClick={() => setPEdit({ id: null, draft: emptyPerson() })}>
            Add person
          </button>
        </div>
        {peopleErr && (
          <p role="alert" className="load-error">
            Couldn't load people ({peopleErr})
          </p>
        )}
        {pEdit && (
          <PersonForm
            key={pEdit.id ?? "new"}
            initial={pEdit.draft}
            onCancel={() => setPEdit(null)}
            onSave={async (d) => {
              const body = personPayload(d);
              const ok = await run(() => (pEdit.id ? api.updatePerson(pEdit.id, body) : api.createPerson(body)));
              if (ok) setPEdit(null);
            }}
          />
        )}
        {!peopleErr && loaded && people.length === 0 && <p className="muted">No people yet.</p>}
        {people.length > 0 && (
          <table aria-label="People">
            <thead>
              <tr>
                <th>Name</th>
                <th>Role</th>
                <th>Can create rules</th>
                <th>ntfy topic</th>
                <th>
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {people.map((p) => (
                <tr key={p.id}>
                  <td>{p.name}</td>
                  <td>{p.role}</td>
                  <td>{p.canCreateRules ? "Yes" : "No"}</td>
                  <td className="mono">{p.ntfyTopic ?? ""}</td>
                  <td>
                    <div className="actions">
                      <button
                        type="button"
                        aria-label={`Edit ${p.name}`}
                        onClick={() =>
                          setPEdit({
                            id: p.id,
                            draft: {
                              name: p.name,
                              role: p.role,
                              canCreateRules: p.canCreateRules,
                              ntfyTopic: p.ntfyTopic ?? "",
                            },
                          })
                        }
                      >
                        Edit
                      </button>
                      <button
                        type="button"
                        aria-label={`Delete ${p.name}`}
                        onClick={() => {
                          if (window.confirm(`Delete ${p.name}?`)) void run(() => api.deletePerson(p.id));
                        }}
                      >
                        Delete
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section aria-labelledby="groups-h">
        <div className="section-head">
          <h2 id="groups-h">Groups</h2>
          <button type="button" onClick={() => setGEdit({ id: null, draft: emptyGroup() })}>
            Add group
          </button>
        </div>
        {groupsErr && (
          <p role="alert" className="load-error">
            Couldn't load groups ({groupsErr})
          </p>
        )}
        {gEdit && (
          <GroupForm
            key={gEdit.id ?? "new"}
            initial={gEdit.draft}
            people={people}
            onCancel={() => setGEdit(null)}
            onSave={async (d) => {
              const body = groupPayload(d);
              const ok = await run(() => (gEdit.id ? api.updateGroup(gEdit.id, body) : api.createGroup(body)));
              if (ok) setGEdit(null);
            }}
          />
        )}
        {!groupsErr && loaded && groups.length === 0 && <p className="muted">No groups yet.</p>}
        {groups.length > 0 && (
          <table aria-label="Groups">
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
              {groups.map((g) => (
                <tr key={g.id}>
                  <td>{g.name}</td>
                  <td>{g.memberIds.map((id) => names.get(id) ?? id).join(", ")}</td>
                  <td>
                    <div className="actions">
                      <button
                        type="button"
                        aria-label={`Edit group ${g.name}`}
                        onClick={() => setGEdit({ id: g.id, draft: { name: g.name, memberIds: g.memberIds } })}
                      >
                        Edit
                      </button>
                      <button
                        type="button"
                        aria-label={`Delete group ${g.name}`}
                        onClick={() => {
                          if (window.confirm(`Delete group ${g.name}?`)) void run(() => api.deleteGroup(g.id));
                        }}
                      >
                        Delete
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </main>
  );
}

function FieldError({ msg }: { msg?: string }) {
  return msg ? (
    <span className="field-error" role="alert">
      {msg}
    </span>
  ) : null;
}

function PersonForm(props: { initial: PersonDraft; onSave: (d: PersonDraft) => void; onCancel: () => void }) {
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
        <input type="text" value={d.name} onChange={(e) => setD({ ...d, name: e.target.value })} />
      </label>
      <FieldError msg={errs.name} />
      <label>
        Role
        <input type="text" value={d.role} onChange={(e) => setD({ ...d, role: e.target.value })} />
      </label>
      <FieldError msg={errs.role} />
      <label className="check">
        <input
          type="checkbox"
          checked={d.canCreateRules}
          onChange={(e) => setD({ ...d, canCreateRules: e.target.checked })}
        />
        Can create rules
      </label>
      <label>
        ntfy topic
        <input
          type="text"
          className="mono"
          value={d.ntfyTopic ?? ""}
          onChange={(e) => setD({ ...d, ntfyTopic: e.target.value })}
        />
      </label>
      <FieldError msg={errs.ntfyTopic} />
      <div className="actions">
        <button type="submit" className="primary">
          Save
        </button>
        <button type="button" onClick={props.onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}

function GroupForm(props: {
  initial: GroupDraft;
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
        <input type="text" value={d.name} onChange={(e) => setD({ ...d, name: e.target.value })} />
      </label>
      <FieldError msg={errs.name} />
      <fieldset>
        <legend>Members</legend>
        {props.people.length === 0 && <span className="muted">No people available.</span>}
        {props.people.map((p) => (
          <label key={p.id} className="check">
            <input
              type="checkbox"
              checked={d.memberIds.includes(p.id)}
              onChange={() => setD({ ...d, memberIds: toggleMember(d.memberIds, p.id) })}
            />
            {p.name}
          </label>
        ))}
      </fieldset>
      <div className="actions">
        <button type="submit" className="primary">
          Save
        </button>
        <button type="button" onClick={props.onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}
