import type {
  ObservabilityAdapter,
} from "@/lib/observability/events";

export const nativeFirebaseAdapter: ObservabilityAdapter = {
  name: "native-firebase",

  isAvailable(): boolean {
    return false;
  },

  async track(): Promise<void> {},
};
