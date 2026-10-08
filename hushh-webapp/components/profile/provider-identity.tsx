"use client";

import type { User } from "firebase/auth";
import { BriefcaseIcon as BriefcaseBusiness, UserCircleIcon as UserIcon } from "@/components/icons";
import { Icon } from "@/lib/morphy-ux/ui";
import { AppleIcon, GoogleIcon } from "@/lib/morphy-ux/social-icons";
import { shouldUseGoogleBrandMark } from "@/lib/profile/profile-auth-provider-presentation";

export function getProvider(user: User | null) {
  if (!user?.providerData || user.providerData.length === 0) {
    return { name: "Unknown", id: "unknown" };
  }

  const providerId = user.providerData[0]?.providerId;
  switch (providerId) {
    case "google.com":
      return { name: "Google", id: "google" };
    case "apple.com":
      return { name: "Apple", id: "apple" };
    case "password":
      return { name: "Mail/Password", id: "password" };
    default:
      return { name: providerId || "Unknown", id: providerId || "unknown" };
  }
}

export function ProviderIcon({
  providerId,
  email,
}: {
  providerId: string;
  email: string | null | undefined;
}) {
  if (providerId === "google") {
    if (shouldUseGoogleBrandMark(providerId, email)) {
      return <GoogleIcon className="shrink-0" size={17} />;
    }

    return <Icon icon={BriefcaseBusiness} size="xs" className="shrink-0" />;
  }

  if (providerId === "apple") {
    return <AppleIcon className="shrink-0" size={17} />;
  }

  return <Icon icon={UserIcon} size="xs" className="shrink-0" />;
}
