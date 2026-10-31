import { HushhLoader } from "@/components/app-ui/hushh-loader";

/**
 * The phone flow owns its explicit auth and verification states. While this
 * segment resolves (the phone guard has just redirected here), keep the boot
 * surface on the phone stage it is already showing rather than a frame with no
 * stage held.
 */
export default function RegisterPhoneLoading() {
  return <HushhLoader stage="phone" label="Opening phone verification..." />;
}
