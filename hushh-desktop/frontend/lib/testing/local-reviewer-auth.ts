"use client";

export type LocalReviewerCredentials = {
  email: string;
  password: string;
};

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1"]);

function sanitizeConfiguredValue(value: string | null | undefined): string {
  const trimmed = String(value || "").trim();
  if (!trimmed) return "";
  if (/replace_with_/i.test(trimmed)) return "";
  if (/your_[a-z0-9_]+_here/i.test(trimmed)) return "";
  return trimmed;
}

export function resolveLocalReviewerCredentials(
  hostname?: string | null
): LocalReviewerCredentials | null {
  const email = sanitizeConfiguredValue(process.env.NEXT_PUBLIC_LOCAL_REVIEWER_EMAIL);
  const password = sanitizeConfiguredValue(
    process.env.NEXT_PUBLIC_LOCAL_REVIEWER_PASSWORD
  );
  if (!email || !password) {
    return null;
  }

  const normalizedHostname = String(hostname || "").trim().toLowerCase();
  if (normalizedHostname && !LOCAL_HOSTS.has(normalizedHostname)) {
    return null;
  }

  return { email, password };
}
