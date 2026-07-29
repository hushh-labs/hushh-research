type I18nValidationIssue = {
  path: string;
  reason: string;
};

type I18nValidationResult = {
  valid: boolean;
  issues: I18nValidationIssue[];
};

const BLOCKED_KEYS = new Set(["__proto__", "prototype", "constructor"]);

function isSuspiciousString(value: string) {
  return /<script|javascript:|onerror=|onload=|eval\(|Function\(/i.test(value);
}

export function validateZeroTrustI18nResource(
  resource: unknown,
  path = "root"
): I18nValidationResult {
  const issues: I18nValidationIssue[] = [];

  const visit = (value: unknown, currentPath: string) => {
    if (value === null) {
      return;
    }

    if (typeof value === "string") {
      if (isSuspiciousString(value)) {
        issues.push({
          path: currentPath,
          reason: "Suspicious executable-looking translation value",
        });
      }

      return;
    }

    if (typeof value === "number" || typeof value === "boolean") {
      return;
    }

    if (Array.isArray(value)) {
      value.forEach((item, index) => {
        visit(item, `${currentPath}[${index}]`);
      });

      return;
    }

    if (typeof value === "object") {
      for (const [key, nestedValue] of Object.entries(value)) {
        if (BLOCKED_KEYS.has(key)) {
          issues.push({
            path: `${currentPath}.${key}`,
            reason: "Blocked prototype-pollution-sensitive key",
          });

          continue;
        }

        visit(nestedValue, `${currentPath}.${key}`);
      }

      return;
    }

    issues.push({
      path: currentPath,
      reason: `Unsupported i18n resource value type: ${typeof value}`,
    });
  };

  visit(resource, path);

  return {
    valid: issues.length === 0,
    issues,
  };
}

export function assertZeroTrustI18nResource(resource: unknown) {
  const result = validateZeroTrustI18nResource(resource);

  if (!result.valid) {
    throw new Error(
      `Invalid i18n resource: ${result.issues
        .map((issue) => `${issue.path} ${issue.reason}`)
        .join("; ")}`
    );
  }

  return resource;
}