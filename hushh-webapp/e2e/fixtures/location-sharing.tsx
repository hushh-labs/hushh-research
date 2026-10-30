import { useState } from "react";
import { createRoot } from "react-dom/client";
import { ActiveShareComparison } from "../../components/one-location/redesign/share-lanes";
import { LiveShareStatusCard } from "../../components/one-location/redesign/live-share-status-card";
import { Avatar } from "../../components/one-location/redesign/primitives";
import { groupGrantsByCounterpart, summarizeShareAudience } from "../../lib/one-location/grant-lanes";
import type { OneLocationGrant } from "../../lib/one-location/types";

const names = ["Neelesh Meena Rajagopalan Subramanian", "Smrithika Dharmalingam", "Smrithi", "Sharu Khan", "Akshat Kumar", "Kushal Irwadi"];
const now = Date.now();
const initial: OneLocationGrant[] = names.flatMap((name, index) => {
  const kinds = index === 0 ? ["share", "sos"] : [index === 3 || index === 5 ? "share" : "sos"];
  return kinds.map((shareKind) => ({
    id: `${index}_${shareKind}`, ownerUserId: "owner", recipientUserId: String(index), recipientDisplayName: name,
    recipientKeyId: "key", status: "active", consentScope: "cap.location.live.view", capabilityScopes: ["cap.location.live.view"],
    durationHours: index === 5 ? null : shareKind === "sos" ? 8 : 1,
    durationMode: index === 5 ? "until_stopped" : "timed",
    createdAt: new Date(now - 600_000).toISOString(),
    expiresAt: index === 5 ? null : new Date(now + (shareKind === "sos" ? 28_800_000 : 3_600_000)).toISOString(), shareKind,
  } as OneLocationGrant));
});

function Fixture() {
  const [grants, setGrants] = useState(initial);
  const groups = groupGrantsByCounterpart(grants, "owner");
  const audience = summarizeShareAudience(grants);
  return <main className="mx-auto w-full max-w-[var(--app-shell-agent)] space-y-6 px-4 py-6">
    <LiveShareStatusCard status={{ count: audience.peopleCount, grantCount: grants.length, names: groups.map((group) => group.primaryGrant.recipientDisplayName!),
      audience, startedAt: initial[0]!.createdAt, endsAt: initial[0]!.expiresAt!, stoppableGrantId: null,
    }} onManage={() => { document.body.dataset.lastAction = "manage"; }} onShareMore={() => { document.body.dataset.lastAction = "share"; }} />
    <ActiveShareComparison groups={groups} recipientName={(grant) => grant.recipientDisplayName!}
      renderAvatar={(_, name) => <Avatar initials={name.split(" ").slice(0, 2).map((word) => word[0]).join("")} size={40} />}
      onStopGrant={(id) => { document.body.dataset.stoppedGrant = id; setGrants((current) => current.filter((grant) => grant.id !== id)); }}
      onChangeEndTime={(id) => { document.body.dataset.durationGrant = id; }} revokingGrantId="0_share" />
  </main>;
}
createRoot(document.getElementById("root")!).render(<Fixture />);
