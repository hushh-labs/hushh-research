import React, { useState } from "react";
import { LivingCirclePanel } from "../../components/connect/circles/living-circle-panel";
import type { OneLocationCircleMember } from "../../lib/one-location/types";

const owner: OneLocationCircleMember = {
  userId: "owner",
  displayName: "Taylor Kim",
  role: "owner",
  phoneVerified: true,
  secureLocationReady: true,
};
const candidates = ["Asha Rao", "Alex Chen", "Jordan Lee"].map(
  (displayName, index) => ({
    userId: `person-${index}`,
    connectionId: `connection-${index}`,
    displayName,
  }),
);

/** Real component and styling; local callbacks replace API writes in this fixture. */
export function LivingCirclePanelFixture() {
  const [state, setState] = useState("new");
  const [members, setMembers] = useState([owner]);
  const visibleMembers: OneLocationCircleMember[] =
    state === "populated"
      ? [
          owner,
          ...Array.from({ length: 11 }, (_, index) => ({
            ...owner,
            userId: `member-${index}`,
            displayName: `Member ${index}`,
            role: "member" as const,
          })),
        ]
      : members;
  return (
    <main className="mx-auto w-full max-w-[38rem] p-4">
      <label>
        Fixture state
        <select
          aria-label="Circle detail fixture state"
          value={state}
          onChange={(event) => {
            setState(event.target.value);
            setMembers([owner]);
          }}
        >
          {[
            "new",
            "no-connections",
            "loading",
            "error",
            "full",
            "read-only",
            "populated",
          ].map((value) => (
            <option key={value} value={value}>
              {value}
            </option>
          ))}
        </select>
      </label>
      <LivingCirclePanel
        circleName="Investor Circle"
        members={visibleMembers}
        memberCount={visibleMembers.length}
        canInvite={state !== "read-only"}
        candidates={
          state === "no-connections"
            ? []
            : candidates.filter(
                (candidate) =>
                  !members.some((member) => member.userId === candidate.userId),
              )
        }
        availableCount={3}
        remainingCapacity={state === "full" ? 0 : 20 - visibleMembers.length}
        loading={state === "loading"}
        error={state === "error" ? "Connections unavailable" : null}
        addingUserId={null}
        onAdd={(userId) => {
          const candidate = candidates.find(
            (person) => person.userId === userId,
          );
          if (candidate)
            setMembers((current) => [
              ...current,
              { ...owner, ...candidate, role: "member" },
            ]);
        }}
        searchQuery=""
        onSearchChange={() => {}}
        hasMore={false}
        loadingMore={false}
        onLoadMore={() => {}}
        onRetry={() => setState("new")}
      />
    </main>
  );
}
