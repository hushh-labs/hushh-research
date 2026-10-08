import { AppPageContentRegion, AppPageShell } from "@/components/app-ui/app-page-shell";
import { CapabilityVaultPrerequisite } from "@/components/vault/capability-vault-prerequisite";
import { PublicProfileReviewWorkspace } from "@/components/profile/public-profile-review-workspace";
import { ROUTES } from "@/lib/navigation/routes";

export default function OnePublicProfileDiscoveryPage() {
  return (
    <CapabilityVaultPrerequisite capabilityLabel="Profile review" routeKey={ROUTES.ONE_PROFILE_DISCOVERY}>
      <AppPageShell
        as="main"
        width="reading"
        nativeTest={{
          routeId: ROUTES.ONE_PROFILE_DISCOVERY,
          marker: "native-route-profile-discovery",
          authState: "authenticated",
          dataState: "loaded",
        }}
      >
        <AppPageContentRegion>
          <PublicProfileReviewWorkspace />
        </AppPageContentRegion>
      </AppPageShell>
    </CapabilityVaultPrerequisite>
  );
}
