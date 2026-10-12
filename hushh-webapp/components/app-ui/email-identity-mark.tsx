"use client";

import { useState } from "react";
import Image from "next/image";

import { UserRound } from "@/components/icons";
import { Icon } from "@/lib/morphy-ux/ui";
import { AppleIcon, GoogleIcon } from "@/lib/morphy-ux/social-icons";
import { resolveEmailDomainBrand } from "@/lib/profile/email-domain-brands";
import { shouldUseGoogleBrandMark } from "@/lib/profile/profile-auth-provider-presentation";

/** Email-domain artwork is presentation, never an affiliation or trust badge. */
export function EmailIdentityMark({ email, providerId, size = 17 }: {
  email: string | null | undefined;
  providerId?: string | null;
  size?: number;
}) {
  const brand = resolveEmailDomainBrand(email);
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  const apple = providerId === "apple" || providerId === "apple.com";
  const google = providerId === "google" || providerId === "google.com";
  const showBrand = brand && brand.src !== failedSrc;
  const label = showBrand ? `${brand.name} email domain`
    : apple ? "Apple account" : google ? "Google account" : "Signed-in account";

  return (
    <span role="img" aria-label={label} className="inline-flex shrink-0 items-center justify-center text-foreground">
      {showBrand ? (
        <Image src={brand.src} alt="" width={size} height={size} unoptimized
          className="object-contain" onError={() => setFailedSrc(brand.src)} />
      ) : shouldUseGoogleBrandMark(providerId, email) ? <GoogleIcon size={size} />
        : apple ? <AppleIcon size={size} /> : <Icon icon={UserRound} size={size} />}
    </span>
  );
}
