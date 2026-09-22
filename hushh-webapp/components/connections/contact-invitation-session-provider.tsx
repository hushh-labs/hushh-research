"use client";

import type { ReactNode } from "react";
import { usePathname } from "next/navigation";
import { useAuth } from "@/hooks/use-auth";
import {
  GoogleContactSyncSessionContext,
  useGoogleContactSyncSession,
} from "@/lib/contacts/use-google-contact-sync-session";
import {
  ContactInvitationSessionContext,
  useContactInvitationSession,
} from "@/lib/contacts/use-contact-invitations";

/** No UI or auth authority. Only the current account/route holds recipients in memory. */
export function ContactInvitationSessionProvider({
  children,
}: {
  children: ReactNode;
}) {
  const { user } = useAuth();
  const pathname = usePathname();
  const owner = user?.uid ?? null;
  const controller = useContactInvitationSession(owner, pathname ?? "");
  const googleController = useGoogleContactSyncSession(owner, pathname ?? "");
  return (
    <ContactInvitationSessionContext.Provider value={{ owner, controller }}>
      <GoogleContactSyncSessionContext.Provider
        value={{ owner, controller: googleController }}
      >
        {children}
      </GoogleContactSyncSessionContext.Provider>
    </ContactInvitationSessionContext.Provider>
  );
}
