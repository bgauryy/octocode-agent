/**
 * Build a TypeBox string-enum schema. Shared by agent-tools and memory tool registration.
 */
export function stringEnumSchema(Type, values, description) {
    return Type.Unsafe({ type: 'string', enum: [...values], description });
}
