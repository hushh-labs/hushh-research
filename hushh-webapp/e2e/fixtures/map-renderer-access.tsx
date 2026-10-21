import { createRoot } from "react-dom/client";
import { MapRendererAccess } from "@/components/one-location/map-renderer-access";

import { mountMapPersonAvatarFixture } from "./map-person-avatar";

const inline = document.body.dataset.inline === "true";
if (document.body.dataset.avatars === "true") {
  mountMapPersonAvatarFixture();
} else createRoot(document.getElementById("root")!).render(
  <main className="relative h-dvh w-full bg-muted">
    <div className={inline ? "mx-auto max-w-lg px-5 py-4" : undefined}>
      <MapRendererAccess inline={inline} onAccept={() => { document.body.dataset.accepted = "true"; }} />
    </div>
  </main>,
);
