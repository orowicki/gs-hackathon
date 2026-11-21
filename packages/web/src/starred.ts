import type { StarredFilter } from "@alerting/shared";
import { useCallback, useEffect, useState } from "react";
import { filterText, newStarred } from "./pages/feed/helpers";

const PROFILE_KEY = "alerting.profile";
const url = (id: string) => "/api/people/" + encodeURIComponent(id) + "/starred-filters";

function storedProfile(): string | null {
  try {
    const raw = localStorage.getItem(PROFILE_KEY);
    return raw ? (JSON.parse(raw) as string) : null;
  } catch {
    return null;
  }
}

/**
 * The current profile's starred filters, for filter bars outside the feed (the rule
 * editor). Same profile and same API as the feed, so a star made in one place shows
 * in the other.
 */
export function useStarredFilters(): { texts: string[]; toggle: (text: string) => void } {
  const [personId, setPersonId] = useState<string | null>(null);
  const [list, setList] = useState<StarredFilter[]>([]);

  useEffect(() => {
    let live = true;
    (async () => {
      let id = storedProfile();
      if (!id) {
        const r = await fetch("/api/people");
        const people = r.ok ? ((await r.json()) as { id: string }[]) : [];
        id = people[0]?.id ?? null;
      }
      if (!id || !live) return;
      setPersonId(id);
      const r = await fetch(url(id));
      if (r.ok && live) setList((await r.json()) as StarredFilter[]);
    })().catch(() => undefined);
    return () => {
      live = false;
    };
  }, []);

  const toggle = useCallback(
    (text: string) => {
      if (!personId || text.trim() === "") return;
      setList((cur) => {
        const hit = cur.find((s) => s.name === text || filterText(s.filter) === text);
        const next = hit ? cur.filter((s) => s !== hit) : [...cur, newStarred(personId, text)];
        void fetch(url(personId), {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(next),
        }).catch(() => undefined);
        return next;
      });
    },
    [personId],
  );

  return { texts: list.map((s) => filterText(s.filter)), toggle };
}
