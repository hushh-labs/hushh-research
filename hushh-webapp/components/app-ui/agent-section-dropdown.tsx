"use client";

import { Check, ChevronDown } from "lucide-react";
import { useRouter } from "next/navigation";

import {
  DropdownMenu,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { AgentSectionIcon } from "@/components/app-ui/agent-section-icon";
import { TopShellDropdownContent } from "@/components/app-ui/top-shell-dropdown";
import {
  getAgentSection,
  getAgentSections,
  getAgentsRootSection,
  resolveAgentSectionForPath,
  type AgentSection,
} from "@/lib/navigation/agent-sections";
import { useKaiSession } from "@/lib/stores/kai-session-store";
import { cn } from "@/lib/utils";

interface AgentSectionDropdownProps {
  pathname: string | null | undefined;
  className?: string;
}

function currentAgentSection(
  pathname: string | null | undefined,
  lastAgentSectionId: string | null,
): AgentSection {
  return (
    resolveAgentSectionForPath(pathname) ??
    getAgentSection(lastAgentSectionId) ??
    getAgentsRootSection()
  );
}

export function AgentSectionDropdown({
  pathname,
  className,
}: AgentSectionDropdownProps) {
  const router = useRouter();
  const sections = getAgentSections();
  const lastAgentSectionId = useKaiSession((s) => s.lastAgentSectionId);
  const setAgentNavigationContext = useKaiSession(
    (s) => s.setAgentNavigationContext,
  );
  const currentSection = currentAgentSection(pathname, lastAgentSectionId);

  const handleNavigate = (section: AgentSection) => {
    setAgentNavigationContext({
      scope: section.bottomNavScope,
      sectionId: section.id,
    });
    router.push(section.href);
  };

  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label="Switch agent section"
          data-testid="top-agent-section-dropdown"
          data-voice-control-id="top_agent_section_dropdown"
          className={cn(
            "group inline-flex h-9 max-w-[9.75rem] min-w-0 items-center justify-center gap-1.5 rounded-full px-1 text-[14px] font-medium tracking-normal text-[#1d1d1f] transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/70 focus-visible:ring-offset-2 focus-visible:ring-offset-background dark:text-[#f5f5f7] sm:max-w-[12rem] sm:gap-2 sm:text-base",
            className,
          )}
        >
          <AgentSectionIcon
            id={currentSection.id}
            icon={currentSection.icon}
            tone={currentSection.tone}
            size="topbar"
          />
          <span className="truncate">{currentSection.label}</span>
          <ChevronDown className="h-4 w-4 shrink-0 text-current/70 transition-colors group-hover:text-current" />
        </button>
      </DropdownMenuTrigger>
      <TopShellDropdownContent align="start" className="w-[300px]">
        <div className="px-3 pb-1 pt-3 text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
          Agents
        </div>
        <div className="px-2 pb-2">
          {sections.map((section) => {
            const active = section.id === currentSection.id;
            return (
              <DropdownMenuItem
                key={section.id}
                onSelect={() => handleNavigate(section)}
                data-voice-control-id={section.controlId}
                data-testid={section.controlId}
                className="group"
              >
                <div className="relative z-10 flex min-w-0 items-center gap-2 text-current">
                  <AgentSectionIcon
                    id={section.id}
                    icon={section.icon}
                    tone={section.tone}
                    size="menu"
                  />
                  <span className="truncate">{section.label}</span>
                </div>
                {active ? (
                  <Check className="ml-auto h-4 w-4 shrink-0 text-current" />
                ) : null}
              </DropdownMenuItem>
            );
          })}
        </div>
      </TopShellDropdownContent>
    </DropdownMenu>
  );
}
