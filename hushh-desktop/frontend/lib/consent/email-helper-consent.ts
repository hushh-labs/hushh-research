"use client";

type MetadataLike = Record<string, unknown> | null | undefined;

function readString(metadata: MetadataLike, key: string): string {
  const value = metadata?.[key];
  return typeof value === "string" ? value.trim() : "";
}

export function isEmailHelperConsent(metadata: MetadataLike): boolean {
  return (
    readString(metadata, "request_source") === "one_email_kyc_v1" ||
    Boolean(readString(metadata, "workflow_id") && readString(metadata, "gmail_thread_id"))
  );
}

export function emailHelperWorkflowHref(metadata: MetadataLike): string | null {
  const workflowUrl = readString(metadata, "workflow_url");
  if (workflowUrl) return workflowUrl;
  const workflowId = readString(metadata, "workflow_id");
  return workflowId ? `/one/kyc?workflowId=${encodeURIComponent(workflowId)}` : null;
}

export function emailHelperConsentSummary(metadata: MetadataLike): string {
  const requiredFields = metadata?.required_fields;
  const fields = Array.isArray(requiredFields)
    ? requiredFields
        .map((field) => String(field || "").replaceAll("_", " ").trim())
        .filter(Boolean)
    : [];
  if (fields.length === 1) {
    return `Email Helper needs approval to use your ${fields[0]}.`;
  }
  return "Email Helper needs approval before it can draft this reply.";
}
