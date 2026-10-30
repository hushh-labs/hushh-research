"use client";

import { useState } from "react";
import { FolderSearch, RefreshCw } from "lucide-react";

import { NativeTestBeacon } from "@/components/app-ui/native-test-beacon";
import { PkmExplorerPanel } from "@/components/profile/pkm-explorer-panel";
import { PkmNaturalPanel } from "@/components/profile/pkm-natural-panel";
import { PkmSettingsShell } from "@/components/profile/pkm-settings-shell";
import { SettingsSegmentedTabs } from "@/components/profile/settings-ui";
import { Button } from "@/lib/morphy-ux/morphy";

type PkmView = "natural" | "explorer";

export default function PkmPage() {
  const [view, setView] = useState<PkmView>("natural");
  const [refreshToken, setRefreshToken] = useState(0);

  return (
    <PkmSettingsShell
      eyebrow="One / PKM"
      title="Saved Intelligence"
      description="Review your saved profile intelligence, inspect encrypted PKM domains, and manage what can be reused."
      actions={
        <div className="flex flex-wrap items-center gap-2">
          <SettingsSegmentedTabs
            value={view}
            onValueChange={(value) => setView(value as PkmView)}
            options={[
              { value: "natural", label: "Readable" },
              { value: "explorer", label: "Explorer" },
            ]}
          />
          <Button
            type="button"
            size="sm"
            variant="none"
            effect="fade"
            onClick={() => setRefreshToken((value) => value + 1)}
          >
            <RefreshCw className="mr-2 h-4 w-4" aria-hidden />
            Refresh
          </Button>
        </div>
      }
    >
      <NativeTestBeacon
        routeId="/one/pkm"
        marker="native-route-pkm"
        authState="authenticated"
        dataState="loaded"
      />
      {view === "natural" ? (
        <PkmNaturalPanel refreshToken={refreshToken} onOpenExplorer={() => setView("explorer")} />
      ) : (
        <div className="space-y-3">
          <div className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
            <FolderSearch className="h-4 w-4" aria-hidden />
            Domain explorer
          </div>
          <PkmExplorerPanel />
        </div>
      )}
    </PkmSettingsShell>
  );
}
