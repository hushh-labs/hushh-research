"use client";

import { ScrollText, ShieldCheck } from "@/components/icons";
import { SettingsGroup, SettingsRow } from "@/components/app-ui/settings-ui";
import { LegalReader } from "@/components/legal/legal-reader";
import type { ProfileStackEntry } from "@/components/profile/profile-stack-navigator";
import { LEGAL_DOCUMENTS } from "@/lib/legal/legal-documents";
import type {
  LegalDocumentDetail,
  ProfileDetail,
} from "@/lib/navigation/profile-routes";

type UpdateLegalView = (
  next: { panel: "legal"; detail: ProfileDetail | null },
  mode: "push" | "replace",
) => void;

/**
 * The rows that open a legal document in place. Shared by Profile's home and
 * the Legal section itself, so both read the same.
 */
export function ProfileLegalRows({
  onOpen,
}: {
  onOpen: (document: LegalDocumentDetail) => void;
}) {
  return (
    <>
      <SettingsRow
        icon={ShieldCheck}
        iconTone="capability"
        title={LEGAL_DOCUMENTS.privacy.title}
        testId="profile-legal-privacy-row"
        chevron
        onClick={() => onOpen("privacy")}
      />
      <SettingsRow
        icon={ScrollText}
        iconTone="capability"
        title={LEGAL_DOCUMENTS.terms.title}
        testId="profile-legal-terms-row"
        chevron
        onClick={() => onOpen("terms")}
      />
    </>
  );
}

/**
 * Profile's stack entries for Legal: the section, and the open document.
 *
 * The document is the same reader as the public /terms and /privacy pages,
 * drawn inside the pane under the pane's own header and Back. Moving to the
 * other document replaces the open one, so Back still returns to where the
 * person opened it from rather than through both documents.
 */
export function buildProfileLegalStackEntries({
  detail,
  updateView,
}: {
  detail: ProfileDetail | null;
  updateView: UpdateLegalView;
}): ProfileStackEntry[] {
  const entries: ProfileStackEntry[] = [
    {
      key: "panel:legal",
      title: "Legal",
      description: "The terms you agreed to and how your information is handled.",
      content: (
        <SettingsGroup separatorInset>
          <ProfileLegalRows
            onOpen={(document) =>
              updateView({ panel: "legal", detail: document }, "push")
            }
          />
        </SettingsGroup>
      ),
    },
  ];
  if (detail === "terms" || detail === "privacy") {
    const doc = LEGAL_DOCUMENTS[detail];
    entries.push({
      key: `detail:legal:${detail}`,
      title: doc.title,
      description: doc.summary,
      content: (
        <LegalReader
          type={detail}
          navigation={{
            kind: "in-place",
            open: (next) =>
              updateView({ panel: "legal", detail: next }, "replace"),
          }}
        />
      ),
    });
  }
  return entries;
}
