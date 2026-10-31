import { LEGAL_CONTACT_EMAIL, LEGAL_DOCUMENTS, LEGAL_PRIVACY_EMAIL, type LegalDocumentType } from "@/lib/legal/legal-documents";
import { projectNativeLegalDocument } from "@/lib/capacitor/native-profile-legal";
import type { NativeProfilePage } from "@/lib/capacitor/native-drawers";
import type { NativeDrawerActions } from "@/lib/capacitor/native-drawer-presentation";
import { openExternalUrl } from "@/lib/utils/browser-navigation";

/** Feature-specific projection. Fenced callbacks resolve authored links here;
 * the native reader never receives URLs or another navigation authority. */
export function projectNativeProfileLegal(detail: LegalDocumentType | null,
  open: (type: LegalDocumentType, mode: "push" | "replace") => void,
  openAccountDeletion: () => void, includeSection = true) {
  const rows: Map<string, () => void> = new Map();
  const pages: NativeProfilePage[] = [{ id: "legal", title: "Legal", sections: [{ id: "legal-documents", title: "Documents",
    rows: (["privacy", "terms"] as const).map(type => {
      const id = `legal-open-${type}`;
      rows.set(id, () => open(type, "push"));
      return { id, artworkId: type, label: LEGAL_DOCUMENTS[type].title, symbol: type === "privacy" ? "checkmark.shield" : "text.document", enabled: true, chevron: true };
    }) }] }];
  if (detail) {
    const { document, links } = projectNativeLegalDocument(detail);
    for (const [id, href] of links) {
      rows.set(id, () => {
        if (href === "/privacy" || href === "/terms") { open(href === "/privacy" ? "privacy" : "terms", "replace"); return; }
        if (href === "/delete-account") { openAccountDeletion(); return; }
        if (href === `mailto:${LEGAL_CONTACT_EMAIL}` || href === `mailto:${LEGAL_PRIVACY_EMAIL}` || href.startsWith("https://")) {
          openExternalUrl(href);
        }
      });
    }
    if (!includeSection) pages.length = 0;
    pages.push({ id: detail, title: LEGAL_DOCUMENTS[detail].title, sections: [], legalDocument: document });
  }
  return { pages, rows: rows as NativeDrawerActions["rows"] };
}
