export type I18nPrimitive =
  | string
  | number
  | boolean
  | null;

export type I18nResource =
  | I18nPrimitive
  | {
      [key: string]: I18nResource;
    };

export type I18nValidationResult = {
  valid: boolean;
  errors: string[];
};

function validateNode(
  value: I18nResource,
  path: string,
  errors: string[]
) {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return;
  }

  if (typeof value !== "object" || Array.isArray(value)) {
    errors.push(`Invalid i18n value at "${path}"`);
    return;
  }

  for (const [key, child] of Object.entries(value)) {
    if (!key.trim()) {
      errors.push(`Empty i18n key at "${path}"`);
    }

    validateNode(child, `${path}.${key}`, errors);
  }
}

export function validateI18nResource(
  resource: I18nResource
): I18nValidationResult {
  const errors: string[] = [];

  validateNode(resource, "root", errors);

  return {
    valid: errors.length === 0,
    errors,
  };
}