import { HushhLoader } from "@/components/app-ui/hushh-loader";

/**
 * Login owns its cold authentication feedback through AuthStep. While this
 * segment resolves (a guard has just redirected here), keep the boot surface
 * on the redirect it is already showing: an empty fallback was a frame with no
 * stage held, which started the surface's exit between two steps of one boot.
 */
export default function LoginLoading() {
  return <HushhLoader stage="redirect" label="Opening sign in..." />;
}
