const API_TEMPLATE_RULES: Array<{ regex: RegExp; template: string }> = [
  { regex: /^\/api\/vault\/check(?:\?.*)?$/i, template: "/db/vault/check" },
  { regex: /^\/api\/vault\/get(?:\?.*)?$/i, template: "/db/vault/get" },
  {
    regex: /^\/api\/vault\/bootstrap-state(?:\?.*)?$/i,
    template: "/db/vault/bootstrap-state",
  },
  {
    regex: /^\/api\/pkm\/metadata\/[^/?]+(?:\?.*)?$/i,
    template: "/api/pkm/metadata/{user_id}",
  },
  {
    regex: /^\/api\/pkm\/scopes\/[^/?]+(?:\?.*)?$/i,
    template: "/api/pkm/scopes/{user_id}",
  },
  {
    regex: /^\/api\/pkm\/data\/[^/?]+(?:\?.*)?$/i,
    template: "/api/pkm/data/{user_id}",
  },
  {
    regex: /^\/api\/pkm\/domain-data\/[^/?]+\/[^/?]+(?:\?.*)?$/i,
    template: "/api/pkm/domain-data/{user_id}/{domain}",
  },
  {
    regex: /^\/api\/one\/location\/recipient-keys(?:\?.*)?$/i,
    template: "/api/one/location/recipient-keys",
  },
  {
    regex: /^\/api\/one\/location\/state(?:\?.*)?$/i,
    template: "/api/one/location/state",
  },
  {
    regex: /^\/api\/one\/location\/grants(?:\?.*)?$/i,
    template: "/api/one/location/grants",
  },
  {
    regex: /^\/api\/one\/location\/grants\/[^/?]+\/envelopes(?:\?.*)?$/i,
    template: "/api/one/location/grants/{grant_id}/envelopes",
  },
  {
    regex: /^\/api\/one\/location\/grants\/[^/?]+\/envelope(?:\?.*)?$/i,
    template: "/api/one/location/grants/{grant_id}/envelope",
  },
  {
    regex: /^\/api\/one\/location\/grants\/[^/?]+(?:\?.*)?$/i,
    template: "/api/one/location/grants/{grant_id}",
  },
  {
    regex: /^\/api\/one\/location\/requests(?:\?.*)?$/i,
    template: "/api/one/location/requests",
  },
  {
    regex: /^\/api\/one\/location\/requests\/[^/?]+\/approve(?:\?.*)?$/i,
    template: "/api/one/location/requests/{request_id}/approve",
  },
  {
    regex: /^\/api\/one\/location\/requests\/[^/?]+\/deny(?:\?.*)?$/i,
    template: "/api/one/location/requests/{request_id}/deny",
  },
  {
    regex: /^\/api\/one\/location\/grants\/[^/?]+\/refer(?:\?.*)?$/i,
    template: "/api/one/location/grants/{grant_id}/refer",
  },
  {
    regex: /^\/api\/one\/location\/public-invites(?:\?.*)?$/i,
    template: "/api/one/location/public-invites",
  },
  {
    regex: /^\/api\/one\/location\/public-invites\/[^/?]+\/submit(?:\?.*)?$/i,
    template: "/api/one/location/public-invites/{public_token}/submit",
  },
  {
    regex: /^\/api\/one\/location\/public-invites\/[^/?]+(?:\?.*)?$/i,
    template: "/api/one/location/public-invites/{public_invite_id}",
  },
  {
    regex: /^\/api\/one\/agent-chat(?:\?.*)?$/i,
    template: "/api/one/agent-chat",
  },
  {
    regex: /^\/api\/one\/agent-chat\/conversations\/[^/?]+(?:\?.*)?$/i,
    template: "/api/one/agent-chat/conversations/{user_id}",
  },
  {
    regex: /^\/api\/one\/agent-chat\/history\/[^/?]+(?:\?.*)?$/i,
    template: "/api/one/agent-chat/history/{conversation_id}",
  },
  {
    regex: /^\/api\/one\/agent-chat\/runs\/[^/?]+\/queue\/[^/?]+(?:\?.*)?$/i,
    template: "/api/one/agent-chat/runs/{conversation_id}/queue/{client_message_id}",
  },
  {
    regex: /^\/api\/one\/agent-chat\/runs\/[^/?]+\/queue(?:\?.*)?$/i,
    template: "/api/one/agent-chat/runs/{conversation_id}/queue",
  },
  {
    regex: /^\/api\/one\/agent-chat\/runs\/[^/?]+\/stop(?:\?.*)?$/i,
    template: "/api/one/agent-chat/runs/{conversation_id}/stop",
  },
  {
    regex: /^\/api\/kai\/market\/insights\/baseline\/[^/?]+(?:\?.*)?$/i,
    template: "/api/kai/market/insights/baseline/{user_id}",
  },
  {
    regex: /^\/api\/kai\/market\/insights\/[^/?]+(?:\?.*)?$/i,
    template: "/api/kai/market/insights/{user_id}",
  },
  {
    regex: /^\/api\/kai\/market\/news\/baseline\/[^/?]+(?:\?.*)?$/i,
    template: "/api/kai/market/news/baseline/{user_id}",
  },
  {
    regex: /^\/api\/kai\/market\/news\/[^/?]+(?:\?.*)?$/i,
    template: "/api/kai/market/news/{user_id}",
  },
  {
    regex: /^\/api\/kai\/dashboard\/profile-picks\/[^/?]+(?:\?.*)?$/i,
    template: "/api/kai/dashboard/profile-picks/{user_id}",
  },
  {
    regex: /^\/api\/kai\/portfolio\/summary\/[^/?]+(?:\?.*)?$/i,
    template: "/api/kai/portfolio/summary/{user_id}",
  },
  {
    regex: /^\/api\/kai\/gmail\/connect\/start(?:\?.*)?$/i,
    template: "/api/kai/gmail/connect/start",
  },
  {
    regex: /^\/api\/kai\/gmail\/connect\/complete(?:\?.*)?$/i,
    template: "/api/kai/gmail/connect/complete",
  },
  {
    regex: /^\/api\/kai\/gmail\/status\/[^/?]+(?:\?.*)?$/i,
    template: "/api/kai/gmail/status/{user_id}",
  },
  {
    regex: /^\/api\/kai\/gmail\/disconnect(?:\?.*)?$/i,
    template: "/api/kai/gmail/disconnect",
  },
  {
    regex: /^\/api\/kai\/gmail\/reconcile(?:\?.*)?$/i,
    template: "/api/kai/gmail/reconcile",
  },
  {
    regex: /^\/api\/kai\/gmail\/sync(?:\?.*)?$/i,
    template: "/api/kai/gmail/sync",
  },
  {
    regex: /^\/api\/kai\/gmail\/sync\/[^/?]+(?:\?.*)?$/i,
    template: "/api/kai/gmail/sync/{run_id}",
  },
  {
    regex: /^\/api\/kai\/gmail\/receipts\/scan(?:\?.*)?$/i,
    template: "/api/kai/gmail/receipts/scan",
  },
  {
    regex: /^\/api\/kai\/gmail\/receipts\/detail(?:\?.*)?$/i,
    template: "/api/kai/gmail/receipts/detail",
  },
  {
    regex: /^\/api\/kai\/gmail\/receipts\/[^/?]+(?:\?.*)?$/i,
    template: "/api/kai/gmail/receipts/{user_id}",
  },
  {
    regex: /^\/api\/kai\/gmail\/receipts-memory\/preview(?:\?.*)?$/i,
    template: "/api/kai/gmail/receipts-memory/preview",
  },
  {
    regex: /^\/api\/kai\/gmail\/receipts-memory\/artifacts\/[^/?]+(?:\?.*)?$/i,
    template: "/api/kai/gmail/receipts-memory/artifacts/{artifact_id}",
  },
  {
    regex: /^\/api\/kai\/analyze\/run\/start(?:\?.*)?$/i,
    template: "/api/kai/analyze/run/start",
  },
  {
    regex: /^\/api\/kai\/analyze\/run\/active(?:\?.*)?$/i,
    template: "/api/kai/analyze/run/active",
  },
  {
    regex: /^\/api\/kai\/analyze\/run\/[^/?]+\/stream(?:\?.*)?$/i,
    template: "/api/kai/analyze/run/{run_id}/stream",
  },
  {
    regex: /^\/api\/kai\/analyze\/run\/[^/?]+\/cancel(?:\?.*)?$/i,
    template: "/api/kai/analyze/run/{run_id}/cancel",
  },
  {
    regex: /^\/api\/kai\/portfolio\/import\/run\/start(?:\?.*)?$/i,
    template: "/api/kai/portfolio/import/run/start",
  },
  {
    regex: /^\/api\/kai\/portfolio\/import\/run\/active(?:\?.*)?$/i,
    template: "/api/kai/portfolio/import/run/active",
  },
  {
    regex: /^\/api\/kai\/portfolio\/import\/run\/[^/?]+\/stream(?:\?.*)?$/i,
    template: "/api/kai/portfolio/import/run/{run_id}/stream",
  },
  {
    regex: /^\/api\/kai\/portfolio\/import\/run\/[^/?]+\/cancel(?:\?.*)?$/i,
    template: "/api/kai/portfolio/import/run/{run_id}/cancel",
  },
  {
    regex: /^\/api\/one\/kyc\/workflows(?:\?.*)?$/i,
    template: "/api/one/kyc/workflows",
  },
  {
    regex: /^\/api\/one\/kyc\/workflows\/[^/?]+(?:\?.*)?$/i,
    template: "/api/one/kyc/workflows/{workflow_id}",
  },
  {
    regex: /^\/api\/one\/kyc\/workflows\/[^/?]+\/refresh(?:\?.*)?$/i,
    template: "/api/one/kyc/workflows/{workflow_id}/refresh",
  },
  {
    regex: /^\/api\/one\/kyc\/workflows\/[^/?]+\/approve-draft(?:\?.*)?$/i,
    template: "/api/one/kyc/workflows/{workflow_id}/approve-draft",
  },
  {
    regex: /^\/api\/one\/kyc\/workflows\/[^/?]+\/reject-draft(?:\?.*)?$/i,
    template: "/api/one/kyc/workflows/{workflow_id}/reject-draft",
  },
  {
    regex: /^\/api\/one\/kyc\/workflows\/[^/?]+\/redraft(?:\?.*)?$/i,
    template: "/api/one/kyc/workflows/{workflow_id}/redraft",
  },
  {
    regex: /^\/api\/consent\/pending(?:\?.*)?$/i,
    template: "/api/consent/pending",
  },
  {
    regex: /^\/api\/consent\/pending\/approve(?:\?.*)?$/i,
    template: "/api/consent/pending/approve",
  },
  {
    regex: /^\/api\/consent\/pending\/deny(?:\?.*)?$/i,
    template: "/api/consent/pending/deny",
  },
  {
    regex: /^\/api\/consent\/revoke(?:\?.*)?$/i,
    template: "/api/consent/revoke",
  },
  {
    regex: /^\/api\/consent\/center(?:\?.*)?$/i,
    template: "/api/consent/center",
  },
  {
    regex: /^\/api\/consent\/requests(?:\?.*)?$/i,
    template: "/api/consent/requests",
  },
  {
    regex: /^\/api\/consent\/requests\/outgoing(?:\?.*)?$/i,
    template: "/api/consent/requests/outgoing",
  },
  {
    regex: /^\/api\/account\/delete(?:\?.*)?$/i,
    template: "/api/account/delete",
  },
  {
    regex: /^\/api\/account\/export(?:\?.*)?$/i,
    template: "/api/account/export",
  },
  {
    regex: /^\/api\/developer\/access(?:\?.*)?$/i,
    template: "/api/developer/access",
  },
  {
    regex: /^\/api\/developer\/access\/enable(?:\?.*)?$/i,
    template: "/api/developer/access/enable",
  },
  {
    regex: /^\/api\/developer\/access\/profile(?:\?.*)?$/i,
    template: "/api/developer/access/profile",
  },
  {
    regex: /^\/api\/developer\/access\/rotate-key(?:\?.*)?$/i,
    template: "/api/developer/access/rotate-key",
  },
  {
    regex: /^\/api\/connected-systems(?:\?.*)?$/i,
    template: "/api/connected-systems",
  },
  {
    regex: /^\/api\/connected-systems\/[^/?]+\/schema(?:\?.*)?$/i,
    template: "/api/connected-systems/{system_id}/schema",
  },
  {
    regex: /^\/api\/connected-systems\/[^/?]+\/records\/read(?:\?.*)?$/i,
    template: "/api/connected-systems/{system_id}/records/read",
  },
  {
    regex:
      /^\/api\/connected-systems\/[^/?]+\/records\/create-intents(?:\?.*)?$/i,
    template: "/api/connected-systems/{system_id}/records/create-intents",
  },
  {
    regex:
      /^\/api\/connected-systems\/[^/?]+\/records\/update-intents(?:\?.*)?$/i,
    template: "/api/connected-systems/{system_id}/records/update-intents",
  },
  {
    regex:
      /^\/api\/connected-systems\/[^/?]+\/intents\/[^/?]+\/approve(?:\?.*)?$/i,
    template: "/api/connected-systems/{system_id}/intents/{intent_id}/approve",
  },
  {
    regex:
      /^\/api\/connected-systems\/[^/?]+\/intents\/[^/?]+\/reject(?:\?.*)?$/i,
    template: "/api/connected-systems/{system_id}/intents/{intent_id}/reject",
  },
  {
    regex: /^\/api\/iam\/persona(?:\?.*)?$/i,
    template: "/api/iam/persona",
  },
  {
    regex: /^\/api\/iam\/persona\/switch(?:\?.*)?$/i,
    template: "/api/iam/persona/switch",
  },
  {
    regex: /^\/api\/iam\/marketplace\/opt-in(?:\?.*)?$/i,
    template: "/api/iam/marketplace/opt-in",
  },
  {
    regex: /^\/api\/iam\/contact-discoverability(?:\?.*)?$/i,
    template: "/api/iam/contact-discoverability",
  },
  {
    regex: /^\/api\/ria\/onboarding\/submit(?:\?.*)?$/i,
    template: "/api/ria/onboarding/submit",
  },
  {
    regex: /^\/api\/ria\/onboarding\/status(?:\?.*)?$/i,
    template: "/api/ria/onboarding/status",
  },
  {
    regex: /^\/api\/ria\/clients(?:\?.*)?$/i,
    template: "/api/ria/clients",
  },
  {
    regex: /^\/api\/ria\/invites(?:\?.*)?$/i,
    template: "/api/ria/invites",
  },
  {
    regex: /^\/api\/ria\/marketplace\/discoverability(?:\?.*)?$/i,
    template: "/api/ria/marketplace/discoverability",
  },
  {
    regex: /^\/api\/ria\/requests(?:\?.*)?$/i,
    template: "/api/ria/requests",
  },
  {
    regex: /^\/api\/ria\/workspace\/[^/?]+(?:\?.*)?$/i,
    template: "/api/ria/workspace/{investor_user_id}",
  },
  {
    regex: /^\/api\/marketplace\/rias(?:\?.*)?$/i,
    template: "/api/marketplace/rias",
  },
  {
    regex: /^\/api\/marketplace\/investors(?:\?.*)?$/i,
    template: "/api/marketplace/investors",
  },
  {
    regex: /^\/api\/marketplace\/ria\/[^/?]+(?:\?.*)?$/i,
    template: "/api/marketplace/ria/{ria_id}",
  },
  {
    regex: /^\/api\/invites\/[^/?]+(?:\?.*)?$/i,
    template: "/api/invites/{invite_token}",
  },
  {
    regex: /^\/api\/invites\/[^/?]+\/accept(?:\?.*)?$/i,
    template: "/api/invites/{invite_token}/accept",
  },
];

export function normalizeApiPathToTemplate(path: string): string {
  const withoutQuery = path.split("?")[0] || "/";

  for (const rule of API_TEMPLATE_RULES) {
    if (rule.regex.test(path)) {
      return rule.template;
    }
  }

  // Generic fallback: hide likely identifiers in dynamic path segments.
  const sanitized = withoutQuery
    .split("/")
    .map((segment, index) => {
      if (!segment || index === 0 || segment === "api" || segment === "db") {
        return segment;
      }

      const looksNumeric = /^\d+$/.test(segment);
      const looksUuid =
        /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
          segment,
        );
      const looksOpaqueId = /^[a-z0-9_-]{10,}$/i.test(segment);

      if (looksNumeric || looksUuid || looksOpaqueId) {
        return "{id}";
      }
      return segment;
    })
    .join("/");

  return sanitized || "/";
}
