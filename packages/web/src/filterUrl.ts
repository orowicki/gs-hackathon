/** Returns search params with `q` set to `value`, or removed when the value is empty. */
export function withFilter(params: URLSearchParams, value: string): URLSearchParams {
  const next = new URLSearchParams(params);
  if (value === "") next.delete("q");
  else next.set("q", value);
  return next;
}
