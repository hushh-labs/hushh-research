/**
 * Generic "what can I say" examples shown in Voice Settings, grouped the
 * same way as VOICE_ENGINE_DOMAINS so the two screens read as one system.
 * Every phrase names a real, shipped voice action -- not an aspirational
 * one -- so update this alongside the action contract it illustrates, the
 * same discipline as voice-engine-changelog.ts.
 */
export type VoiceAgentExample = {
  phrase: string;
  result: string;
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
      },
      {
        phrase: "Ask Rohan where he is",
        result: "Sends him a location request.",
      },
      {
        phrase: "Who's sharing location with me",
        result: "Opens what's currently shared with you.",
      },
      {
        phrase: "Create a circle called Family",
        result: "Starts a new circle.",
      },
      {
        phrase: "Stop sharing my location",
        result: "Pauses every active share.",
      },
      {
        phrase: "Trigger SOS",
        result: "Opens the emergency SMS screen.",
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
      },
      {
        phrase: "Search for advisors near me",
        result: "Opens Connect's nearby search.",
      },
      {
        phrase: "Remove my connection with Asha Verma",
        result: "Asks you to confirm, then removes it.",
      },
    ],
  },
  {
    key: "email",
    label: "Email",
    examples: [
      {
        phrase: "Connect my Gmail",
        result: "Starts the Gmail connection flow.",
      },
      {
        phrase: "Sync my Gmail receipts now",
        result: "Pulls in the latest receipts.",
      },
    ],
  },
  {
    key: "kyc",
    label: "Identity verification",
    examples: [
      {
        phrase: "What's my verification status",
        result: "Checks where your request stands.",
      },
      {
        phrase: "Approve the response draft",
        result: "Approves a drafted KYC response.",
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
      },
    ],
  },
] as const;
