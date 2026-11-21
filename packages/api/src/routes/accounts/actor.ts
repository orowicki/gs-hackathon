import type http from "node:http";

/** The signed-in account of a request (session cookie or X-Account), set once by the accounts hook. */
export interface Account {
  id: string;
  canCreateRules: boolean;
}

const accounts = new WeakMap<http.IncomingMessage, Account>();

export function setAccount(req: http.IncomingMessage, account: Account): void {
  accounts.set(req, account);
}

export function accountOf(req: http.IncomingMessage): Account | undefined {
  return accounts.get(req);
}

/** True when the request has an account that may not create or edit rules. */
export function ruleWriteForbidden(req: http.IncomingMessage): boolean {
  const a = accounts.get(req);
  return a !== undefined && !a.canCreateRules;
}

const failed = new WeakSet<http.IncomingMessage>();

/** Record that the account lookup of this request failed (writes must then fail closed). */
export function markLookupFailed(req: http.IncomingMessage): void {
  failed.add(req);
}

export function lookupFailed(req: http.IncomingMessage): boolean {
  return failed.has(req);
}
