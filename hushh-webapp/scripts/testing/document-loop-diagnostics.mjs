/** Content-free diagnostics for the synthetic protected-document browser loop. */
export const DOCUMENT_DIAGNOSTIC_PREFIX = "hushh-document-fixture-failure:";

export function documentFailureDiagnostic(error) {
  const names = ["Error", "TypeError", "OperationError", "DataError", "AbortError", "InvalidAccessError", "NotSupportedError", "SecurityError", "NetworkError"];
  const codes = ["document_context_invalid", "document_integrity_failed", "document_key_invalid", "document_key_unavailable", "document_manifest_invalid", "document_manifest_unavailable", "document_package_invalid", "document_package_size_limit", "document_preparation_changed", "document_preparation_not_authorized", "document_recipient_key_changed", "session_changed"];
  try {
    const name = error?.name;
    const code = error?.message;
    return { name: names.includes(name) ? name : "unknown", code: codes.includes(code) ? code : "unknown" };
  } catch { return { name: "unknown", code: "unknown" }; }
}

export function instrumentDocumentErrors(source) {
  const marker = "export function documentHostingErrorCopy(error: unknown): string {";
  if (source.split(marker).length !== 2) throw new Error("Document error diagnostic boundary changed");
  const diagnostic = `console.info(${JSON.stringify(DOCUMENT_DIAGNOSTIC_PREFIX)} + JSON.stringify((${documentFailureDiagnostic.toString()})(error)));`;
  return source.replace(marker, `${marker}\n${diagnostic}\n`);
}
