"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Cable,
  ClipboardCopy,
  Code2,
  Globe,
  KeyRound,
  LifeBuoy,
  LockKeyhole,
  Menu,
  RefreshCcw,
  ScanSearch,
  ShieldCheck,
  Workflow,
} from "lucide-react";
import { toast } from "sonner";

import { useIsMobile } from "@/hooks/use-mobile";
import { useAuth } from "@/hooks/use-auth";
import { AuthService } from "@/lib/services/auth-service";
import { AppleIcon, GoogleIcon } from "@/lib/morphy-ux/social-icons";
import { Button as MorphyButton } from "@/lib/morphy-ux/button";
import {
  buildIntegrationModes,
  buildMcpSnippets,
  buildRestSnippets,
  buildWorkspaceSnippets,
  CONSENT_FLOW_STEPS,
  DEVELOPER_ACCESS_NOTES,
  DEVELOPER_SAMPLE_PAYLOADS,
  DEVELOPER_SECTIONS,
  DEVELOPER_SCOPE_NOTES,
  FAQ_ITEMS,
  MCP_PUBLIC_LINKS,
  PUBLIC_SCOPE_PATTERNS,
  PUBLIC_MCP_ENVIRONMENT,
  PUBLIC_RESOURCE_URIS,
  PUBLIC_TOOL_NAMES,
  REST_ENDPOINTS,
} from "@/lib/developers/content";
import { resolveDeveloperRuntime, type DeveloperRuntime } from "@/lib/developers/runtime";
import { ROUTES } from "@/lib/navigation/routes";
import {
  DeveloperPortalRequestError,
  enableDeveloperAccess,
  getDeveloperAccess,
  getLiveDeveloperDocs,
  rotateDeveloperAccessToken,
  updateDeveloperAccessProfile,
  type DeveloperPortalAccess,
  type LiveDocsResponse,
} from "@/lib/services/developer-portal-service";
import { copyToClipboard } from "@/lib/utils/clipboard";
import {
  AppPageContentRegion,
  AppPageHeaderRegion,
  AppPageShell,
} from "@/components/app-ui/app-page-shell";
import { PageHeader, SectionHeader } from "@/components/app-ui/page-sections";
import {
  SurfaceCard,
  SurfaceCardContent,
  SurfaceCardDescription,
  SurfaceCardHeader,
  SurfaceCardTitle,
  SurfaceInset,
} from "@/components/app-ui/surfaces";
import { AuthProviderButton } from "@/components/onboarding/AuthProviderButton";
import {
  SettingsGroup,
  SettingsRow,
  SettingsSegmentedTabs,
} from "@/components/profile/settings-ui";
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "@/components/ui/accordion";
import { Badge } from "@/components/ui/badge";
import { Drawer, DrawerContent, DrawerDescription, DrawerHeader, DrawerTitle } from "@/components/ui/drawer";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
  FieldSet,
  FieldSeparator,
} from "@/components/ui/field";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
  InputGroupText,
} from "@/components/ui/input-group";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";

type ProfileDraft = {
  display_name: string;
  website_url: string;
  brand_image_url: string;
  support_url: string;
  policy_url: string;
};

const EMPTY_PROFILE_DRAFT: ProfileDraft = {
  display_name: "",
  website_url: "",
  brand_image_url: "",
  support_url: "",
  policy_url: "",
};

const MOBILE_DEFAULT_OPEN_SECTIONS = ["overview", "modes", "access"];

function formatDeveloperAccessError(
  error: unknown,
  runtime: DeveloperRuntime,
  fallback: string
) {
  if (
    error instanceof DeveloperPortalRequestError &&
    (error.code === "DEVELOPER_API_DISABLED" ||
      error.code === "DEVELOPER_API_DISABLED_IN_PRODUCTION")
  ) {
    if (runtime.environment === "local") {
      return `Developer access is turned off on ${runtime.apiOrigin}. Start the backend with DEVELOPER_API_ENABLED=true, then refresh this page.`;
    }

    if (runtime.environment === "uat") {
      return `Developer access is not enabled on the current UAT backend yet. Turn on DEVELOPER_API_ENABLED for ${runtime.apiOrigin} and try again.`;
    }

    return "Developer access is not enabled on this production backend.";
  }

  return error instanceof Error ? error.message : fallback;
}

async function copyText(value: string, label: string) {
  try {
    const copied = await copyToClipboard(value);
    if (!copied) {
      throw new Error("clipboard_unavailable");
    }
    toast.success(`${label} copied`);
  } catch (error) {
    console.error("[developers] copy failed", error);
    toast.error(`Could not copy ${label.toLowerCase()}`);
  }
}

function scrollToSection(sectionId: string) {
  const target = document.getElementById(sectionId);
  if (!target) {
    return;
  }

  target.scrollIntoView({ behavior: "smooth", block: "start" });
  window.history.replaceState(null, "", `#${sectionId}`);
}

function addOpenSection(current: string[], sectionId: string) {
  return current.includes(sectionId) ? current : [...current, sectionId];
}

function removeOpenSection(current: string[], sectionId: string) {
  return current.filter((value) => value !== sectionId);
}

function findDeveloperSection(sectionId: string) {
  return DEVELOPER_SECTIONS.find((section) => section.id === sectionId);
}

function ContentsNav({
  onSelectSection,
  framed = true,
  compact = false,
  showSummaries = true,
}: {
  onSelectSection: (sectionId: string) => void;
  framed?: boolean;
  compact?: boolean;
  showSummaries?: boolean;
}) {
  const rows = DEVELOPER_SECTIONS.map((section) => (
    <SettingsRow
      key={section.id}
      title={
        <span className={compact ? "text-[13px] sm:text-sm" : undefined}>{section.label}</span>
      }
      description={
        showSummaries ? (
          <span className={compact ? "line-clamp-1 text-[11px] leading-5" : undefined}>
            {section.summary}
          </span>
        ) : undefined
      }
      chevron
      className={compact ? "px-3 py-2 sm:px-3.5 sm:py-2.5" : undefined}
      onClick={() => onSelectSection(section.id)}
    />
  ));

  if (!framed) {
    return (
      <SettingsGroup embedded className="space-y-0">
        {rows}
      </SettingsGroup>
    );
  }

  return (
    <SettingsGroup
      eyebrow="Contents"
      title="Jump between sections"
      description="Use the same page for the contract, setup snippets, and self-serve access."
    >
      {rows}
    </SettingsGroup>
  );
}

function RuntimeValueRow({
  label,
  value,
  copyLabel,
  isMobile,
}: {
  label: string;
  value: string;
  copyLabel: string;
  isMobile: boolean;
}) {
  if (isMobile) {
    return (
      <SurfaceInset className="min-w-0 space-y-3">
        <div className="flex items-center justify-between gap-3">
          <p className="text-[11px] font-semibold uppercase tracking-[0.24em] text-muted-foreground">
            {label}
          </p>
          <MorphyButton
            variant="none"
            effect="glass"
            size="sm"
            className="shrink-0"
            onClick={() => copyText(value, copyLabel)}
          >
            <ClipboardCopy className="size-4" />
            Copy
          </MorphyButton>
        </div>
        <div className="rounded-[18px] border border-border/60 bg-background/85 px-3 py-3 font-mono text-[12px] leading-6 text-foreground break-all">
          {value}
        </div>
      </SurfaceInset>
    );
  }

  return (
    <InputGroup>
      <InputGroupAddon>
        <InputGroupText>{label}</InputGroupText>
      </InputGroupAddon>
      <InputGroupInput readOnly value={value} />
      <InputGroupAddon align="inline-end">
        <InputGroupButton onClick={() => copyText(value, copyLabel)}>
          <ClipboardCopy className="size-4" />
          Copy
        </InputGroupButton>
      </InputGroupAddon>
    </InputGroup>
  );
}

function SnippetCard({
  title,
  description,
  note,
  code,
  copyLabel,
}: {
  title: string;
  description: string;
  note?: string;
  code: string;
  copyLabel: string;
}) {
  return (
    <SurfaceInset className="min-w-0 space-y-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="space-y-1">
          <h3 className="text-sm font-semibold text-foreground">{title}</h3>
          <p className="text-sm leading-6 text-muted-foreground">{description}</p>
          {note ? (
            <p className="text-[11px] uppercase tracking-[0.18em] text-muted-foreground/80">
              {note}
            </p>
          ) : null}
        </div>
        <MorphyButton
          variant="none"
          effect="glass"
          size="sm"
          className="w-full sm:w-auto"
          onClick={() => copyText(code, copyLabel)}
        >
          <ClipboardCopy className="size-4" />
          Copy
        </MorphyButton>
      </div>
      <div className="min-w-0 w-full overflow-x-auto overscroll-x-contain rounded-2xl border border-border/70 bg-slate-950/95">
        <pre className="min-w-max whitespace-pre px-4 py-4 text-xs leading-6 text-slate-100">
          <code>{code}</code>
        </pre>
      </div>
    </SurfaceInset>
  );
}

function DeveloperSectionShell({
  sectionId,
  header,
  children,
  isMobile,
  mobileOpenSections,
  onMobileSectionChange,
}: {
  sectionId: string;
  header: React.ReactNode;
  children: React.ReactNode;
  isMobile: boolean;
  mobileOpenSections: string[];
  onMobileSectionChange: (sectionId: string, isOpen: boolean) => void;
}) {
  const section = findDeveloperSection(sectionId);

  if (!section) {
    return null;
  }

  if (!isMobile) {
    return (
      <section
        id={sectionId}
        className="scroll-mt-28 space-y-5 animate-in fade-in slide-in-from-bottom-2 duration-500"
      >
        {header}
        {children}
      </section>
    );
  }

  const isOpen = mobileOpenSections.includes(sectionId);

  return (
    <section id={sectionId} className="scroll-mt-24">
      <SurfaceCard className="animate-in fade-in slide-in-from-bottom-2 duration-500">
        <Accordion
          type="single"
          collapsible
          value={isOpen ? sectionId : undefined}
          onValueChange={(value) => onMobileSectionChange(sectionId, value === sectionId)}
          className="w-full"
        >
          <AccordionItem value={sectionId} className="border-b-0">
            <SurfaceCardHeader className="pb-2">
              <AccordionTrigger className="py-0 hover:no-underline">
                <div className="space-y-1 text-left">
                  <p className="text-[11px] font-semibold uppercase tracking-[0.24em] text-muted-foreground">
                    {section.label}
                  </p>
                  <p className="text-base font-semibold tracking-tight text-foreground">
                    {section.summary}
                  </p>
                </div>
              </AccordionTrigger>
            </SurfaceCardHeader>
            <AccordionContent className="pb-0">
              <SurfaceCardContent className="space-y-5 pt-2">
                {header}
                {children}
              </SurfaceCardContent>
            </AccordionContent>
          </AccordionItem>
        </Accordion>
      </SurfaceCard>
    </section>
  );
}

function SignedOutAccessCard({
  authLoading,
  onGoogle,
  onApple,
}: {
  authLoading: boolean;
  onGoogle: () => Promise<void>;
  onApple: () => Promise<void>;
}) {
  return (
    <SurfaceCard>
      <SurfaceCardContent className="pt-6">
        <Empty className="border-border/65 bg-background/65">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <LockKeyhole className="size-5" />
            </EmptyMedia>
            <EmptyTitle>Optional: unlock your personal developer workspace</EmptyTitle>
            <EmptyDescription>
              The docs and live contract stay open to everyone on this page. Sign in only when you
              want a personal developer token, editable app identity, and copy-ready snippets tied to your
              Kai account.
            </EmptyDescription>
          </EmptyHeader>
          <EmptyContent>
            <FieldGroup>
              <AuthProviderButton
                label="Continue with Google"
                icon={<GoogleIcon size={20} />}
                disabled={authLoading}
                onClick={onGoogle}
              />
              <FieldSeparator>Or</FieldSeparator>
              <AuthProviderButton
                label="Continue with Apple"
                icon={<AppleIcon size={20} />}
                disabled={authLoading}
                onClick={onApple}
              />
            </FieldGroup>
          </EmptyContent>
        </Empty>
      </SurfaceCardContent>
    </SurfaceCard>
  );
}

function AccessWorkspace({
  access,
  accessLoading,
  accessError,
  authLoading,
  runtime,
  signedInEmail,
  signedInDisplayName,
  profileDraft,
  profileSaving,
  revealedToken,
  isMobile,
  onEnable,
  onProfileDraftChange,
  onRotateKey,
  onSaveProfile,
  onSignOut,
}: {
  access: DeveloperPortalAccess | null;
  accessLoading: boolean;
  accessError: string | null;
  authLoading: boolean;
  runtime: DeveloperRuntime;
  signedInEmail?: string | null;
  signedInDisplayName?: string | null;
  profileDraft: ProfileDraft;
  profileSaving: boolean;
  revealedToken: string | null;
  isMobile: boolean;
  onEnable: () => Promise<void>;
  onProfileDraftChange: (field: keyof ProfileDraft, value: string) => void;
  onRotateKey: () => Promise<void>;
  onSaveProfile: () => Promise<void>;
  onSignOut: () => Promise<void>;
}) {
  const [workspaceTab, setWorkspaceTab] = useState<"overview" | "tokens" | "profile" | "contract">(
    "overview"
  );

  if (accessLoading) {
    return (
      <SurfaceCard>
        <SurfaceCardHeader>
          <SurfaceCardTitle>Developer workspace</SurfaceCardTitle>
          <SurfaceCardDescription>Loading your app identity and active token.</SurfaceCardDescription>
        </SurfaceCardHeader>
        <SurfaceCardContent className="space-y-4">
          <Skeleton className="h-24 rounded-3xl" />
          <Skeleton className="h-10 rounded-2xl" />
          <Skeleton className="h-10 rounded-2xl" />
        </SurfaceCardContent>
      </SurfaceCard>
    );
  }

  if (!access?.access_enabled) {
    return (
      <SurfaceCard>
        <SurfaceCardHeader>
          <SurfaceCardTitle>Enable self-serve developer access</SurfaceCardTitle>
          <SurfaceCardDescription>
            One developer app and one active token are created for your Kai account. Consent still
            happens user-by-user in Kai.
          </SurfaceCardDescription>
        </SurfaceCardHeader>
        <SurfaceCardContent className="space-y-5">
          <SurfaceInset className="space-y-2">
            <p className="text-xs font-semibold uppercase tracking-[0.24em] text-primary/80">
              Current Kai account
            </p>
            <p className="text-sm font-semibold text-foreground">
              {signedInDisplayName || signedInEmail || "Signed-in user"}
            </p>
            {signedInEmail ? (
              <p className="text-sm leading-6 text-muted-foreground">
                Developer access will be created for <code>{signedInEmail}</code>.
              </p>
            ) : (
              <p className="text-sm leading-6 text-muted-foreground">
                Developer access will be created for the Kai account currently signed in on this
                page.
              </p>
            )}
          </SurfaceInset>
          <Empty className="border-border/65 bg-background/65 py-10">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <KeyRound className="size-5" />
              </EmptyMedia>
              <EmptyTitle>Your developer workspace is not enabled yet</EmptyTitle>
              <EmptyDescription>
                Turn on access once and your app identity, developer token, and live setup snippets will be
                generated from this signed-in Kai account.
              </EmptyDescription>
            </EmptyHeader>
            <EmptyContent>
              <MorphyButton onClick={onEnable} disabled={authLoading} fullWidth>
                Enable developer access
              </MorphyButton>
              <MorphyButton
                variant="none"
                effect="glass"
                onClick={onSignOut}
                disabled={authLoading}
                fullWidth
              >
                Switch account
              </MorphyButton>
              {accessError ? (
                <p className="text-sm leading-6 text-destructive">{accessError}</p>
              ) : null}
            </EmptyContent>
          </Empty>
        </SurfaceCardContent>
      </SurfaceCard>
    );
  }

  return (
    <SurfaceCard>
      <SurfaceCardHeader>
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="space-y-1">
            <SurfaceCardTitle>Developer workspace</SurfaceCardTitle>
            <SurfaceCardDescription>
              Manage the identity users see in Kai, keep one active token, and copy setup
              snippets without leaving this page.
            </SurfaceCardDescription>
          </div>
          <div className="flex w-full flex-col gap-2 sm:w-auto sm:flex-row">
            <MorphyButton
              variant="none"
              effect="glass"
              size="sm"
              className="w-full sm:w-auto"
              onClick={onRotateKey}
            >
              <RefreshCcw className="size-4" />
              Rotate token
            </MorphyButton>
            <MorphyButton
              variant="none"
              effect="glass"
              size="sm"
              className="w-full sm:w-auto"
              onClick={onSignOut}
            >
              Sign out
            </MorphyButton>
          </div>
        </div>
      </SurfaceCardHeader>
      <SurfaceCardContent className="space-y-5">
        {accessError ? (
          <p className="rounded-2xl border border-destructive/20 bg-destructive/5 px-4 py-3 text-sm leading-6 text-destructive">
            {accessError}
          </p>
        ) : null}

        <div className="space-y-5">
          <SettingsSegmentedTabs
            value={workspaceTab}
            onValueChange={(value) =>
              setWorkspaceTab(value as "overview" | "tokens" | "profile" | "contract")
            }
            mobileColumns={2}
            options={[
              { value: "overview", label: "Overview" },
              { value: "tokens", label: "Tokens" },
              { value: "profile", label: "Profile" },
              { value: "contract", label: "Contract" },
            ]}
          />

          {workspaceTab === "overview" ? (
            <div className="space-y-4 animate-in fade-in slide-in-from-bottom-2 duration-300">
              <SurfaceInset className="grid gap-4 lg:grid-cols-2">
                <div className="space-y-2">
                  <p className="text-xs font-semibold uppercase tracking-[0.24em] text-primary/80">
                    App Identity
                  </p>
                  <h3 className="text-lg font-semibold text-foreground">
                    {access.app?.display_name || "Kai developer app"}
                  </h3>
                  <p className="text-sm leading-6 text-muted-foreground">
                    Agent id: <code>{access.app?.agent_id}</code>
                  </p>
                  <p className="text-sm leading-6 text-muted-foreground">
                    Contact email: <code>{access.app?.contact_email}</code>
                  </p>
                </div>
                <div className="space-y-2">
                  <p className="text-xs font-semibold uppercase tracking-[0.24em] text-primary/80">
                    Access Model
                  </p>
                  {DEVELOPER_ACCESS_NOTES.map((note) => (
                    <p key={note} className="text-sm leading-6 text-muted-foreground">
                      {note}
                    </p>
                  ))}
                </div>
              </SurfaceInset>
              <div className="space-y-3">
                <p className="text-sm font-semibold text-foreground">Current token</p>
                <RuntimeValueRow
                  label="Prefix"
                  value={access.active_token?.token_prefix || "No active token"}
                  copyLabel="Token prefix"
                  isMobile={isMobile}
                />
                {revealedToken ? (
                  <div className="rounded-2xl border border-amber-500/20 bg-amber-500/5 px-4 py-3 text-sm leading-6 text-amber-900 dark:text-amber-200">
                    <p className="font-medium">New token revealed once</p>
                    <p className="mt-1">
                      Save this now. It will not be shown again after you leave this page.
                    </p>
                    <div className="mt-3 flex flex-col gap-3 sm:flex-row sm:items-center">
                      <code className="block max-w-full overflow-x-auto whitespace-nowrap rounded-lg bg-background/80 px-3 py-2 text-xs">
                        {revealedToken}
                      </code>
                      <MorphyButton
                        variant="none"
                        effect="glass"
                        size="sm"
                        className="w-full sm:w-auto"
                        onClick={() => copyText(revealedToken, "Developer token")}
                      >
                        <ClipboardCopy className="size-4" />
                        Copy token
                      </MorphyButton>
                    </div>
                  </div>
                ) : null}
              </div>
            </div>
          ) : null}

          {workspaceTab === "tokens" ? (
            <div className="space-y-3 animate-in fade-in slide-in-from-bottom-2 duration-300">
                <p className="text-sm font-semibold text-foreground">Primary token setup</p>
                <RuntimeValueRow
                  label="MCP URL"
                  value={`${runtime.mcpUrl}?token=${revealedToken || "<developer-token>"}`}
                  copyLabel="Remote MCP URL"
                  isMobile={isMobile}
                />
                <RuntimeValueRow
                  label="Env"
                  value={`${access.developer_token_env_var}=${revealedToken || "<developer-token>"}`}
                  copyLabel="Developer env var"
                  isMobile={isMobile}
                />
              <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
                <MorphyButton
                  variant="none"
                  effect="glass"
                  size="sm"
                  className="w-full sm:w-auto"
                  onClick={onRotateKey}
                >
                  <RefreshCcw className="size-4" />
                  Rotate token
                </MorphyButton>
                <Badge variant="outline" className="justify-center px-3 py-1.5 text-xs sm:w-auto">
                  Prefix: {access.active_token?.token_prefix}
                </Badge>
              </div>
            </div>
          ) : null}

          {workspaceTab === "profile" ? (
            <SurfaceInset className="animate-in fade-in slide-in-from-bottom-2 duration-300">
              <FieldSet>
                <FieldGroup>
                  <Field orientation="responsive">
                    <FieldLabel htmlFor="developer-display-name">Display name</FieldLabel>
                    <FieldDescription>
                      This is the app identity shown to users when they review consent in Kai.
                    </FieldDescription>
                    <InputGroup>
                      <InputGroupInput
                        id="developer-display-name"
                        value={profileDraft.display_name}
                        onChange={(event) => onProfileDraftChange("display_name", event.target.value)}
                        placeholder="Your app name"
                      />
                    </InputGroup>
                  </Field>
                  <Field orientation="responsive">
                    <FieldLabel htmlFor="developer-website-url">Website</FieldLabel>
                    <FieldDescription>Optional public site developers and users can inspect.</FieldDescription>
                    <InputGroup>
                      <InputGroupInput
                        id="developer-website-url"
                        value={profileDraft.website_url}
                        onChange={(event) => onProfileDraftChange("website_url", event.target.value)}
                        placeholder="https://example.com"
                      />
                    </InputGroup>
                  </Field>
                  <Field orientation="responsive">
                    <FieldLabel htmlFor="developer-brand-image-url">Brand image URL</FieldLabel>
                    <FieldDescription>
                      Optional logo or avatar shown in consent review surfaces and push notifications.
                    </FieldDescription>
                    <InputGroup>
                      <InputGroupInput
                        id="developer-brand-image-url"
                        value={profileDraft.brand_image_url}
                        onChange={(event) =>
                          onProfileDraftChange("brand_image_url", event.target.value)
                        }
                        placeholder="https://example.com/logo.png"
                      />
                    </InputGroup>
                  </Field>
                  <Field orientation="responsive">
                    <FieldLabel htmlFor="developer-support-url">Support URL</FieldLabel>
                    <FieldDescription>Shown in trust conversations and support follow-ups.</FieldDescription>
                    <InputGroup>
                      <InputGroupInput
                        id="developer-support-url"
                        value={profileDraft.support_url}
                        onChange={(event) => onProfileDraftChange("support_url", event.target.value)}
                        placeholder="https://example.com/support"
                      />
                    </InputGroup>
                  </Field>
                  <Field orientation="responsive">
                    <FieldLabel htmlFor="developer-policy-url">Policy URL</FieldLabel>
                    <FieldDescription>
                      Privacy or data policy users can review before granting access.
                    </FieldDescription>
                    <InputGroup>
                      <InputGroupInput
                        id="developer-policy-url"
                        value={profileDraft.policy_url}
                        onChange={(event) => onProfileDraftChange("policy_url", event.target.value)}
                        placeholder="https://example.com/privacy"
                      />
                    </InputGroup>
                  </Field>
                </FieldGroup>
                <MorphyButton onClick={onSaveProfile} disabled={profileSaving} fullWidth>
                  {profileSaving ? "Saving..." : "Save profile"}
                </MorphyButton>
              </FieldSet>
            </SurfaceInset>
          ) : null}

          {workspaceTab === "contract" ? (
            <div className="space-y-4 animate-in fade-in slide-in-from-bottom-2 duration-300">
              <SurfaceInset className="space-y-3">
                <p className="text-sm font-semibold text-foreground">Public beta tools</p>
                <div className="flex flex-wrap gap-2">
                  {PUBLIC_TOOL_NAMES.map((toolName) => (
                    <Badge key={toolName} variant="outline">
                      {toolName}
                    </Badge>
                  ))}
                </div>
              </SurfaceInset>
              <SurfaceInset className="space-y-3">
                <p className="text-sm font-semibold text-foreground">Dynamic scope grammar</p>
                <div className="flex flex-wrap gap-2">
                  {PUBLIC_SCOPE_PATTERNS.map((scope) => (
                    <Badge key={scope} variant="outline">
                      {scope}
                    </Badge>
                  ))}
                </div>
              </SurfaceInset>
            </div>
          ) : null}
        </div>
      </SurfaceCardContent>
    </SurfaceCard>
  );
}

function DesktopContentsRail({
  onSelectSection,
}: {
  onSelectSection: (sectionId: string) => void;
}) {
  return (
    <aside className="hidden lg:sticky lg:top-0 lg:block lg:self-start">
      <SurfaceCard className="flex max-h-[calc(100dvh-3rem)] flex-col">
        <SurfaceCardHeader className="gap-1 pb-2.5">
          <SurfaceCardTitle>Sections</SurfaceCardTitle>
          <SurfaceCardDescription>Jump anywhere on the page.</SurfaceCardDescription>
        </SurfaceCardHeader>
        <SurfaceCardContent className="pt-0 pb-3">
          <ScrollArea className="max-h-[calc(100dvh-10rem)] pr-2">
            <ContentsNav
              onSelectSection={onSelectSection}
              framed={false}
              compact
              showSummaries={false}
            />
          </ScrollArea>
        </SurfaceCardContent>
      </SurfaceCard>
    </aside>
  );
}

function MobileSectionsFab({
  open,
  onOpenChange,
  onSelectSection,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSelectSection: (sectionId: string) => void;
}) {
  return (
    <Drawer open={open} onOpenChange={onOpenChange}>
      <div className="fixed right-4 z-[160] md:hidden" style={{ bottom: "calc(max(var(--app-safe-area-bottom-effective), 0.75rem) + 1rem)" }}>
        <MorphyButton
          variant="blue-gradient"
          effect="fill"
          size="sm"
          className="rounded-full px-4 shadow-[0_18px_60px_var(--morphy-cta-shadow)]"
          onClick={() => onOpenChange(true)}
        >
          <Menu className="size-4" />
          Sections
        </MorphyButton>
      </div>
      <DrawerContent className="max-h-[78vh] rounded-t-[28px] border-t border-border/80 bg-background/98 md:hidden">
        <DrawerHeader className="border-b border-border/80 bg-background/96 px-4 py-4 text-left backdrop-blur-xl">
          <DrawerTitle>Jump to a section</DrawerTitle>
          <DrawerDescription>
            Move through the developer contract without scrolling the whole page.
          </DrawerDescription>
        </DrawerHeader>
        <ScrollArea className="max-h-[56vh] px-4 py-4">
          <ContentsNav
            onSelectSection={(sectionId) => {
              onSelectSection(sectionId);
              onOpenChange(false);
            }}
            framed={false}
          />
        </ScrollArea>
      </DrawerContent>
    </Drawer>
  );
}

export function DeveloperDocsHub({ initialOrigin = null }: { initialOrigin?: string | null }) {
  const runtime = useMemo(() => resolveDeveloperRuntime(initialOrigin), [initialOrigin]);
  const integrationModes = useMemo(() => buildIntegrationModes(runtime), [runtime]);
  const restSnippets = useMemo(() => buildRestSnippets(runtime), [runtime]);
  const mcpSnippets = useMemo(() => buildMcpSnippets(runtime), [runtime]);
  const isMobile = useIsMobile();

  const { user, loading, signOut, setNativeUser, checkAuth } = useAuth();
  const [integrationTab, setIntegrationTab] = useState<"rest" | "remote-mcp" | "npm">(
    "remote-mcp"
  );
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [mobileOpenSections, setMobileOpenSections] = useState<string[]>(MOBILE_DEFAULT_OPEN_SECTIONS);
  const [liveDocs, setLiveDocs] = useState<LiveDocsResponse | null>(null);
  const [liveDocsLoading, setLiveDocsLoading] = useState(true);
  const [access, setAccess] = useState<DeveloperPortalAccess | null>(null);
  const [accessLoading, setAccessLoading] = useState(false);
  const [accessError, setAccessError] = useState<string | null>(null);
  const [profileDraft, setProfileDraft] = useState<ProfileDraft>(EMPTY_PROFILE_DRAFT);
  const [profileSaving, setProfileSaving] = useState(false);
  const [revealedToken, setRevealedToken] = useState<string | null>(null);
  const initialHashHandledRef = useRef(false);
  const lastAccessRefreshUidRef = useRef<string | null | undefined>(undefined);
  const workspaceSnippets = useMemo(
    () => buildWorkspaceSnippets(runtime, revealedToken || "<developer-token>"),
    [revealedToken, runtime]
  );
  const developerTokenSnippet = `${workspaceSnippets.envVar}\n${workspaceSnippets.remoteUrl}`;

  useEffect(() => {
    let cancelled = false;

    async function loadLiveDocs() {
      setLiveDocsLoading(true);
      try {
        const payload = await getLiveDeveloperDocs();
        if (cancelled) {
          return;
        }
        setLiveDocs(payload);
      } catch {
        if (cancelled) {
          return;
        }
      } finally {
        if (!cancelled) {
          setLiveDocsLoading(false);
        }
      }
    }

    loadLiveDocs();

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!access?.app) {
      setProfileDraft(EMPTY_PROFILE_DRAFT);
      return;
    }

    setProfileDraft({
      display_name: access.app.display_name || "",
      website_url: access.app.website_url || "",
      brand_image_url: access.app.brand_image_url || "",
      support_url: access.app.support_url || "",
      policy_url: access.app.policy_url || "",
    });
  }, [access?.app]);

  useEffect(() => {
    if (!isMobile) {
      setMobileNavOpen(false);
      return;
    }

    if (initialHashHandledRef.current) {
      return;
    }

    const hash = window.location.hash.replace(/^#/, "");
    if (!hash) {
      initialHashHandledRef.current = true;
      return;
    }

    initialHashHandledRef.current = true;
    setMobileOpenSections((current) => addOpenSection(current, hash));

    const timer = window.setTimeout(() => {
      scrollToSection(hash);
    }, 160);

    return () => window.clearTimeout(timer);
  }, [isMobile]);

  const refreshAccess = useCallback(async (currentUser = user) => {
    if (!currentUser) {
      setAccess(null);
      setAccessError(null);
      setRevealedToken(null);
      return;
    }

    setAccessLoading(true);
    try {
      const idToken = await currentUser.getIdToken();
      const payload = await getDeveloperAccess(idToken, { userId: currentUser.uid });
      setAccess(payload);
      setAccessError(null);
    } catch (error) {
      setAccess(null);
      setAccessError(formatDeveloperAccessError(error, runtime, "Failed to load developer access."));
    } finally {
      setAccessLoading(false);
    }
  }, [runtime, user]);

  useEffect(() => {
    if (loading) {
      return;
    }

    const nextUid = user?.uid ?? null;
    if (lastAccessRefreshUidRef.current === nextUid) {
      return;
    }

    lastAccessRefreshUidRef.current = nextUid;
    void refreshAccess(user);
  }, [loading, refreshAccess, user]);

  async function handleProviderSignIn(provider: "google" | "apple") {
    try {
      const authResult =
        provider === "google"
          ? await AuthService.signInWithGoogle()
          : await AuthService.signInWithApple();
      setNativeUser(authResult.user);
      await checkAuth();
      await refreshAccess(authResult.user);
    } catch (error) {
      console.error(`[developers] ${provider} sign-in failed`, error);
    }
  }

  async function handleEnableAccess() {
    if (!user) {
      toast.error("Sign in before enabling developer access");
      return;
    }

    setAccessLoading(true);
    try {
      const idToken = await user.getIdToken();
      const payload = await enableDeveloperAccess(idToken, { userId: user.uid });
      setAccess(payload);
      setRevealedToken(payload.raw_token || null);
      setAccessError(null);
      toast.success("Developer access enabled");
    } catch (error) {
      const message = formatDeveloperAccessError(
        error,
        runtime,
        "Could not enable developer access."
      );
      setAccessError(message);
      toast.error(message);
    } finally {
      setAccessLoading(false);
    }
  }

  async function handleRotateKey() {
    if (!user) {
      toast.error("Sign in before rotating a token");
      return;
    }

    try {
      const idToken = await user.getIdToken();
      const payload = await rotateDeveloperAccessToken(idToken, { userId: user.uid });
      setAccess(payload);
      setRevealedToken(payload.raw_token || null);
      setAccessError(null);
      toast.success("Developer token rotated");
    } catch (error) {
      const message = formatDeveloperAccessError(error, runtime, "Could not rotate the token.");
      setAccessError(message);
      toast.error(message);
    }
  }

  async function handleSaveProfile() {
    if (!user) {
      toast.error("Sign in before updating your app profile");
      return;
    }

    setProfileSaving(true);
    try {
      const idToken = await user.getIdToken();
      const payload = await updateDeveloperAccessProfile(idToken, profileDraft, {
        userId: user.uid,
      });
      setAccess(payload);
      setAccessError(null);
      toast.success("Developer app profile updated");
    } catch (error) {
      const message = formatDeveloperAccessError(
        error,
        runtime,
        "Could not save the developer app profile."
      );
      setAccessError(message);
      toast.error(message);
    } finally {
      setProfileSaving(false);
    }
  }

  async function handleSignOut() {
    try {
      await signOut({ redirectTo: ROUTES.DEVELOPERS });
      setAccess(null);
      setRevealedToken(null);
    } catch (error) {
      console.error("[developers] sign out failed", error);
      toast.error("Could not sign out");
    }
  }

  function updateProfileDraft(field: keyof ProfileDraft, value: string) {
    setProfileDraft((current) => ({
      ...current,
      [field]: value,
    }));
  }

  function handleMobileSectionChange(sectionId: string, open: boolean) {
    setMobileOpenSections((current) =>
      open ? addOpenSection(current, sectionId) : removeOpenSection(current, sectionId)
    );
  }

  function handleSectionSelect(sectionId: string) {
    setMobileOpenSections((current) => addOpenSection(current, sectionId));
    setMobileNavOpen(false);
    window.setTimeout(() => {
      scrollToSection(sectionId);
    }, isMobile ? 180 : 0);
  }

  return (
    <TooltipProvider>
      <AppPageShell
        width="standard"
        className="pb-[calc(6rem+var(--app-safe-area-bottom-effective))] md:pb-12 lg:pb-6"
        nativeTest={{
          routeId: "/developers",
          marker: "native-route-developers",
          authState: user ? "authenticated" : "public",
          dataState: "loaded",
        }}
      >
        <AppPageContentRegion className="grid gap-6 lg:grid-cols-[248px_minmax(0,1fr)] xl:grid-cols-[272px_minmax(0,1fr)] 2xl:grid-cols-[288px_minmax(0,1fr)] 2xl:gap-8">
          <DesktopContentsRail onSelectSection={handleSectionSelect} />

          <div className="min-w-0 space-y-6 md:space-y-8 lg:pr-2">
            <section id="start" className="scroll-mt-24 space-y-6 md:space-y-8">
              <AppPageHeaderRegion>
                <PageHeader
                  eyebrow="Developer Hub"
                  title="Build consent-aware Kai integrations with dynamic scopes"
                  description="Use MCP or the API to discover user-specific scopes from the Personal Knowledge Model, request consent inside Kai, and read only the approved slice through one scalable contract."
                  icon={Code2}
                  accent="developers"
                  actions={
                    <>
                      <Badge variant="outline">{runtime.environmentLabel}</Badge>
                      <Badge variant="outline">{PUBLIC_TOOL_NAMES.length} public tools</Badge>
                    </>
                  }
                />
              </AppPageHeaderRegion>

              <SurfaceCard tone="feature" className="min-w-0">
                <SurfaceCardHeader>
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge className="bg-primary text-primary-foreground">{runtime.environmentLabel}</Badge>
                    <Badge variant="outline">Self-serve access</Badge>
                    <Badge variant="outline">Dynamic scopes</Badge>
                  </div>
                  <SurfaceCardTitle className="pt-1 text-base sm:text-lg">
                    One developer contract across remote MCP, the API, and the npm bridge
                  </SurfaceCardTitle>
                  <SurfaceCardDescription className="max-w-3xl text-sm leading-6">
                    Public docs stay open. Sign in only if you want a personal developer workspace,
                    self-serve developer token, and consent prompts branded to your app identity.
                  </SurfaceCardDescription>
                </SurfaceCardHeader>
                <SurfaceCardContent className="space-y-5">
                  <div className="grid gap-3 md:grid-cols-2">
                    <RuntimeValueRow
                      label="REST"
                      value={runtime.apiBaseUrl}
                      copyLabel="REST base URL"
                      isMobile={isMobile}
                    />
                    <RuntimeValueRow
                      label="MCP"
                      value={runtime.mcpUrl}
                      copyLabel="Remote MCP URL"
                      isMobile={isMobile}
                    />
                    <RuntimeValueRow
                      label="Token"
                      value={workspaceSnippets.envVar}
                      copyLabel="Developer env var"
                      isMobile={isMobile}
                    />
                    <RuntimeValueRow
                      label="npm"
                      value={runtime.npmPackage}
                      copyLabel="npm package"
                      isMobile={isMobile}
                    />
                  </div>
                  <Separator />
                  {isMobile ? (
                    <div className="space-y-4">
                      <SettingsSegmentedTabs
                        value={integrationTab}
                        onValueChange={(value) => setIntegrationTab(value as "rest" | "remote-mcp" | "npm")}
                        mobileColumns={1}
                        options={integrationModes.map((mode) => ({
                          value: mode.id,
                          label: mode.title,
                        }))}
                      />
                      <div className="animate-in fade-in slide-in-from-bottom-2 duration-500">
                        {integrationTab === "rest" ? (
                          <SnippetCard
                            title="REST base"
                            description="Use the versioned developer API when you want direct control over discovery, consent requests, and polling."
                            code={restSnippets.base}
                            copyLabel="REST base snippet"
                          />
                        ) : null}
                        {integrationTab === "remote-mcp" ? (
                          <SnippetCard
                            title="Remote MCP config"
                            description="Use this when your host can connect to HTTP MCP directly."
                            code={mcpSnippets.remote}
                            copyLabel="Remote MCP config"
                          />
                        ) : null}
                        {integrationTab === "npm" ? (
                          <SnippetCard
                            title="npm bridge config"
                            description="Use the npm launcher when your host still expects a local stdio process."
                            code={mcpSnippets.npm}
                            copyLabel="npm MCP config"
                          />
                        ) : null}
                      </div>
                    </div>
                  ) : (
                    <div className="grid min-w-0 gap-5 xl:grid-cols-2 2xl:gap-6">
                      <SnippetCard
                        title="Remote MCP config"
                        description="Direct HTTP MCP for hosts that support remote connectors."
                        code={mcpSnippets.remote}
                        copyLabel="Remote MCP config"
                      />
                      <SnippetCard
                        title="REST base"
                        description="Use the versioned developer API when you want direct control over discovery, consent requests, and polling."
                        code={restSnippets.base}
                        copyLabel="REST base snippet"
                      />
                      <SnippetCard
                        title="npm bridge config"
                        description="Use the npm launcher when the host still expects a local stdio MCP process."
                        code={mcpSnippets.npm}
                        copyLabel="npm MCP config"
                      />
                      <SnippetCard
                        title="Developer token"
                        description="Keep the current environment token values close at hand while wiring your host."
                        code={developerTokenSnippet}
                        copyLabel="Developer token snippet"
                      />
                    </div>
                  )}
                </SurfaceCardContent>
              </SurfaceCard>
            </section>

            <DeveloperSectionShell
              sectionId="overview"
              isMobile={isMobile}
              mobileOpenSections={mobileOpenSections}
              onMobileSectionChange={handleMobileSectionChange}
              header={
                <SectionHeader
                  eyebrow="Overview"
                  title="The trust model stays simple"
                  description="Authentication identifies your developer app. User consent in Kai is the separate programmable boundary that grants access to a discovered scope."
                  icon={ShieldCheck}
                  accent="emerald"
                />
              }
            >
              <div className="grid gap-4 md:grid-cols-2">
                <SurfaceCard className="min-w-0">
                  <SurfaceCardHeader>
                    <SurfaceCardTitle>What the user sees</SurfaceCardTitle>
                  </SurfaceCardHeader>
                  <SurfaceCardContent className="space-y-3 text-sm leading-6 text-muted-foreground">
                    <p>
                      Consent prompts show your app display name, support link, and policy link so
                      the user understands who is asking and why.
                    </p>
                    <p>
                      Access is always per scope. Signing in, enabling developer access, or running
                      your agent does not bypass consent.
                    </p>
                  </SurfaceCardContent>
                </SurfaceCard>
                <SurfaceCard className="min-w-0">
                  <SurfaceCardHeader>
                    <SurfaceCardTitle>What the developer gets</SurfaceCardTitle>
                  </SurfaceCardHeader>
                  <SurfaceCardContent className="space-y-3 text-sm leading-6 text-muted-foreground">
                    <p>
                      One self-serve app per Kai account, one active token, and the same contract
                      surfaced through remote MCP, the API, and the npm bridge.
                    </p>
                    <p>
                      The data path is the same everywhere: discover scopes, request consent, poll
                      status, then read approved scoped data.
                    </p>
                  </SurfaceCardContent>
                </SurfaceCard>
              </div>
            </DeveloperSectionShell>

            <DeveloperSectionShell
              sectionId="modes"
              isMobile={isMobile}
              mobileOpenSections={mobileOpenSections}
              onMobileSectionChange={handleMobileSectionChange}
              header={
                <SectionHeader
                  eyebrow="Choose Mode"
                  title="Pick the integration path that matches your host"
                  description="The contract stays the same. Only the transport changes."
                  icon={Cable}
                  accent="sky"
                />
              }
            >
              <SettingsGroup
                eyebrow="Integration modes"
                title="Choose the transport, keep the same contract"
                description="Each mode points at the same dynamic scope and consent flow. The active snippet above updates as you switch."
              >
                {integrationModes.map((mode) => (
                  <SettingsRow
                    key={mode.id}
                    title={mode.title}
                    description={mode.summary}
                    trailing={integrationTab === mode.id ? <Badge variant="default">Active</Badge> : undefined}
                    stackTrailingOnMobile
                    onClick={() => setIntegrationTab(mode.id)}
                  />
                ))}
              </SettingsGroup>
            </DeveloperSectionShell>

            <DeveloperSectionShell
              sectionId="dynamic-scopes"
              isMobile={isMobile}
              mobileOpenSections={mobileOpenSections}
              onMobileSectionChange={handleMobileSectionChange}
              header={
                <SectionHeader
                  eyebrow="Dynamic Scopes"
                  title="Scopes are discovered from the user’s indexed PKM"
                  description="The public grammar is fixed, but the user-specific scope strings are generated from the indexed Personal Knowledge Model and the domain registry."
                  icon={ScanSearch}
                  accent="violet"
                  actions={
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <MorphyButton variant="none" effect="glass" size="sm">
                          Why dynamic?
                        </MorphyButton>
                      </TooltipTrigger>
                      <TooltipContent className="max-w-xs text-sm leading-6">
                        Dynamic scopes let the backend publish only the domains and paths the user
                        actually has, rather than pretending every user has the same data graph.
                      </TooltipContent>
                    </Tooltip>
                  }
                />
              }
            >
              <SurfaceCard className="min-w-0">
                <SurfaceCardContent className="space-y-5 pt-6">
                  <SurfaceInset className="space-y-3">
                    <p className="text-sm font-semibold text-foreground">Current status</p>
                    <div className="space-y-2">
                      {DEVELOPER_SCOPE_NOTES.map((note) => (
                        <p key={note} className="text-sm leading-6 text-muted-foreground">
                          {note}
                        </p>
                      ))}
                    </div>
                  </SurfaceInset>
                  <div className="flex flex-wrap gap-2">
                    {PUBLIC_SCOPE_PATTERNS.map((scopePattern) => (
                      <Badge key={scopePattern} variant="outline">
                        {scopePattern}
                      </Badge>
                    ))}
                  </div>
                  {liveDocsLoading ? (
                    <div className="grid gap-3 lg:grid-cols-2">
                      <Skeleton className="h-28 rounded-3xl" />
                      <Skeleton className="h-28 rounded-3xl" />
                    </div>
                  ) : liveDocs?.scopes?.length ? (
                    <div className="grid gap-3 lg:grid-cols-2">
                      {liveDocs.scopes.map((scope) => (
                        <SurfaceInset key={scope.name} className="min-w-0 space-y-2">
                          <p className="text-sm font-semibold text-foreground">{scope.name}</p>
                          <p className="text-sm leading-6 text-muted-foreground">{scope.description}</p>
                        </SurfaceInset>
                      ))}
                    </div>
                  ) : null}
                  <div className="grid min-w-0 gap-4 xl:grid-cols-2">
                    {DEVELOPER_SAMPLE_PAYLOADS.map((sample) => (
                      <SnippetCard
                        key={sample.title}
                        title={sample.title}
                        description={sample.description}
                        code={sample.code}
                        copyLabel={sample.title}
                      />
                    ))}
                  </div>
                </SurfaceCardContent>
              </SurfaceCard>
            </DeveloperSectionShell>

            <DeveloperSectionShell
              sectionId="consent-flow"
              isMobile={isMobile}
              mobileOpenSections={mobileOpenSections}
              onMobileSectionChange={handleMobileSectionChange}
              header={
                <SectionHeader
                  eyebrow="Consent Flow"
                  title="The user journey stays explicit"
                  description="External agents can ask, but only Kai can approve. That separation is what keeps the contract trustworthy."
                  icon={Workflow}
                  accent="amber"
                />
              }
            >
              <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
                {CONSENT_FLOW_STEPS.map((step, index) => (
                  <SurfaceCard key={step.title} className="min-w-0">
                    <SurfaceCardContent className="space-y-3 pt-6">
                      <Badge variant="outline">Step {index + 1}</Badge>
                      <h3 className="text-base font-semibold text-foreground">{step.title}</h3>
                      <p className="text-sm leading-6 text-muted-foreground">{step.detail}</p>
                    </SurfaceCardContent>
                  </SurfaceCard>
                ))}
              </div>
            </DeveloperSectionShell>

            <DeveloperSectionShell
              sectionId="mcp"
              isMobile={isMobile}
              mobileOpenSections={mobileOpenSections}
              onMobileSectionChange={handleMobileSectionChange}
              header={
                <SectionHeader
                  eyebrow="MCP"
                  title="Remote MCP when possible, npm bridge when needed"
                  description="Hosts that support HTTP MCP can connect directly. Everyone else can still use the npm launcher with the same developer token."
                  icon={Cable}
                  accent="rose"
                />
              }
            >
              <div className="grid min-w-0 gap-4 xl:grid-cols-[minmax(0,1.05fr)_minmax(0,0.95fr)]">
                <div className="min-w-0 space-y-4">
                  {mcpSnippets.primaryExamples.map((example) => (
                    <SnippetCard
                      key={example.id}
                      title={example.title}
                      description={example.whenToUse}
                      note={example.secretNote}
                      code={example.code}
                      copyLabel={example.copyLabel}
                    />
                  ))}
                </div>
                <SurfaceCard className="min-w-0">
                  <SurfaceCardHeader>
                    <SurfaceCardTitle>Public MCP tools</SurfaceCardTitle>
                    <SurfaceCardDescription>
                      Public onboarding is UAT-first. The npm package, token env var, and slash-safe
                      MCP URL below are the same contract shown on npm.
                    </SurfaceCardDescription>
                  </SurfaceCardHeader>
                  <SurfaceCardContent className="space-y-4">
                    <div className="flex flex-wrap gap-2">
                      <MorphyButton asChild variant="none" effect="glass" size="sm">
                        <Link href={MCP_PUBLIC_LINKS.npmPackageUrl} target="_blank" rel="noreferrer">
                          npm package
                        </Link>
                      </MorphyButton>
                      <MorphyButton asChild variant="none" effect="glass" size="sm">
                        <Link
                          href={MCP_PUBLIC_LINKS.apiReferenceUrl}
                          target="_blank"
                          rel="noreferrer"
                        >
                          API reference
                        </Link>
                      </MorphyButton>
                      <MorphyButton asChild variant="none" effect="glass" size="sm">
                        <Link
                          href={MCP_PUBLIC_LINKS.technicalCompanionUrl}
                          target="_blank"
                          rel="noreferrer"
                        >
                          Technical companion
                        </Link>
                      </MorphyButton>
                    </div>
                    <SurfaceInset className="space-y-3">
                      <div className="space-y-1">
                        <p className="text-sm font-semibold text-foreground">
                          Promoted environment: {PUBLIC_MCP_ENVIRONMENT.label}
                        </p>
                        <p className="text-sm leading-6 text-muted-foreground">
                          Use the exact trailing-slash endpoint shape and keep the developer token
                          machine-local.
                        </p>
                      </div>
                      <div className="rounded-2xl border border-border/70 bg-slate-950/95 px-4 py-4 font-mono text-xs leading-6 text-slate-100">
                        {PUBLIC_MCP_ENVIRONMENT.remoteUrlTemplate}
                      </div>
                    </SurfaceInset>
                    <div className="flex flex-wrap gap-2">
                      {PUBLIC_TOOL_NAMES.map((toolName) => (
                        <Badge key={toolName} variant="outline">
                          {toolName}
                        </Badge>
                      ))}
                    </div>
                    <div className="flex flex-wrap gap-2">
                      {PUBLIC_RESOURCE_URIS.map((resourceUri) => (
                        <Badge key={resourceUri} variant="secondary">
                          {resourceUri}
                        </Badge>
                      ))}
                    </div>
                    {liveDocs?.tools?.length ? (
                      <ScrollArea className="h-64 rounded-2xl border border-border/65 sm:h-72">
                        <div className="space-y-3 p-4">
                          {liveDocs.tools.map((tool) => (
                            <SurfaceInset key={tool.name} className="min-w-0 space-y-2">
                              <p className="text-sm font-semibold text-foreground">{tool.name}</p>
                              <p className="text-sm leading-6 text-muted-foreground">{tool.description}</p>
                            </SurfaceInset>
                          ))}
                        </div>
                      </ScrollArea>
                    ) : null}
                  </SurfaceCardContent>
                </SurfaceCard>
              </div>
              <div className="grid min-w-0 gap-4 lg:grid-cols-2 xl:grid-cols-3">
                {mcpSnippets.hostExamples.map((example) => (
                  <SnippetCard
                    key={example.id}
                    title={example.title}
                    description={example.whenToUse}
                    note={example.secretNote}
                    code={example.code}
                    copyLabel={example.copyLabel}
                  />
                ))}
              </div>
            </DeveloperSectionShell>

            <DeveloperSectionShell
              sectionId="api"
              isMobile={isMobile}
              mobileOpenSections={mobileOpenSections}
              onMobileSectionChange={handleMobileSectionChange}
              header={
                <SectionHeader
                  eyebrow="REST API"
                  title="Versioned endpoints for discovery and consent"
                  description="The public API is intentionally small. Everything else builds on top of these primitives."
                  icon={Globe}
                  accent="sky"
                />
              }
            >
              <div className="grid min-w-0 gap-4 xl:grid-cols-[minmax(0,1.05fr)_minmax(0,0.95fr)]">
                <SurfaceCard className="min-w-0">
                  <SurfaceCardContent className="space-y-3 pt-6">
                    <SettingsGroup
                      eyebrow="Endpoint map"
                      title="Small on purpose"
                      description="Everything public builds on these primitives for discovery, consent, status, and scoped reads."
                    >
                      {REST_ENDPOINTS.map((endpoint) => (
                        <SettingsRow
                          key={endpoint.path}
                          leading={<Badge variant="outline">{endpoint.method}</Badge>}
                          title={<code className="text-xs sm:text-[13px]">{endpoint.path}</code>}
                          description={
                            <div className="space-y-1">
                              <p>{endpoint.purpose}</p>
                              <p className="text-[11px] uppercase tracking-[0.18em] text-muted-foreground/80">
                                {endpoint.auth}
                              </p>
                            </div>
                          }
                        />
                      ))}
                    </SettingsGroup>
                  </SurfaceCardContent>
                </SurfaceCard>
                <div className="min-w-0 space-y-4">
                  <SnippetCard
                    title="Discover user scopes"
                    description="Always start by inspecting the actual scope strings available for the target user."
                    code={restSnippets.discover}
                    copyLabel="Discover scopes curl"
                  />
                  <SnippetCard
                    title="Request consent"
                    description="Send a single scope request and let Kai handle approval."
                    code={restSnippets.requestConsent}
                    copyLabel="Request consent curl"
                  />
                  <SnippetCard
                    title="Poll consent status"
                    description="Check whether the user has approved, denied, or revoked the request."
                    code={restSnippets.checkStatus}
                    copyLabel="Consent status curl"
                  />
                </div>
              </div>
            </DeveloperSectionShell>

            <DeveloperSectionShell
              sectionId="access"
              isMobile={isMobile}
              mobileOpenSections={mobileOpenSections}
              onMobileSectionChange={handleMobileSectionChange}
              header={
                <SectionHeader
                  eyebrow="Developer Access"
                  title="Turn the docs into a working integration workspace"
                  description="The page is fully readable without login. Sign in only when you want self-serve tokens and app identity controls."
                  icon={KeyRound}
                  accent="emerald"
                />
              }
            >
              {!user ? (
                <SignedOutAccessCard
                  authLoading={loading}
                  onGoogle={() => handleProviderSignIn("google")}
                  onApple={() => handleProviderSignIn("apple")}
                />
              ) : (
                <AccessWorkspace
                  access={access}
                  accessLoading={accessLoading}
                  accessError={accessError}
                  authLoading={loading}
                  runtime={runtime}
                  signedInEmail={user.email}
                  signedInDisplayName={user.displayName}
                  profileDraft={profileDraft}
                  profileSaving={profileSaving}
                  revealedToken={revealedToken}
                  isMobile={isMobile}
                  onEnable={handleEnableAccess}
                  onProfileDraftChange={updateProfileDraft}
                  onRotateKey={handleRotateKey}
                  onSaveProfile={handleSaveProfile}
                  onSignOut={handleSignOut}
                />
              )}

              <SurfaceCard className="min-w-0">
                <SurfaceCardHeader>
                  <SurfaceCardTitle>Copy-ready setup values</SurfaceCardTitle>
                  <SurfaceCardDescription>
                    These values track the environment this page is running in.
                  </SurfaceCardDescription>
                </SurfaceCardHeader>
                <SurfaceCardContent className="space-y-3">
                  <RuntimeValueRow
                    label="MCP URL"
                    value={workspaceSnippets.remoteUrl}
                    copyLabel="Remote MCP URL"
                    isMobile={isMobile}
                  />
                  <RuntimeValueRow
                    label="Env"
                    value={workspaceSnippets.envVar}
                    copyLabel="Developer env var"
                    isMobile={isMobile}
                  />
                  <RuntimeValueRow
                    label="REST"
                    value={workspaceSnippets.restQuery}
                    copyLabel="REST token query"
                    isMobile={isMobile}
                  />
                </SurfaceCardContent>
              </SurfaceCard>
            </DeveloperSectionShell>

            <DeveloperSectionShell
              sectionId="faq"
              isMobile={isMobile}
              mobileOpenSections={mobileOpenSections}
              onMobileSectionChange={handleMobileSectionChange}
              header={
                <SectionHeader
                  eyebrow="Troubleshooting"
                  title="Common questions from external developers"
                  description="These answers stay aligned with the runtime contract and the trust model users see in Kai."
                  icon={LifeBuoy}
                  accent="default"
                />
              }
            >
              <SurfaceCard className="min-w-0">
                <SurfaceCardContent className="pt-6">
                  <Accordion type="single" collapsible className="w-full">
                    {FAQ_ITEMS.map((item) => (
                      <AccordionItem key={item.question} value={item.question}>
                        <AccordionTrigger>{item.question}</AccordionTrigger>
                        <AccordionContent className="text-sm leading-6 text-muted-foreground">
                          {item.answer}
                        </AccordionContent>
                      </AccordionItem>
                    ))}
                  </Accordion>
                </SurfaceCardContent>
              </SurfaceCard>
              <SurfaceInset className="space-y-3">
                <p className="text-sm font-semibold text-foreground">Quick checks</p>
                <p className="text-sm leading-6 text-muted-foreground">
                  If remote MCP fails, confirm the developer token is active, the environment URL
                  matches the page you are using, and the user has a populated indexed PKM.
                </p>
                <p className="text-sm leading-6 text-muted-foreground">
                  If a scope request fails, discover the user’s scopes again instead of retrying a
                  hardcoded domain string.
                </p>
              </SurfaceInset>
            </DeveloperSectionShell>
          </div>
        </AppPageContentRegion>
      </AppPageShell>

      {isMobile ? (
        <MobileSectionsFab
          open={mobileNavOpen}
          onOpenChange={setMobileNavOpen}
          onSelectSection={handleSectionSelect}
        />
      ) : null}
    </TooltipProvider>
  );
}
