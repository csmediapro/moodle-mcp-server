import { z } from "zod";

/**
 * Minimal Zod → JSON Schema converter.
 *
 * Only handles the subset of Zod we use for tool input schemas:
 * - z.object() with primitive fields (string, number, boolean, enum)
 * - .optional(), .default(), .describe()
 * - .int(), .min(), .max()
 *
 * Full zod-to-json-schema would be overkill for our constrained use case.
 */
export function zodToJsonSchema(
  schema: z.ZodTypeAny
): {
  type: "object";
  properties: Record<string, object>;
  required?: string[];
} {
  const root = unwrapToBaseSchema(schema);

  if (!(root instanceof z.ZodObject)) {
    return { type: "object", properties: {} };
  }

  const shape = root.shape;
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
  schema: z.ZodTypeAny,
  options?: { onOptionalOrDefault?: () => void }
): z.ZodTypeAny {
  let current = schema;

  while (true) {
    if (current instanceof z.ZodOptional) {
      options?.onOptionalOrDefault?.();
      current = current.unwrap();
      continue;
    }

    if (current instanceof z.ZodDefault) {
      options?.onOptionalOrDefault?.();
      current = (current as unknown as { _def: { innerType: z.ZodTypeAny } })._def.innerType;
      continue;
    }

    if (current instanceof z.ZodEffects) {
      current = current.innerType();
      continue;
    }

    return current;
  }
}

function buildPrimitiveSchema(
  field: z.ZodTypeAny,
  description?: string
): object {
  if (field instanceof z.ZodNumber) {
    const schema: Record<string, unknown> = { type: "number" };
    if (description) schema.description = description;

    const checks = (field as unknown as {
      _def: { checks?: Array<{ kind: string; value?: number }> };
    })._def.checks ?? [];

    for (const check of checks) {
      if (check.kind === "int") schema.type = "integer";
      if (check.kind === "min") schema.minimum = check.value;
      if (check.kind === "max") schema.maximum = check.value;
    }

    return schema;
  }

  if (field instanceof z.ZodString) {
    return {
      type: "string",
      ...(description ? { description } : {}),
    };
  }

  if (field instanceof z.ZodBoolean) {
    return {
      type: "boolean",
      ...(description ? { description } : {}),
    };
  }

  if (field instanceof z.ZodEnum) {
    return {
      type: "string",
      enum: field.options,
      ...(description ? { description } : {}),
    };
  }

  return {
    type: "string",
    ...(description ? { description } : {}),
  };
}
