import { RouteLoadingState } from "@/components/app-ui/route-loading-state";

export default function LoginLoading() {
  return <RouteLoadingState surface="onboarding" label="Preparing sign in…" />;
}
