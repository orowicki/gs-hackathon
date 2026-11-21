import type { Person } from "@alerting/shared";
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { wantsMock } from "./pages/feed/data";
import { MOCK_PEOPLE } from "./pages/feed/mockSource";

/**
 * The signed-in account (a Person). With a backend it is the server session (httpOnly cookie);
 * without one (or with ?mock=1) it is kept in this browser and the mock people sign in freely.
 * Accounts never have passwords.
 */
export type AccountState =
  | { status: "loading" }
  | { status: "signedOut"; mock: boolean }
  | { status: "signedIn"; mock: boolean; person: Person };

export interface AccountApi {
  state: AccountState;
  /** Everyone who can sign in (and be shown by name). */
  people: Person[];
  /** Display name for a person id ("system" and unknown ids are shown as they are). */
  nameOf(id: string | undefined | null): string;
  signIn(personId: string): Promise<void>;
  signUp(name: string, role: string): Promise<void>;
  signOut(): Promise<void>;
}

/** Same key the feed, My notifications and starred filters read: they follow the account. */
const PROFILE_KEY = "alerting.profile";
const MOCK_SESSION_KEY = "alerting.mockSession";
const MOCK_PEOPLE_KEY = "alerting.mockPeople";

function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
function write(key: string, value: string | null): void {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    /* private window: the session still works until reload */
  }
}

function mockPeople(): Person[] {
  try {
    const extra = JSON.parse(read(MOCK_PEOPLE_KEY) ?? "[]") as Person[];
    return [...MOCK_PEOPLE, ...extra];
  } catch {
    return MOCK_PEOPLE;
  }
}

async function errorText(r: Response): Promise<string> {
  try {
    const d = (await r.json()) as { error?: unknown };
    if (typeof d.error === "string" && d.error) return d.error;
  } catch {
    /* not JSON */
  }
  return `Request failed (${r.status})`;
}

export function slugId(name: string): string {
  const base = name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return base || "person";
}

const Ctx = createContext<AccountApi | null>(null);

export function AccountProvider({ children, search = window.location.search }: { children: ReactNode; search?: string }) {
  const [state, setState] = useState<AccountState>({ status: "loading" });
  const [people, setPeople] = useState<Person[]>([]);

  const enter = useCallback((person: Person, mock: boolean) => {
    write(PROFILE_KEY, JSON.stringify(person.id));
    setState({ status: "signedIn", mock, person });
  }, []);

  useEffect(() => {
    let live = true;
    const startMock = async () => {
      // A people list from the server (or a test's mock of it) wins over the built-in demo people.
      const served = await fetch("/api/people")
        .then(async (r) =>
          r.ok && (r.headers.get("content-type") ?? "").includes("application/json") ? ((await r.json()) as Person[]) : null,
        )
        .catch(() => null);
      if (!live) return;
      const list = served && served.length > 0 ? served : mockPeople();
      setPeople(list);
      const stored = read(MOCK_SESSION_KEY);
      let profile: string | null = null;
      try {
        profile = JSON.parse(read(PROFILE_KEY) ?? "null") as string | null;
      } catch {
        profile = read(PROFILE_KEY);
      }
      // In mock mode you start signed in (as your last profile, else the first person), unless you signed out.
      const id = stored === null ? (list.some((p) => p.id === profile) ? profile : list[0]?.id) : stored;
      const person = list.find((p) => p.id === id);
      if (person) enter(person, true);
      else setState({ status: "signedOut", mock: true });
    };
    if (wantsMock(search)) {
      void startMock();
      return () => {
        live = false;
      };
    }
    (async () => {
      let r: Response;
      try {
        r = await fetch("/api/session");
      } catch {
        if (live) void startMock();
        return;
      }
      const isJson = (r.headers.get("content-type") ?? "").includes("application/json");
      if ((r.status !== 200 && r.status !== 401) || (r.status === 200 && !isJson)) {
        // No API behind this server (static preview, proxy error): mock mode.
        if (live) void startMock();
        return;
      }
      const list = await fetch("/api/people")
        .then((p) => (p.ok ? (p.json() as Promise<Person[]>) : []))
        .catch(() => [] as Person[]);
      if (!live) return;
      setPeople(list);
      if (r.status === 200) enter((await r.json()) as Person, false);
      else setState({ status: "signedOut", mock: false });
    })();
    return () => {
      live = false;
    };
  }, [search, enter]);

  const mock = state.status !== "loading" && state.mock;

  const signIn = useCallback(
    async (personId: string) => {
      if (mock) {
        const person = people.find((p) => p.id === personId);
        if (!person) throw new Error("No such account.");
        write(MOCK_SESSION_KEY, person.id);
        enter(person, true);
        return;
      }
      const r = await fetch("/api/session", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ personId }),
      });
      if (!r.ok) throw new Error(await errorText(r));
      enter((await r.json()) as Person, false);
    },
    [mock, people, enter],
  );

  const signUp = useCallback(
    async (name: string, role: string) => {
      const clean = name.trim();
      if (!clean) throw new Error("Enter your name.");
      if (mock) {
        let id = slugId(clean);
        while (people.some((p) => p.id === id)) id += "-2";
        const person: Person = { id, name: clean, role: role.trim(), canCreateRules: false } as Person;
        const extra = mockPeople().filter((p) => !MOCK_PEOPLE.some((m) => m.id === p.id));
        write(MOCK_PEOPLE_KEY, JSON.stringify([...extra, person]));
        setPeople((cur) => [...cur, person]);
        write(MOCK_SESSION_KEY, person.id);
        enter(person, true);
        return;
      }
      const r = await fetch("/api/accounts", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: clean, ...(role.trim() ? { role: role.trim() } : {}) }),
      });
      if (!r.ok) throw new Error(await errorText(r));
      const person = (await r.json()) as Person;
      setPeople((cur) => [...cur.filter((p) => p.id !== person.id), person]);
      await signIn(person.id);
    },
    [mock, people, enter, signIn],
  );

  const signOut = useCallback(async () => {
    if (mock) write(MOCK_SESSION_KEY, "");
    else await fetch("/api/session", { method: "DELETE" }).catch(() => undefined);
    write(PROFILE_KEY, null);
    setState({ status: "signedOut", mock });
  }, [mock]);

  const nameOf = useCallback(
    (id: string | undefined | null) => {
      if (!id) return "unknown";
      return people.find((p) => p.id === id)?.name ?? id;
    },
    [people],
  );

  const api = useMemo<AccountApi>(
    () => ({ state, people, nameOf, signIn, signUp, signOut }),
    [state, people, nameOf, signIn, signUp, signOut],
  );
  return <Ctx.Provider value={api}>{children}</Ctx.Provider>;
}

/** Account context; outside a provider (tests, isolated pages) it reads as signed out with no people. */
export function useAccount(): AccountApi {
  const v = useContext(Ctx);
  if (v) return v;
  return {
    state: { status: "signedOut", mock: true },
    people: [],
    nameOf: (id) => id ?? "unknown",
    signIn: async () => undefined,
    signUp: async () => undefined,
    signOut: async () => undefined,
  };
}

/** The signed-in person, or null. */
export function useCurrentPerson(): Person | null {
  const { state } = useAccount();
  return state.status === "signedIn" ? state.person : null;
}
