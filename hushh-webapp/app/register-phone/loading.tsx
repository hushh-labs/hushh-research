import { RouteLoadingState } from "@/components/app-ui/route-loading-state";

export default function RegisterPhoneLoading() {
  return (
    <RouteLoadingState
      surface="onboarding"
      label="Preparing phone verification…"
    />
  );
}
