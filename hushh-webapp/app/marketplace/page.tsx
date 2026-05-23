"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import {
  ArrowLeftRight,
  ArrowUpRight,
  Building2,
  Compass,
  List,
  RotateCcw,
  Search,
  ShieldCheck,
  UserRound,
  X,
} from "lucide-react";

import { AppPageContentRegion, AppPageHeaderRegion, AppPageShell } from "@/components/app-ui/app-page-shell";
import { PageHeader } from "@/components/app-ui/page-sections";
import { SettingsDetailPanel } from "@/components/profile/settings-ui";
import { RiaSurface } from "@/components/ria/ria-page-shell";
import { Input } from "@/components/ui/input";
import { useAuth } from "@/hooks/use-auth";
import { resolveAppEnvironment } from "@/lib/app-env";
import { Button } from "@/lib/morphy-ux/button";
import { cn } from "@/lib/utils";
import { 
  buildMarketplaceConnectionsRoute, 
  buildRiaClientWorkspaceRoute 
} from "@/lib/navigation/routes";
import { RiaService, type MarketplaceInvestor, type MarketplaceRia } from "@/lib/services/ria-service";
import { usePersonaState } from "@/lib/persona/persona-context";

// --- Missing Type Definitions ---
type DiscoveryView = "swipe" | "list";

type SelectedProfile =
  | { kind: "ria"; id: string }
  | { kind: "investor"; id: string };

type DiscoveryCard = {
  id: string;
  kind: "ria" | "investor";
  title: string;
  headline: string;
  summary: string;
  metaLine: string;
  canConnect: boolean;
  isTestProfile?: boolean;
  verificationStatus?: string | null;
  profile: MarketplaceRia | MarketplaceInvestor;
};

export default function MarketplacePage() {
  const router = useRouter();
  const { user } = useAuth();
  const { personaState } = usePersonaState();
  const [view, setView] = useState<DiscoveryView>("swipe");
  const [query, setQuery] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [selectedProfile, setSelectedProfile] = useState<SelectedProfile | null>(null);
  
  // --- Derived Constants ---
  const connectionsRoute = buildMarketplaceConnectionsRoute({ tab: "active" });
  const currentPersona = personaState?.active_persona || "investor";
  const directoryKind = currentPersona === "ria" ? "investors" : "rias";

  // Mock state variables for demo logic
  const [rias] = useState<MarketplaceRia[]>([]);
  const [investors] = useState<MarketplaceInvestor[]>([]);
  const [iamUnavailable] = useState(false);

  return (
    <AppPageShell
      as="main"
      width="standard"
      className="pb-36"
      nativeTest={{
        routeId: "/marketplace",
        marker: "native-route-marketplace",
        authState: user ? "authenticated" : "pending",
        dataState: loading ? "loading" : "loaded",
      }}
    >
      <AppPageHeaderRegion>
        <PageHeader
          eyebrow="Connect"
          title={currentPersona === "ria" ? "Find investors" : "Find advisors"}
          description="Public discovery first. Private access only after consent."
          icon={Compass}
          accent="marketplace"
          actions={
            <Button variant="none" effect="fade" size="sm" onClick={() => router.push(connectionsRoute)}>
              Connections
            </Button>
          }
        />
      </AppPageHeaderRegion>

      <AppPageContentRegion className="space-y-4 pb-24 pt-0">
        {/* Toggle UI */}
        <div className="flex items-center gap-2">
            <button onClick={() => setView("swipe")}>Swipe</button>
            <button onClick={() => setView("list")}>List</button>
        </div>

        {/* Rectified SettingsDetailPanel */}
        <SettingsDetailPanel
          className={cn("fixed inset-0 z-50 transition-opacity", selectedProfile ? "opacity-100" : "opacity-0 pointer-events-none")}
        >
          <div className="absolute inset-0 bg-black/50" onClick={() => setSelectedProfile(null)} />
          <div className="relative mx-auto mt-20 w-full max-w-lg bg-card p-6 shadow-xl rounded-2xl">
             <h2 className="text-xl font-bold">Profile Details</h2>
             <Button onClick={() => setSelectedProfile(null)}>Close</Button>
          </div>
        </SettingsDetailPanel>
      </AppPageContentRegion>
    </AppPageShell>
  );
}