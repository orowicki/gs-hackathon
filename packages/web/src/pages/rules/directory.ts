import { useEffect, useState } from "react";

export interface DirEntry {
  type: "person" | "group";
  id: string;
  name: string;
  detail?: string;
}

export interface Directory {
  entries: DirEntry[];
  channels: string[];
  /** False when people/groups couldn't be loaded; the editor falls back to typed ids. */
  ok: boolean;
}

async function get<T>(url: string): Promise<T> {
  const r = await fetch(url);
  if (!r.ok) throw new Error(String(r.status));
  return (await r.json()) as T;
}

/** People, groups and channels for the recipient picker. */
export function useDirectory(): Directory {
  const [dir, setDir] = useState<Directory>({ entries: [], channels: ["ui", "ntfy"], ok: false });
  useEffect(() => {
    let live = true;
    Promise.allSettled([
      get<{ id: string; name: string; role?: string }[]>("/api/people"),
      get<{ id: string; name: string; memberIds?: string[] }[]>("/api/groups"),
      get<{ id: string }[]>("/api/channels"),
    ]).then(([people, groups, channels]) => {
      if (!live) return;
      const entries: DirEntry[] = [];
      if (groups.status === "fulfilled" && Array.isArray(groups.value))
        for (const g of groups.value)
          entries.push({ type: "group", id: g.id, name: g.name, detail: `${g.memberIds?.length ?? 0} members` });
      if (people.status === "fulfilled" && Array.isArray(people.value))
        for (const p of people.value) entries.push({ type: "person", id: p.id, name: p.name, detail: p.role });
      const chans =
        channels.status === "fulfilled" && Array.isArray(channels.value)
          ? channels.value.map((c) => c.id).filter((x): x is string => typeof x === "string")
          : [];
      setDir({
        entries,
        channels: chans.length > 0 ? chans : ["ui", "ntfy"],
        ok: people.status === "fulfilled" || groups.status === "fulfilled",
      });
    });
    return () => {
      live = false;
    };
  }, []);
  return dir;
}
