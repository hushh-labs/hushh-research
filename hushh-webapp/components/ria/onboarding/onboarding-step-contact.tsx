"use client";

import { MapPin, Sparkles } from "lucide-react";
import { cn } from "@/lib/utils";

interface OnboardingStepContactProps {
  contactEmail: string;
  contactPhone: string;
  city: string;
  areaLocality: string;
  fullStreetAddress: string;
  onEmailChange: (value: string) => void;
  onPhoneChange: (value: string) => void;
  onCityChange: (value: string) => void;
  onAreaLocalityChange: (value: string) => void;
  onFullStreetAddressChange: (value: string) => void;
}

export function OnboardingStepContact({
  contactEmail,
  contactPhone,
  city,
  areaLocality,
  fullStreetAddress,
  onEmailChange,
  onPhoneChange,
  onCityChange,
  onAreaLocalityChange,
  onFullStreetAddressChange,
}: OnboardingStepContactProps) {
  return (
    <div className="space-y-6">
      <div className="space-y-2">
        <label className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">
          Email Address
        </label>
        <div className="relative flex items-center">
          <input
            type="email"
            value={contactEmail}
            onChange={(e) => onEmailChange(e.target.value)}
            placeholder="name@company.com"
            className={cn(
              "h-11 w-full rounded-[22px] border border-border/70 bg-background/60 px-4 pr-24 text-sm",
              "placeholder:text-muted-foreground/50 focus:outline-none focus:ring-2 focus:ring-ring/30"
            )}
          />
          <button
            type="button"
            className="absolute right-2 rounded-full bg-muted px-3 py-1.5 text-sm text-muted-foreground"
          >
            Send OTP
          </button>
        </div>
      </div>

      <div className="space-y-2">
        <label className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">
          Phone Number
        </label>
        <div className="relative flex items-center">
          <span className="absolute left-3 rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">
            US +1
          </span>
          <input
            type="tel"
            value={contactPhone}
            onChange={(e) => onPhoneChange(e.target.value)}
            placeholder="(555) 000-0000"
            className={cn(
              "h-11 w-full rounded-[22px] border border-border/70 bg-background/60 pl-[72px] pr-24 text-sm",
              "placeholder:text-muted-foreground/50 focus:outline-none focus:ring-2 focus:ring-ring/30"
            )}
          />
          <button
            type="button"
            className="absolute right-2 rounded-full bg-muted px-3 py-1.5 text-sm text-muted-foreground"
          >
            Send OTP
          </button>
        </div>
      </div>

      <div className="space-y-4">
        <label className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">
          Business Location
        </label>

        <div className="space-y-2">
          <label className="text-[10px] font-medium uppercase tracking-widest text-muted-foreground/70">
            City (Auto-Filled)
          </label>
          <input
            type="text"
            value={city}
            onChange={(e) => onCityChange(e.target.value)}
            className={cn(
              "h-11 w-full rounded-[22px] border border-border/70 bg-background/60 px-4 text-sm",
              "placeholder:text-muted-foreground/50 focus:outline-none focus:ring-2 focus:ring-ring/30"
            )}
          />
        </div>

        <div className="space-y-2">
          <label className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">
            Area / Locality
          </label>
          <input
            type="text"
            value={areaLocality}
            onChange={(e) => onAreaLocalityChange(e.target.value)}
            placeholder="e.g., Downtown, Mission District"
            className={cn(
              "h-11 w-full rounded-[22px] border border-border/70 bg-background/60 px-4 text-sm",
              "placeholder:text-muted-foreground/50 focus:outline-none focus:ring-2 focus:ring-ring/30"
            )}
          />
        </div>

        <div className="space-y-2">
          <label className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">
            Full Street Address
          </label>
          <input
            type="text"
            value={fullStreetAddress}
            onChange={(e) => onFullStreetAddressChange(e.target.value)}
            placeholder="Building, Floor, Street..."
            className={cn(
              "h-11 w-full rounded-[22px] border border-border/70 bg-background/60 px-4 text-sm",
              "placeholder:text-muted-foreground/50 focus:outline-none focus:ring-2 focus:ring-ring/30"
            )}
          />
        </div>
      </div>

      <div className="relative overflow-hidden rounded-[24px] bg-muted/30 h-32 flex items-center justify-center">
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <MapPin className="h-4 w-4" />
          <span>Map preview</span>
        </div>
        <button
          type="button"
          className="absolute bottom-3 right-3 flex items-center gap-1.5 rounded-full bg-background/80 border border-border/70 px-3 py-1.5 text-xs font-medium text-foreground backdrop-blur-sm"
        >
          <MapPin className="h-3 w-3" />
          Adjust Pin
        </button>
      </div>

      <div className="flex items-center gap-2 rounded-full border border-dashed border-[#0071E3]/30 px-3 py-1.5 w-fit">
        <Sparkles className="h-3.5 w-3.5 text-[#0071E3]" />
        <span className="text-sm text-[#0071E3]">
          Kai: Want me to find your address from...
        </span>
      </div>
    </div>
  );
}
