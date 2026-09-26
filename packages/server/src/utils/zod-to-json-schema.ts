import { z } from "zod";

/**
 * Minimal Zod → JSON Schema converter.
 *
 * Only handles the subset of Zod we use for tool input schemas:
 * - z.object() with primitive fields (string, number, boolean, enum)
 * - nested z.object() and z.record()
 * - .optional(), .default(), .describe()
 * - .int(), .min(), .max()
 *
 * Full zod-to-json-schema would be overkill for our constrained use case.
 */
export function zodToJsonSchema(
  schema: unknown
): {
  type: "object";
  properties: Record<string, object>;
  required?: string[];
} {
  const nativeJsonSchema = tryNativeJsonSchema(schema);
  if (nativeJsonSchema) {
    return nativeJsonSchema;
  }

  const root = unwrapToBaseSchema(schema);

  if (!isZodObject(root)) {
    return { type: "object", properties: {} };
  }

  const shape = getObjectShape(root) ?? {};
  const required: string[] = [];
  const properties: Record<string, object> = {};

  for (const [key, field] of Object.entries(shape)) {
    const fieldInfo = extractField(field as z.ZodTypeAny);
    properties[key] = fieldInfo.schema;
    if (fieldInfo.required) {
      required.push(key);
    }
  }

  return {
    type: "object",
    properties,
    ...(required.length > 0 ? { required } : {}),
  };
}

interface FieldInfo {
  schema: object;
  required: boolean;
}

function extractField(field: z.ZodTypeAny): FieldInfo {
  let required = true;
  const description = field.description;
  const current = unwrapToBaseSchema(field, {
    onOptionalOrDefault: () => {
      required = false;
    },
  });

  return {
    schema: buildPrimitiveSchema(current, description),
    required,
  };
}

function unwrapToBaseSchema(
  schema: unknown,
  options?: { onOptionalOrDefault?: () => void }
): unknown {
  let current = schema;

  while (true) {
    if (isZodInstance(current, "ZodOptional")) {
      options?.onOptionalOrDefault?.();
      current = typeof (current as { unwrap?: unknown }).unwrap === "function"
        ? (current as { unwrap: () => unknown }).unwrap()
        : getDef(current).innerType;
      continue;
    }

    if (isZodInstance(current, "ZodDefault")) {
      options?.onOptionalOrDefault?.();
      current = getDef(current).innerType;
      continue;
    }

    if (isZodInstance(current, "ZodEffects")) {
      current = typeof (current as { innerType?: unknown }).innerType === "function"
        ? (current as { innerType: () => unknown }).innerType()
        : getDef(current).schema;
      continue;
    }

    if (isZodInstance(current, "ZodNullable")) {
      current = typeof (current as { unwrap?: unknown }).unwrap === "function"
        ? (current as { unwrap: () => unknown }).unwrap()
        : getDef(current).innerType;
      continue;
    }

    return current;
  }
}

function buildPrimitiveSchema(
  field: unknown,
  description?: string
): object {
  if (isZodObject(field)) {
    const nestedRequired: string[] = [];
    const properties: Record<string, object> = {};

    for (const [key, nestedField] of Object.entries(getObjectShape(field) ?? {})) {
      const fieldInfo = extractField(nestedField as z.ZodTypeAny);
      properties[key] = fieldInfo.schema;
      if (fieldInfo.required) {
        nestedRequired.push(key);
      }
    }

    return {
      type: "object",
      properties,
      ...(nestedRequired.length > 0 ? { required: nestedRequired } : {}),
      ...(description ? { description } : {}),
    };
  }

  if (isZodInstance(field, "ZodRecord")) {
    const valueType = getDef(field).valueType;

    return {
      type: "object",
      additionalProperties: buildPrimitiveSchema(
        unwrapToBaseSchema(valueType),
        valueType.description,
      ),
      ...(description ? { description } : {}),
    };
  }

  if (isZodInstance(field, "ZodNumber")) {
    const schema: Record<string, unknown> = { type: "number" };
    if (description) schema.description = description;

    const checks = getDef(field).checks ?? [];

    for (const check of checks) {
      if (check.kind === "int") schema.type = "integer";
      if (check.kind === "min") schema.minimum = check.value;
      if (check.kind === "max") schema.maximum = check.value;
    }

    return schema;
  }

  if (isZodInstance(field, "ZodString")) {
    return {
      type: "string",
      ...(description ? { description } : {}),
    };
  }

  if (isZodInstance(field, "ZodBoolean")) {
    return {
      type: "boolean",
      ...(description ? { description } : {}),
    };
  }

  if (isZodInstance(field, "ZodEnum")) {
    const options = (field as { options?: unknown }).options;
    return {
      type: "string",
      ...(Array.isArray(options) ? { enum: options } : {}),
      ...(description ? { description } : {}),
    };
  }

  return {
    type: "string",
    ...(description ? { description } : {}),
  };
}

function tryNativeJsonSchema(
  schema: unknown,
): {
  type: "object";
  properties: Record<string, object>;
  required?: string[];
} | null {
  if (!schema || typeof schema !== "object") return null;

  const toJSONSchema = (schema as { toJSONSchema?: unknown }).toJSONSchema;
  if (typeof toJSONSchema !== "function") return null;

  try {
    const raw = toJSONSchema.call(schema) as Record<string, unknown>;
    if (!raw || raw.type !== "object") return null;

    const { $schema: _schema, ...rest } = raw;
    const properties = rest.properties && typeof rest.properties === "object" && !Array.isArray(rest.properties)
      ? rest.properties as Record<string, object>
      : {};
    const requiredFromSchema = getRequiredKeys(schema);
    const required = requiredFromSchema ??
      (Array.isArray(rest.required)
        ? rest.required.filter((key): key is string => typeof key === "string")
        : undefined);

    return {
      ...rest,
      type: "object",
      properties,
      ...(required && required.length > 0 ? { required } : {}),
    } as {
      type: "object";
      properties: Record<string, object>;
      required?: string[];
    };
  } catch {
    return null;
  }
}

function isZodInstance(schema: unknown, ctorName: string): boolean {
  const ctor = (z as unknown as Record<string, unknown>)[ctorName];
  return typeof ctor === "function" && schema instanceof ctor;
}

function isZodObject(schema: unknown): boolean {
  return isZodInstance(schema, "ZodObject") || getZodType(schema) === "object" || getZodType(schema) === "ZodObject";
}

function getObjectShape(schema: unknown): Record<string, unknown> | null {
  if (!schema || typeof schema !== "object") return null;

  const directShape = (schema as { shape?: unknown }).shape;
  if (directShape && typeof directShape === "object" && !Array.isArray(directShape)) {
    return directShape as Record<string, unknown>;
  }

  const defShape = getDef(schema).shape;
  if (typeof defShape === "function") {
    const shape = defShape();
    return shape && typeof shape === "object" && !Array.isArray(shape)
      ? shape as Record<string, unknown>
      : null;
  }

  return defShape && typeof defShape === "object" && !Array.isArray(defShape)
    ? defShape as Record<string, unknown>
    : null;
}

function getDef(schema: unknown): Record<string, any> {
  if (!schema || typeof schema !== "object") return {};
  const value = schema as { _def?: unknown; def?: unknown };
  if (value._def && typeof value._def === "object") return value._def as Record<string, any>;
  if (value.def && typeof value.def === "object") return value.def as Record<string, any>;
  return {};
}

function getZodType(schema: unknown): string | undefined {
  if (!schema || typeof schema !== "object") return undefined;
  const def = getDef(schema);
  const directType = (schema as { type?: unknown }).type;
  return typeof def.typeName === "string"
    ? def.typeName
    : typeof def.type === "string"
      ? def.type
      : typeof directType === "string"
        ? directType
        : undefined;
}

function getRequiredKeys(schema: unknown): string[] | undefined {
  const shape = getObjectShape(schema);
  if (!shape) return undefined;
  return Object.entries(shape)
    .filter(([, field]) => isRequiredField(field))
    .map(([key]) => key);
}

function isRequiredField(field: unknown): boolean {
  let current = field;

  while (true) {
    if (isOptionalSchema(current) || isDefaultSchema(current)) {
      return false;
    }

    if (isNullableSchema(current) || isEffectsSchema(current)) {
      const next = unwrapInnerSchema(current);
      if (next && next !== current) {
        current = next;
        continue;
      }
    }

    return true;
  }
}

function isOptionalSchema(schema: unknown): boolean {
  return isZodInstance(schema, "ZodOptional") || getZodType(schema) === "optional" || getZodType(schema) === "ZodOptional";
}

function isDefaultSchema(schema: unknown): boolean {
  return isZodInstance(schema, "ZodDefault") || getZodType(schema) === "default" || getZodType(schema) === "ZodDefault";
}

function isNullableSchema(schema: unknown): boolean {
  return isZodInstance(schema, "ZodNullable") || getZodType(schema) === "nullable" || getZodType(schema) === "ZodNullable";
}

function isEffectsSchema(schema: unknown): boolean {
  return isZodInstance(schema, "ZodEffects") || getZodType(schema) === "pipe" || getZodType(schema) === "ZodEffects" || getZodType(schema) === "ZodPipe";
}

function unwrapInnerSchema(schema: unknown): unknown {
  if (!schema || typeof schema !== "object") return undefined;
  if (typeof (schema as { unwrap?: unknown }).unwrap === "function") {
    return (schema as { unwrap: () => unknown }).unwrap();
  }

  const def = getDef(schema);
  return def.innerType ?? def.schema ?? def.in ?? undefined;
}
