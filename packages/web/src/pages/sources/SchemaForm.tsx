import type { JsonSchemaObject, JsonSchemaProperty } from "./sourceTypes";

type Config = Record<string, unknown>;

/** Returns a map of property name -> error message for the given config. */
export function validateConfig(schema: JsonSchemaObject, config: Config): Record<string, string> {
  const errors: Record<string, string> = {};
  const required = new Set(schema.required ?? []);
  for (const [key, prop] of Object.entries(schema.properties)) {
    const v = config[key];
    const empty = v === undefined || v === "" || (typeof v === "number" && Number.isNaN(v));
    if (empty) {
      if (required.has(key)) errors[key] = "This field is required.";
      continue;
    }
    if (typeof v === "string" && prop.minLength !== undefined && v.length < prop.minLength) {
      errors[key] = `Must be at least ${prop.minLength} character${prop.minLength === 1 ? "" : "s"}.`;
    }
  }
  return errors;
}

export function SchemaForm({
  schema,
  value,
  onChange,
  errors = {},
  idPrefix,
}: {
  schema: JsonSchemaObject;
  value: Config;
  onChange: (next: Config) => void;
  errors?: Record<string, string>;
  idPrefix: string;
}) {
  const entries = Object.entries(schema.properties);
  if (entries.length === 0) return <p className="muted">No settings for this source type.</p>;
  const required = new Set(schema.required ?? []);
  const set = (k: string, v: unknown) => {
    const next = { ...value };
    if (v === undefined) delete next[k];
    else next[k] = v;
    onChange(next);
  };

  return (
    <>
      {entries.map(([key, prop]) => {
        const id = `${idPrefix}-${key}`;
        const label = prop.title ?? key;
        const err = errors[key];
        return (
          <div className="field" key={key}>
            <label htmlFor={id}>
              {label}
              {required.has(key) && <span className="req" aria-hidden="true"> *</span>}
            </label>
            {control(id, key, prop, value[key], set, required.has(key), !!err)}
            {prop.description && (
              <span className="hint" id={`${id}-hint`}>
                {prop.description}
              </span>
            )}
            {err && (
              <span className="field-error" role="alert">
                {err}
              </span>
            )}
          </div>
        );
      })}
    </>
  );
}

function control(
  id: string,
  key: string,
  prop: JsonSchemaProperty,
  v: unknown,
  set: (k: string, v: unknown) => void,
  required: boolean,
  invalid: boolean,
) {
  const common = {
    id,
    "aria-invalid": invalid || undefined,
    "aria-required": required || undefined,
    "aria-describedby": prop.description ? `${id}-hint` : undefined,
  };
  if (prop.enum) {
    return (
      <select {...common} value={v === undefined ? "" : String(v)} onChange={(e) => {
        const raw = e.target.value;
        if (raw === "") return set(key, undefined);
        set(key, prop.type === "number" || prop.type === "integer" ? Number(raw) : raw);
      }}>
        {!required && <option value="">(none)</option>}
        {required && v === undefined && <option value="">Choose…</option>}
        {prop.enum.map((o) => (
          <option key={String(o)} value={String(o)}>
            {String(o)}
          </option>
        ))}
      </select>
    );
  }
  if (prop.type === "boolean") {
    return <input {...common} type="checkbox" checked={v === true} onChange={(e) => set(key, e.target.checked)} />;
  }
  if (prop.type === "number" || prop.type === "integer") {
    return (
      <input
        {...common}
        type="number"
        step={prop.type === "integer" ? 1 : "any"}
        value={typeof v === "number" && !Number.isNaN(v) ? v : ""}
        onChange={(e) => set(key, e.target.value === "" ? undefined : Number(e.target.value))}
      />
    );
  }
  return (
    <input
      {...common}
      type="text"
      spellCheck={false}
      autoComplete="off"
      value={typeof v === "string" ? v : ""}
      onChange={(e) => set(key, e.target.value)}
    />
  );
}
