import React from "react";
import { createRoot } from "react-dom/client";
import { GuestPreview } from "../../components/onboarding/guest-preview";

createRoot(document.getElementById("root")!).render(
  <GuestPreview
    invitation={
      document.documentElement.dataset.invite === "true"
        ? { kind: "circle", name: "Family Circle", ownerName: "Alex" }
        : undefined
    }
    onStart={() => {
      document.documentElement.dataset.started = "true";
    }}
  />,
);
