import type { JsonSchema } from '../contracts/tools.js';

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const equal = (left: unknown, right: unknown): boolean => JSON.stringify(left) === JSON.stringify(right);
const typeMatches = (value: unknown, type: string): boolean => {
  switch (type) {
    case 'null': return value === null;
    case 'string': return typeof value === 'string';
    case 'boolean': return typeof value === 'boolean';
    case 'number': return typeof value === 'number' && Number.isFinite(value);
    case 'integer': return typeof value === 'number' && Number.isInteger(value);
    case 'array': return Array.isArray(value);
    case 'object': return isRecord(value);
    default: return false;
  }
};

const pointer = (root: JsonSchema, reference: string): JsonSchema | undefined => {
  if (!reference.startsWith('#/')) return undefined;
  let current: unknown = root;
  for (const raw of reference.slice(2).split('/')) {
    const key = raw.replaceAll('~1', '/').replaceAll('~0', '~');
    if (!isRecord(current) || !Object.hasOwn(current, key)) return undefined;
    current = current[key];
  }
  return isRecord(current) ? current as JsonSchema : undefined;
};

export function jsonSchemaError(value: unknown, schema: JsonSchema, path = '$', root: JsonSchema = schema): string | undefined {
  if (schema.$ref !== undefined) {
    const target = pointer(root, schema.$ref);
    if (target === undefined) return `${path} references unsupported or missing schema ${schema.$ref}`;
    return jsonSchemaError(value, target, path, root);
  }
  if (schema.const !== undefined && !equal(schema.const, value)) return `${path} must equal the declared constant`;
  if (schema.enum && !schema.enum.some((candidate) => equal(candidate, value))) return `${path} is not an allowed value`;
  if (schema.allOf) for (const item of schema.allOf) { const error = jsonSchemaError(value, item, path, root); if (error) return error; }
  if (schema.anyOf && !schema.anyOf.some((item) => jsonSchemaError(value, item, path, root) === undefined)) return `${path} must match at least one schema`;
  if (schema.oneOf && schema.oneOf.filter((item) => jsonSchemaError(value, item, path, root) === undefined).length !== 1) return `${path} must match exactly one schema`;
  if (schema.not && jsonSchemaError(value, schema.not, path, root) === undefined) return `${path} must not match the excluded schema`;
  if (schema.if) {
    const branch = jsonSchemaError(value, schema.if, path, root) === undefined ? schema.then : schema.else;
    if (branch) { const error = jsonSchemaError(value, branch, path, root); if (error) return error; }
  }
  const types = typeof schema.type === 'string' ? [schema.type] : schema.type;
  if (types && !types.some((type) => typeMatches(value, type))) return `${path} must be ${types.join(' or ')}`;
  if (typeof value === 'number' && Number.isFinite(value)) {
    if (schema.minimum !== undefined && value < schema.minimum) return `${path} must be >= ${schema.minimum}`;
    if (schema.maximum !== undefined && value > schema.maximum) return `${path} must be <= ${schema.maximum}`;
    if (schema.exclusiveMinimum !== undefined && value <= schema.exclusiveMinimum) return `${path} must be > ${schema.exclusiveMinimum}`;
    if (schema.exclusiveMaximum !== undefined && value >= schema.exclusiveMaximum) return `${path} must be < ${schema.exclusiveMaximum}`;
    if (schema.multipleOf !== undefined && Math.abs(value / schema.multipleOf - Math.round(value / schema.multipleOf)) > Number.EPSILON) return `${path} must be a multiple of ${schema.multipleOf}`;
  }
  if (typeof value === 'string') {
    const length = [...value].length;
    if (schema.minLength !== undefined && length < schema.minLength) return `${path} must have at least ${schema.minLength} characters`;
    if (schema.maxLength !== undefined && length > schema.maxLength) return `${path} must have at most ${schema.maxLength} characters`;
    if (schema.pattern !== undefined) {
      try { if (!new RegExp(schema.pattern, 'u').test(value)) return `${path} must match ${schema.pattern}`; }
      catch { return `${path} has an invalid schema pattern`; }
    }
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) return `${path} must contain at least ${schema.minItems} items`;
    if (schema.maxItems !== undefined && value.length > schema.maxItems) return `${path} must contain at most ${schema.maxItems} items`;
    if (schema.uniqueItems && value.some((item, index) => value.slice(0, index).some((prior) => equal(item, prior)))) return `${path} must contain unique items`;
    for (const [index, item] of value.entries()) {
      const itemSchema = schema.prefixItems?.[index] ?? schema.items;
      if (itemSchema !== undefined) { const error = jsonSchemaError(item, itemSchema, `${path}[${index}]`, root); if (error) return error; }
    }
    if (schema.contains !== undefined) {
      const count = value.filter((item, index) => jsonSchemaError(item, schema.contains!, `${path}[${index}]`, root) === undefined).length;
      const minimum = schema.minContains ?? 1;
      if (count < minimum || (schema.maxContains !== undefined && count > schema.maxContains)) return `${path} contains ${count} matching items`;
    }
  }
  if (isRecord(value)) {
    const keys = Object.keys(value);
    if (schema.minProperties !== undefined && keys.length < schema.minProperties) return `${path} must contain at least ${schema.minProperties} properties`;
    if (schema.maxProperties !== undefined && keys.length > schema.maxProperties) return `${path} must contain at most ${schema.maxProperties} properties`;
    for (const key of schema.required ?? []) if (!(key in value)) return `${path}.${key} is required`;
    for (const [key, dependencies] of Object.entries(schema.dependentRequired ?? {})) if (key in value) for (const dependency of dependencies) if (!(dependency in value)) return `${path}.${dependency} is required when ${key} is present`;
    for (const key of keys) {
      if (schema.propertyNames) { const error = jsonSchemaError(key, schema.propertyNames, `${path}.${key}`, root); if (error) return error; }
      const direct = schema.properties?.[key];
      const patterns = Object.entries(schema.patternProperties ?? {}).filter(([pattern]) => {
        try { return new RegExp(pattern, 'u').test(key); } catch { return false; }
      }).map(([, item]) => item);
      if (direct !== undefined) { const error = jsonSchemaError(value[key], direct, `${path}.${key}`, root); if (error) return error; }
      for (const item of patterns) { const error = jsonSchemaError(value[key], item, `${path}.${key}`, root); if (error) return error; }
      if (direct === undefined && patterns.length === 0) {
        if (schema.additionalProperties === false) return `${path}.${key} is not allowed`;
        if (typeof schema.additionalProperties === 'object') { const error = jsonSchemaError(value[key], schema.additionalProperties, `${path}.${key}`, root); if (error) return error; }
      }
    }
  }
  return undefined;
}
