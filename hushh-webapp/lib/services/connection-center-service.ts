import {
  ConsentCenterService,
  type ConsentCenterActor,
  type ConsentCenterEntry,
  type ConsentCenterPageListResponse,
  type ConsentCenterPageSummary,
} from "@/lib/services/consent-center-service";
import {
  RiaService,
  type RiaClientDetail,
} from "@/lib/services/ria-service";

export type ConnectionSurface = "pending" | "active" | "previous";

export class ConnectionCenterService {
  static async getSummary(options: {
    idToken: string;
    userId: string;
    actor: ConsentCenterActor;
    force?: boolean;
  }): Promise<ConsentCenterPageSummary> {
    return ConsentCenterService.getSummary({
      idToken: options.idToken,
      userId: options.userId,
      actor: options.actor,
      mode: "connections",
      force: options.force,
    });
  }

  static async listConnections(options: {
    idToken: string;
    userId: string;
    actor: ConsentCenterActor;
    surface: ConnectionSurface;
    q?: string;
    page?: number;
    limit?: number;
    force?: boolean;
  }): Promise<ConsentCenterPageListResponse> {
    return ConsentCenterService.listEntries({
      idToken: options.idToken,
      userId: options.userId,
      actor: options.actor,
      mode: "connections",
      surface: options.surface,
      q: options.q,
      page: options.page,
      limit: options.limit,
      force: options.force,
    });
  }

  static async getRiaConnectionDetail(options: {
    idToken: string;
    userId: string;
    investorUserId: string;
    force?: boolean;
  }): Promise<RiaClientDetail> {
    return RiaService.getClientDetail(options.idToken, options.investorUserId, {
      userId: options.userId,
      force: options.force,
    });
  }

  static async getRiaConnectionWorkspace(options: {
    idToken: string;
    userId: string;
    investorUserId: string;
    force?: boolean;
  }) {
    return RiaService.getWorkspace(options.idToken, options.investorUserId, {
      userId: options.userId,
      force: options.force,
    });
  }

  static async requestRiaPortfolioAccess(options: {
    idToken: string;
    subjectUserId: string;
    scopeTemplateId: string;
    selectedScopes: string[];
    reason?: string;
  }) {
    return RiaService.createRequestBundle(options.idToken, {
      subject_user_id: options.subjectUserId,
      scope_template_id: options.scopeTemplateId,
      selected_scopes: options.selectedScopes,
      reason: options.reason,
    });
  }

  static async disconnect(options: {
    idToken: string;
    investorUserId?: string;
    riaProfileId?: string;
  }) {
    return ConsentCenterService.disconnectRelationship({
      idToken: options.idToken,
      investor_user_id: options.investorUserId,
      ria_profile_id: options.riaProfileId,
    });
  }
}

export function isPortfolioExplorerReady(entry: ConsentCenterEntry | null | undefined) {
  const metadata = entry?.metadata;
  if (!metadata || typeof metadata !== "object") return false;
  const value = (metadata as Record<string, unknown>).portfolio_explorer_ready;
  return value === true;
}
