export type JsonSchema = {
  type?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema;
  enum?: unknown[];
  description?: string;
  [key: string]: unknown;
};

export function defineToolParameters(schema: JsonSchema): JsonSchema {
  return schema;
}
