/**
 * The domains a person can scope voice control to, and their human labels.
 *
 * These keys are opaque on the wire -- the client only ever says "location"
 * or "consent", never an action-gateway prefix or a specialist agent_id.
 * Action prefixes (location, kai, ria, consent, connections, ...) and
 * specialist agent_ids (agent_location, agent_nav, ...) don't line up 1:1
 * (Nav's action prefix is "consent", its agent_id is "agent_nav"), so
 * expanding a domain key into what it actually covers is the server's job,
 * not this file's. See the (forthcoming) `voice_domain_policy.py`.
 *
 * `enforced: false` domains render with a "Coming soon" badge instead of a
 * switch, for two different reasons that happen to want the same treatment:
 *
 * - Finance and Calendar voice actions don't route through either of the two
 *   server-side choke points the other domains share, so a toggle for them
 *   would silently do nothing.
 * - Email and Identity verification DO route through them, but are not tested
 *   or maintained right now, so offering a switch would present them as
 *   supported. Turning either back on is a one-line change here.
 *
 * Note what this treatment does NOT do: it removes the person's ability to
 * turn voice off for that domain, it does not turn voice off there. Voice
 * still acts in an unenforced domain.
 */
export type VoiceEngineDomainKey =
  | "location"
  | "email"
  | "connected_systems"
  | "consent"
  | "connections"
  | "kyc"
  | "finance"
  | "calendar";

export type VoiceEngineDomain = {
  key: VoiceEngineDomainKey;
  label: string;
  description: string;
  enforced: boolean;
};

export const VOICE_ENGINE_DOMAINS: readonly VoiceEngineDomain[] = [
  {
    key: "location",
    label: "Location",
    description: "Sharing, requests, circles, and check-ins.",
    enforced: true,
  },
  {
    key: "email",
    label: "Email",
    description: "Gmail connection and actions.",
    // Not tested or maintained right now, so it is shown as Coming soon
    // rather than offered as a control someone might rely on.
    enforced: false,
  },
  {
    key: "connected_systems",
    label: "Connected Systems",
    description: "CRM and external system workflows.",
    enforced: true,
  },
  {
    key: "consent",
    label: "Consent Center",
    description: "What you've shared, approvals, and revocations.",
    enforced: true,
  },
  {
    key: "connections",
    label: "Connections",
    description: "The people you're connected to.",
    enforced: true,
  },
  {
    key: "kyc",
    label: "Identity verification",
    description: "KYC workflow steps.",
    // Same as Email: unmaintained today, so not presented as a working
    // switch.
    enforced: false,
  },
  {
    key: "finance",
    label: "Finance",
    description: "Finance portfolio and analysis.",
    enforced: false,
  },
  {
    key: "calendar",
    label: "Calendar",
    description: "Connected Google Calendar.",
    enforced: false,
  },
] as const;
