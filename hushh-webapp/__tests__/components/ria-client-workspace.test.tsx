import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ComponentProps } from "react";

import { RiaClientWorkspace } from "@/components/ria/ria-client-workspace";
import { RiaClientAccountDetail } from "@/components/ria/ria-client-account-detail";
import { RiaClientRequestDetail } from "@/components/ria/ria-client-request-detail";
import type { RiaPageShell } from "@/components/ria/ria-page-shell";

import {
  buildKaiTestClientDetail,
  buildKaiTestClientWorkspace,
  RIA_KAI_SPECIALIZED_TEMPLATE_ID,
} from "@/components/ria/ria-client-test-profile";

const read = vi.hoisted(() => ({
  detail: null as ReturnType<typeof buildKaiTestClientDetail> | null,
  workspace: null as ReturnType<typeof buildKaiTestClientWorkspace> | null,
  loading: false,
  detailError: null as string | null,
  iamUnavailable: false,
}));

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock("@/lib/voice/voice-surface-metadata", () => ({
  usePublishVoiceSurfaceMetadata: () => undefined,
}));
vi.mock("@/components/ria/use-ria-client-workspace-state", () => ({
  useRiaClientWorkspaceState: () => ({
    ...read, user: { uid: "synthetic-advisor" }, riaCapability: "ready",
    personaLoading: false, isTestProfile: true, refreshWorkspace: vi.fn(),
  }),
}));
vi.mock("@/components/ria/ria-page-shell", () => ({
  RiaPageShell: ({ nativeTest }: ComponentProps<typeof RiaPageShell>) => (
    <div data-testid="route-readiness" data-state={nativeTest?.dataState}
      data-error-code={nativeTest?.errorCode} data-error-message={nativeTest?.errorMessage} />
  ),
  RiaCompatibilityState: () => null,
  RiaSurface: () => null,
  MetricTile: () => null,
}));

describe("RIA native route readiness", () => {
  beforeEach(() => {
    read.detail = buildKaiTestClientDetail("synthetic-client");
    read.workspace = buildKaiTestClientWorkspace("synthetic-client");
    read.loading = false;
    read.detailError = null;
    read.iamUnavailable = false;
  });

  it.each(["workspace", "account", "request"] as const)(
    "does not accept retained %s information as a successful failed read or expose error bodies",
    (family) => {
      const page = () => family === "workspace"
        ? <RiaClientWorkspace clientId="synthetic-client" />
        : family === "account"
          ? <RiaClientAccountDetail clientId="synthetic-client" accountId={read.detail!.account_branches[0]!.branch_id} />
          : <RiaClientRequestDetail clientId="synthetic-client" requestId={read.detail!.request_history[0]!.request_id} />;
      const view = render(page());
      expect(screen.getByTestId("route-readiness")).toHaveAttribute("data-state", "loaded");
      read.detailError = "synthetic provider response must stay out of diagnostics";
      view.rerender(page());
      expect(screen.getByTestId("route-readiness")).toHaveAttribute("data-state", "error");
      expect(screen.getByTestId("route-readiness")).not.toHaveAttribute("data-error-message");
    },
  );
});

describe("RIA client test profile builders", () => {
  it("produces a stable Kai-specialized advisor workspace payload", () => {
    const clientId = "s3xmA4lNSAQFrIaOytnSGAOzXlL2";
    const detail = buildKaiTestClientDetail(clientId);
    const workspace = buildKaiTestClientWorkspace(clientId);

    expect(detail.investor_user_id).toBe(clientId);
    expect(detail.investor_display_name).toBe("Kai Test User");
    expect(detail.kai_specialized_bundle?.template_id).toBe(RIA_KAI_SPECIALIZED_TEMPLATE_ID);
    expect(detail.requestable_scope_templates[0]?.template_id).toBe(RIA_KAI_SPECIALIZED_TEMPLATE_ID);
    expect(detail.request_history[0]?.bundle_id).toBe("ria_kai_specialized");
    expect(detail.account_branches).toHaveLength(2);
    expect(detail.available_scope_metadata.map((scope) => scope.scope)).toEqual(
      expect.arrayContaining([
        "attr.financial.portfolio.*",
        "attr.financial.profile.*",
        "attr.financial.analysis_history.*",
        "attr.financial.runtime.*",
      ])
    );

    expect(workspace.investor_user_id).toBe(clientId);
    expect(workspace.workspace_ready).toBe(true);
    expect(workspace.kai_specialized_bundle?.status).toBe("active");
    expect(workspace.account_branches.map((branch) => branch.branch_id)).toEqual(
      detail.account_branches.map((branch) => branch.branch_id)
    );
    expect(workspace.domain_summaries.financial).toMatchObject({
      holdings_count: 8,
      risk_profile: "Moderate",
      account_count: 2,
    });
  });
    it("preserves client id propagation across detail and workspace payloads", () => {
    const clientId = "client-empty-state";

    const detail = buildKaiTestClientDetail(clientId);
    const workspace = buildKaiTestClientWorkspace(clientId);

    expect(detail.investor_user_id).toBe(clientId);
    expect(workspace.investor_user_id).toBe(clientId);
    expect(workspace.account_branches).toHaveLength(detail.account_branches.length);
  });
});
