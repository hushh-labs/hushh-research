"use client";

import { useState } from "react";
import { Check, ChevronDown } from "lucide-react";
import { useRouter } from "next/navigation";

import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { AgentSectionIcon } from "@/components/app-ui/agent-section-icon";
import {
  TOP_SHELL_DROPDOWN_COLLISION_PADDING,
  TOP_SHELL_DROPDOWN_CONTENT_CLASSNAME,
} from "@/components/app-ui/top-shell-dropdown";
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
  const [open, setOpen] = useState(false);
  const sections = getAgentSections();
  const lastAgentSectionId = useKaiSession((s) => s.lastAgentSectionId);
  const setAgentNavigationContext = useKaiSession(
    (s) => s.setAgentNavigationContext,
  );
  const currentSection = currentAgentSection(pathname, lastAgentSectionId);

  const handleNavigate = (section: AgentSection) => {
    setOpen(false);
    setAgentNavigationContext({
      scope: section.bottomNavScope,
      sectionId: section.id,
    });
    router.push(section.href);
  };

  return (
    <Popover open={open} onOpenChange={setOpen} modal={false}>
      <PopoverTrigger asChild>
        <button
          type="button"
          role="combobox"
          aria-expanded={open}
          aria-controls="agent-section-command-list"
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
      </PopoverTrigger>
      <PopoverContent
        align="start"
        collisionPadding={TOP_SHELL_DROPDOWN_COLLISION_PADDING}
        className={cn(TOP_SHELL_DROPDOWN_CONTENT_CLASSNAME, "w-[300px]")}
      >
        <Command className="bg-transparent">
          <CommandInput
            placeholder="Search agents..."
            data-testid="agent-section-search"
          />
          <CommandList id="agent-section-command-list" className="max-h-[340px] px-1 pb-2">
            <CommandEmpty>No agent found.</CommandEmpty>
            <CommandGroup heading="Agents">
              {sections.map((section) => {
                const active = section.id === currentSection.id;
                return (
                  <CommandItem
                    key={section.id}
                    value={section.label}
                    onSelect={() => handleNavigate(section)}
                    data-voice-control-id={section.controlId}
                    data-testid={section.controlId}
                    className="group gap-2 rounded-lg"
                  >
                    <AgentSectionIcon
                      id={section.id}
                      icon={section.icon}
                      tone={section.tone}
                      size="menu"
                    />
                    <span className="min-w-0 flex-1 truncate">
                      {section.label}
                    </span>
                    {active ? (
                      <Check className="ml-auto h-4 w-4 shrink-0 text-current" />
                    ) : null}
                  </CommandItem>
                );
              })}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
