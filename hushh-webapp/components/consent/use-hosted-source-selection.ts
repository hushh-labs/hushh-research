"use client";

import { useCallback, useLayoutEffect, useState } from "react";
import { Capacitor } from "@capacitor/core";
import { DocumentHostingService, type DocumentSession, type HostedSourceFile, type HostedTermsProjection } from "@/lib/services/document-hosting-service";

/** Source catalog authority is separate from status, paid access and recovery. */
export function useHostedSourceSelection(session: DocumentSession, requestId: string, terms: HostedTermsProjection | null) {
  const [files, setFiles] = useState<HostedSourceFile[]>([]);
  const [loading, setLoading] = useState(false);
  const [unavailable, setUnavailable] = useState(false);
  const [refreshVersion, setRefreshVersion] = useState(0);
  const refresh = useCallback(() => setRefreshVersion(value => value + 1), []);
  useLayoutEffect(() => {
    setFiles([]); setLoading(false); setUnavailable(false);
    if (!terms || terms.ownerUserId !== session.userId || (Capacitor.isNativePlatform() && terms.status !== "staged") ||
        !["requested", "awaiting_owner", "preparing_on_owner_device", "staged"].includes(terms.status)) return;
    const controller = new AbortController();
    setLoading(true);
    void DocumentHostingService.sourceSelection(session, requestId, controller.signal).then(selection => {
      if (controller.signal.aborted || !session.isCurrent()) return;
      if (selection.requestId !== requestId || selection.revision !== terms.revision) throw new Error("document_selection_changed");
      setFiles(selection.files);
    }).catch(() => {
      if (!controller.signal.aborted && session.isCurrent()) setUnavailable(true);
    }).finally(() => {
      if (!controller.signal.aborted && session.isCurrent()) setLoading(false);
    });
    return () => controller.abort();
  }, [session, requestId, terms, refreshVersion]);
  return { files, loading, unavailable, refresh };
}
