export { matchSchema, classifyEvent, compileMatch } from "./classify.js";
export type { Classification, SchemaErrorHandler } from "./classify.js";
export { mapCommonFields, getPath } from "./map.js";
export {
  normaliseValue,
  normaliseDeep,
  normaliseTimestamp,
  normaliseSeverity,
  normaliseStatus,
} from "./normalise.js";
export { createSchemaRegistry } from "./registry.js";
export type { SchemaRegistry, RegistryOptions } from "./registry.js";
export { SCHEMA_COMMON_FIELD_NAMES } from "./types.js";
export type {
  SchemaCommonFields,
  SchemaCommonFieldName,
  SchemaDef,
} from "./types.js";
