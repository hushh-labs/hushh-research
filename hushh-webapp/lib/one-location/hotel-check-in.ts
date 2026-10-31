import { resolveAppEnvironment } from "@/lib/app-env";

export type OneHotelCheckInStay = {
  stayId: string;
  propertyName: string;
  arrivalLabel?: string | null;
  checkInWindowLabel?: string | null;
};

export type OneHotelCheckInEligibility =
  | {
      eligible: true;
      stay: OneHotelCheckInStay;
    }
  | {
      eligible: false;
      reason:
        | "feature_disabled"
        | "demo_disabled"
        | "missing_stay"
        | "unsupported_stay"
        | "provider_unavailable";
    };

export type OneHotelCheckInProvider = {
  findEligibleStay(input: {
    userId: string;
    stayId: string;
  }): Promise<OneHotelCheckInEligibility>;
};

function isExplicitTrue(value: string | undefined): boolean {
  return value?.trim().toLowerCase() === "true";
}

export function isOneHotelCheckInEnabled(): boolean {
  return isExplicitTrue(
    process.env.ONE_HOTEL_CHECK_IN_ENABLED ??
      process.env.NEXT_PUBLIC_ONE_HOTEL_CHECK_IN_ENABLED,
  );
}

export function isOneHotelCheckInUatDemoEnabled(): boolean {
  return (
    resolveAppEnvironment() !== "production" &&
    isExplicitTrue(
      process.env.ONE_HOTEL_CHECK_IN_UAT_DEMO_ENABLED ??
        process.env.NEXT_PUBLIC_ONE_HOTEL_CHECK_IN_UAT_DEMO_ENABLED,
    )
  );
}

export const noOpHotelCheckInProvider: OneHotelCheckInProvider = {
  async findEligibleStay({ stayId }) {
    return {
      eligible: false,
      reason: stayId ? "provider_unavailable" : "missing_stay",
    };
  },
};

export async function resolveOneHotelCheckInEligibility(input: {
  userId: string | null | undefined;
  stayId: string | null | undefined;
  provider?: OneHotelCheckInProvider;
}): Promise<OneHotelCheckInEligibility> {
  const stayId = input.stayId?.trim();
  if (!isOneHotelCheckInEnabled()) {
    return { eligible: false, reason: "feature_disabled" };
  }
  if (!stayId || !input.userId) {
    return { eligible: false, reason: "missing_stay" };
  }
  const provider = input.provider ?? noOpHotelCheckInProvider;
  return provider.findEligibleStay({ userId: input.userId, stayId });
}
