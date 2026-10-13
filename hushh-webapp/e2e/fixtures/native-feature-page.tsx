import { createRoot } from "react-dom/client";
import { NativeFeaturePage } from "../../components/app-ui/native-feature-page";

createRoot(document.getElementById("root")!).render(
  <NativeFeaturePage open title="Preferences" owner="synthetic" context="synthetic" onBack={() => undefined}>
    <p>Public preference choices</p>
  </NativeFeaturePage>,
);
