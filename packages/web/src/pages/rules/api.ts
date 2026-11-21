import type { Rule } from "@alerting/shared";

export interface Suggestion {
  id: string;
  ruleId: string;
  alertId?: string;
  author: string;
  text: string;
  status: string;
  createdAt: string;
}

export interface TestResult {
  matched: number;
  total: number;
  warning?: string;
}

async function errorOf(res: Response): Promise<Error> {
  let msg = `Request failed (${res.status})`;
  try {
    const text = await res.text();
    try {
      const data = JSON.parse(text) as { error?: unknown; message?: unknown };
      if (typeof data.error === "string") msg = data.error;
      else if (typeof data.message === "string") msg = data.message;
      else if (text) msg = text;
    } catch {
      if (text) msg = text;
    }
  } catch {
    /* keep default */
  }
  return new Error(msg);
}

async function send<T>(method: string, url: string, body?: BodyInit, type?: string): Promise<T> {
  const res = await fetch(url, { method, headers: type ? { "content-type": type } : undefined, body });
  if (!res.ok) throw await errorOf(res);
  const text = await res.text();
  return (text.trim() === "" ? undefined : JSON.parse(text)) as T;
}

const jsonBody = (v: unknown) => JSON.stringify(v);

export const listRules = () => send<Rule[]>("GET", "/api/rules");
export const getRule = (id: string) => send<Rule>("GET", "/api/rules/" + encodeURIComponent(id));
export const createRule = (p: Rule) => send<Rule>("POST", "/api/rules", jsonBody(p), "application/json");
export const updateRule = (id: string, p: Rule) =>
  send<Rule>("PUT", "/api/rules/" + encodeURIComponent(id), jsonBody(p), "application/json");
export const testFilter = (filter: string) =>
  send<TestResult>("POST", "/api/events/test-filter", jsonBody({ filter }), "application/json");
export const listSuggestions = (id: string) =>
  send<Suggestion[]>("GET", "/api/rules/" + encodeURIComponent(id) + "/suggestions");
export const acceptSuggestion = (id: string) =>
  send<unknown>("POST", "/api/suggestions/" + encodeURIComponent(id) + "/accept");
export const dismissSuggestion = (id: string) =>
  send<unknown>("POST", "/api/suggestions/" + encodeURIComponent(id) + "/dismiss");
export const importYaml = (yaml: string) => send<Rule>("POST", "/api/rules/import", yaml, "application/yaml");

export async function exportYaml(id: string): Promise<string> {
  const res = await fetch("/api/rules/" + encodeURIComponent(id) + "/export");
  if (!res.ok) throw await errorOf(res);
  return res.text();
}

export function downloadText(name: string, text: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: "application/yaml" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
