/**
 * Generic "what can I say" examples shown in Voice Settings, grouped the
 * same way as VOICE_ENGINE_DOMAINS so the two screens read as one system.
 * Every phrase names a real, shipped voice action -- not an aspirational
 * one -- so update this alongside the action contract it illustrates, the
 * same discipline as voice-engine-changelog.ts.
 *
 * `actionId` is what makes that promise checkable: it is the action_id this
 * phrase is meant to trigger, and voice-agent-examples.test.ts fails the
 * build the moment it points at something unwired or manual_only. Email and
 * Identity verification examples were dropped entirely rather than given an
 * actionId, because neither domain currently has a single wired action
 * behind it -- see #6308.
 */
export type VoiceAgentExample = {
  phrase: string;
  result: string;
  actionId: string;
};

export type VoiceAgentExampleGroup = {
  key: string;
  label: string;
  examples: readonly VoiceAgentExample[];
};

export const VOICE_AGENT_EXAMPLE_GROUPS: readonly VoiceAgentExampleGroup[] = [
  {
    key: "location",
    label: "Location",
    examples: [
      {
        phrase: "Share my location with Priya for 2 hours",
        result: "Shares for the time you say -- never assumed for you.",
        actionId: "location.open_share",
      },
      {
        phrase: "Ask Rohan where he is",
        result: "Sends him a location request.",
        actionId: "location.open_ask",
      },
      {
        phrase: "Who's sharing location with me",
        result: "Opens what's currently shared with you.",
        actionId: "location.open_shared_with_me",
      },
      {
        phrase: "Create a circle called Family",
        result: "Starts a new circle.",
        actionId: "location.create_circle",
      },
      {
        phrase: "Stop sharing my location",
        result: "Pauses every active share.",
        actionId: "location.pause_updates",
      },
      {
        phrase: "Trigger SOS",
        result: "Opens the emergency SMS screen.",
        actionId: "location.trigger_sos",
      },
    ],
  },
  {
    key: "connections",
    label: "Connections",
    examples: [
      {
        phrase: "Send a connection request to Kunal Shah",
        result: "Finds the closest name match and sends it -- misheard names included.",
        actionId: "connect.send_request",
      },
      {
        phrase: "Search for advisors near me",
        result: "Opens Connect's nearby search.",
        actionId: "connect.open_nearby",
      },
      {
        phrase: "Remove my connection with Asha Verma",
        result: "Asks you to confirm, then removes it.",
        actionId: "connect.remove_connection",
      },
    ],
  },
  {
    key: "consent",
    label: "Consent Center",
    examples: [
      {
        phrase: "Open Consent Center",
        result: "Shows what you've shared, and with whom.",
        actionId: "route.consents",
      },
    ],
  },
] as const;
