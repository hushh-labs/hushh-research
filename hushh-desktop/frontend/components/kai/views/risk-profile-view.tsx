// components/kai/views/risk-profile-view.tsx

/**
 * Risk Profile View - Quick risk profile selection after portfolio import
 *
 * Allows users to set their risk tolerance which affects Kai's recommendations.
 */

"use client";

import { Card, CardHeader, CardTitle, CardDescription, CardContent, CardFooter } from "@/lib/morphy-ux/card";
import { Button as MorphyButton } from "@/lib/morphy-ux/button";

import { Shield, Scale, TrendingUp } from "lucide-react";
import { cn } from "@/lib/utils";


// =============================================================================
// TYPES
// =============================================================================

export type RiskProfile = "conservative" | "balanced" | "aggressive";

interface RiskProfileViewProps {
  onSelect: (profile: RiskProfile) => void;
  onSkip: () => void;
  currentProfile?: RiskProfile;
}

// =============================================================================
// MAIN COMPONENT
// =============================================================================

export function RiskProfileView({
  onSelect,
  onSkip,
  currentProfile,
}: RiskProfileViewProps) {
  const profiles: {
    id: RiskProfile;
    icon: typeof Shield;
    title: string;
    description: string;
    color: string;
  }[] = [
    {
      id: "conservative",
      icon: Shield,
      title: "Conservative",
      description: "Prioritize capital preservation. Lower volatility, steady returns.",
      color: "text-emerald-500",
    },
    {
      id: "balanced",
      icon: Scale,
      title: "Balanced",
      description: "Mix of growth and stability. Moderate risk tolerance.",
      color: "text-amber-500",
    },
    {
      id: "aggressive",
      icon: TrendingUp,
      title: "Aggressive",
      description: "Maximize growth potential. Higher volatility tolerance.",
      color: "text-red-500",
    },
  ];

  return (
    <div className="w-full max-w-2xl mx-auto p-6">
      <Card variant="none" effect="glass" showRipple={false}>
        <CardHeader className="text-center">
          <CardTitle className="text-2xl">Set Your Risk Profile</CardTitle>
          <CardDescription>
            This helps Kai tailor recommendations to your investment style.
            You can change this anytime from your profile.
          </CardDescription>
        </CardHeader>

        <CardContent className="space-y-3">
          {profiles.map(({ id, icon: Icon, title, description, color }) => (
            <MorphyButton
              key={id}
              asChild
              variant="none"
              effect="glass"
              onClick={() => onSelect(id)}
              className={cn(
                "w-full text-left h-auto p-4 rounded-xl border transition-all flex items-center gap-4 group cursor-pointer",
                currentProfile === id
                  ? "border-primary bg-primary/10"
                  : "border-border hover:border-primary/50 hover:bg-primary/5"
              )}
            >
              <div className="w-full flex items-center gap-4">
                <div
                  className={cn(
                    "w-12 h-12 rounded-xl flex items-center justify-center transition-colors",
                    currentProfile === id
                      ? "bg-primary/20"
                      : "bg-muted group-hover:bg-primary/10",
                    color
                  )}
                >
                  <Icon size={24} />
                </div>
                <div className="flex-1">
                  <h3 className="font-semibold">{title}</h3>
                  <p className="text-sm text-muted-foreground">{description}</p>
                </div>
                {currentProfile === id && (
                  <div className="w-6 h-6 rounded-full bg-primary flex items-center justify-center shrink-0">
                    <svg
                      className="w-4 h-4 text-white"
                      fill="none"
                      viewBox="0 0 24 24"
                      stroke="currentColor"
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={2}
                        d="M5 13l4 4L19 7"
                      />
                    </svg>
                  </div>
                )}
              </div>
            </MorphyButton>
          ))}

        </CardContent>

        <CardFooter className="flex justify-between">
          <MorphyButton
            variant="none"
            effect="glass"
            onClick={onSkip}
            className="text-muted-foreground"
          >
            Skip for now
          </MorphyButton>

          <p className="text-xs text-muted-foreground">
            Select a profile to continue
          </p>
        </CardFooter>
      </Card>
    </div>
  );
}
