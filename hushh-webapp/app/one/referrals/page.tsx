"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

import { HushhLoader } from "@/components/app-ui/hushh-loader";
import { ReferralDashboardPage } from "@/components/referrals/referral-dashboard-page";
import { useAuth } from "@/lib/firebase/auth-context";
import { ROUTES } from "@/lib/navigation/routes";

export default function OneReferralsPage() {
  const router = useRouter();
  const { user, loading } = useAuth();

  useEffect(() => {
    if (!loading && !user) {
      router.replace(
        `${ROUTES.LOGIN}?redirect=${encodeURIComponent(ROUTES.ONE_REFERRALS)}`,
      );
    }
  }, [loading, router, user]);

  if (loading || !user) {
    return <HushhLoader variant="page" label="Opening Referrals…" />;
  }

  return <ReferralDashboardPage />;
}
