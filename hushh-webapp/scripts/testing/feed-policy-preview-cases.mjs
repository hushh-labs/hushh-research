/** Every admitted event contract, using synthetic metadata for copy review only. */
import fs from "node:fs";
const policy = JSON.parse(fs.readFileSync(new URL("../../../consent-protocol/contracts/feed/activity-policy.v1.json", import.meta.url), "utf8"));
const domains = { agent_nav: "consent", agent_location: "location", agent_connections: "connections", agent_kai: "kai", agent_kyc: "connected_systems", agent_personal_information: "pwm" };
const id = "10000000-1000-4000-8000-000000000001";
export const policyPreviewCases = Object.entries(policy.events).filter(([, rule]) => rule.kind !== "routine").map(([event, rule], index) => {
  const metadata = { counterpart_label: "Maya", feed_audience: "recipient", request_id: id, grant_id: id,
    bundle_id: id, workflow_id: id, draft_id: id, run_id: id, ticker: "AAPL", advisorReviewId: id, viewerRole: "owner",
    account_id: "default", circle_id: id, invite_id: id, send_action_id: "preview-send", pwm_outcome: "ready",
    wallet_card_request_id: event === "direct_message_received" ? id : undefined,
    wallet_card_request_status: "pending", user_facing_status: event === "funding_transfer_status" ? "returned" : "completed",
    retained_funding_history: true, direction: "INCOMING", duration_hours: 2, requested_duration_hours: 2,
    current_request_status: "completed", current_delivery_confirmed_count: 2, current_delivery_total_count: 2,
    current_delivery_pending_count: 0, new_status: "approved", shared_count: 2 };
  return Object.freeze({ key: "policy-" + event, section: "Subagent policy", family: "policy-" + event,
    role: "synthetic-viewer", state: rule.kind + " · " + event, copy: "", action: null,
    destination: "/one/feed", authority: "Synthetic " + policy.agents[rule.agent] + " contract; no provider operation",
    feedItem: { id: String(9000 + index), activity_group_id: "preview:" + event, source_domain: domains[rule.agent] || "connected_systems",
      subagent_id: rule.agent, activity_kind: rule.kind, event_type: event, actor_label: "Maya", metadata, read: true, created_at: "2026-10-16T15:30:00Z" } });
});
