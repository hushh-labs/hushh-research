import { createRoot } from "react-dom/client";
import { NativeFeaturePage } from "../../components/app-ui/native-feature-page";

createRoot(document.getElementById("root")!).render(
  <NativeFeaturePage pane={document.getElementById("root")!.dataset.pane === "true"} open title="Preferences" owner="synthetic" context="synthetic" onBack={() => undefined}
    onClose={document.getElementById("root")!.dataset.pane === "true" ? () => undefined : undefined}>
    <p>Public preference choices</p>
  </NativeFeaturePage>,
);
