"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

import { HushhLoader } from "@/components/app-ui/hushh-loader";
import { NativeRouteMarker } from "@/components/app-ui/native-route-marker";
import { OneSetupHub } from "@/components/onboarding/setup/one-setup-hub";
import { useAuth } from "@/lib/firebase/auth-context";
import { ROUTES } from "@/lib/navigation/routes";

export default function OneSetupPage() {
  const router = useRouter();
  const { user, loading } = useAuth();

  useEffect(() => {
    if (!loading && !user) {
      router.replace(
        `${ROUTES.LOGIN}?redirect=${encodeURIComponent(ROUTES.ONE_SETUP)}`,
      );
    }
  }, [loading, router, user]);

  if (loading || !user) {
    return <HushhLoader label="Opening setup..." variant="fullscreen" />;
  }

  return (
    <>
      <NativeRouteMarker
        routeId="/one/setup"
        marker="native-route-one-setup"
        authState="authenticated"
        dataState="loaded"
      />
      <OneSetupHub />
    </>
  );
}
