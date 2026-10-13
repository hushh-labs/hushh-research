"use client";

export function isRequestAuditDebugEnabled(): boolean {
  return process.env.NEXT_PUBLIC_REQUEST_AUDIT_DEBUG === "1";
}

export function logRequestAudit(
  label: string,
  stage: string,
  detail: Record<string, unknown>,
): void {
  if (!isRequestAuditDebugEnabled()) return;
  console.info(`[RequestAudit:${label}] ${stage}`, detail);
}
