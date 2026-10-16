import React from "react";
import { createRoot } from "react-dom/client";
import { CircleInvitePeopleSheet } from "../../components/one-location/redesign/circles/circle-grow-actions";

const eligibleConnections = Array.from({ length: 45 }, (_, index) => ({
  connectionId: `connection-${index + 1}`,
  userId: `person-${index + 1}`,
  displayName: `Connected person ${index + 1}`,
  photoUrl: null,
  connectedFromContacts: true,
  isRia: false,
}));

createRoot(document.getElementById("root")!).render(
  <CircleInvitePeopleSheet
    open
    onOpenChange={() => {}}
    circleId="trusted"
    circleName="Trusted"
    onLoadEligibleConnections={async () => ({ eligibleConnections, pendingInvites: [], remainingCapacity: 50 })}
    onInviteConnections={async () => {}}
    onCancelMemberInvite={async () => {}}
  />,
);
