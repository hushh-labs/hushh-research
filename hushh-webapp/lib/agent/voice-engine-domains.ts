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
 * Only Location and Connections are supported today. Every other domain
 * renders with a "Coming soon" badge instead of a switch.
 *
 * Two different reasons land on that same treatment, and the distinction
 * matters if you are deciding whether one can be turned back on:
 *
 * - Finance and Calendar voice actions don't route through either of the two
 *   server-side choke points the other domains share, so a toggle for them
 *   would silently do nothing. Enforcement would have to be built first.
 * - Email, Identity verification, Connected Systems and Consent Center DO
 *   route through them -- their switches worked -- but they are not tested or
 *   maintained right now, so offering one would present them as supported.
 *   Turning any of these four back on is a one-line change here.
 *
 * Note what this treatment does NOT do: it removes the person's ability to
 * turn voice off for that domain, it does not turn voice off there. Voice
 * still acts in an unenforced domain. With six of eight domains now
 * unenforced, that gap is wider than it was -- worth naming rather than
 * discovering later.
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
    // Routes through the choke points, but is not tested or maintained
    // right now, so it is shown as Coming soon rather than offered as a
    // control someone might rely on.
    enforced: false,
  },
  {
    key: "connected_systems",
    label: "Connected Systems",
    description: "CRM and external system workflows.",
    // Same as Email: enforcement works, maintenance does not.
    enforced: false,
  },
  {
    key: "consent",
    label: "Consent Center",
    description: "What you've shared, approvals, and revocations.",
    // Same as Email: enforcement works, maintenance does not.
    enforced: false,
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
    // Same as Email: enforcement works, maintenance does not.
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

const ENFORCED_DOMAIN_KEYS: ReadonlySet<string> = new Set(
  VOICE_ENGINE_DOMAINS.filter((domain) => domain.enforced).map(
    (domain) => domain.key,
  ),
);

/**
 * The disabled-domain list with unenforced domains dropped.
 *
 * Marking a domain unenforced removes its switch but does NOT remove the key
 * an earlier version let the person store. The server has no notion of
 * "enforced" -- `is_voice_domain_disabled` (voice_domain_policy.py) blocks any
 * of its six recognised keys that arrives in the list. So somebody who had
 * turned Consent Center or Connected Systems off keeps it off forever, with no
 * switch left to undo it, and a "Coming soon" badge sitting where the
 * explanation should be.
 *
 * Finance and Calendar never had this problem: the server deliberately omits
 * them, so a stored disable for either was always inert. The four domains that
 * moved to "Coming soon" are all keys the server does enforce, which is what
 * makes the stale entry bite.
 *
 * Filtered at the point of effect, not in storage: the stored choice is left
 * alone so re-enforcing a domain restores what the person originally picked
 * rather than silently defaulting them back on. This also matches the posture
 * voice-preferences.ts states for itself -- a restriction nobody can see or
 * manage should not quietly keep applying.
 */
export function resolveEffectiveDisabledDomains(
  disabledDomains: readonly string[],
): string[] {
  return disabledDomains.filter((key) => ENFORCED_DOMAIN_KEYS.has(key));
}
