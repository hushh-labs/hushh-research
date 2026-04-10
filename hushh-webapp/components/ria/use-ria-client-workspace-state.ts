"use client";

import { useEffect, useMemo, useState } from "react";

import { useAuth } from "@/hooks/use-auth";
import { usePersonaState } from "@/lib/persona/persona-context";
import { CacheService, CACHE_KEYS } from "@/lib/services/cache-service";
import {
  isIAMSchemaNotReadyError,
  RiaService,
  type RiaClientDetail,
  type RiaClientWorkspace,
} from "@/lib/services/ria-service";
import {
  buildKaiTestClientDetail,
  buildKaiTestClientWorkspace,
  isKaiTestProfileUser,
} from "@/components/ria/ria-client-test-profile";

export function useRiaClientWorkspaceState({
  clientId,
  forceTestProfile = false,
}: {
  clientId: string;
  forceTestProfile?: boolean;
}) {
  const { user } = useAuth();
  const { riaCapability, loading: personaLoading } = usePersonaState();
  const cache = useMemo(() => CacheService.getInstance(), []);
  const isTestProfile = forceTestProfile || isKaiTestProfileUser(clientId);
  const detailCacheKey =
    user?.uid && clientId ? CACHE_KEYS.RIA_CLIENT_DETAIL(user.uid, clientId) : null;
  const workspaceCacheKey =
    user?.uid && clientId ? CACHE_KEYS.RIA_WORKSPACE(user.uid, clientId) : null;
  const cachedDetail = useMemo(
    () => (detailCacheKey ? cache.peek<RiaClientDetail>(detailCacheKey) : null),
    [cache, detailCacheKey]
  );
  const cachedWorkspace = useMemo(
    () => (workspaceCacheKey ? cache.peek<RiaClientWorkspace>(workspaceCacheKey) : null),
    [cache, workspaceCacheKey]
  );

  const [detail, setDetail] = useState<RiaClientDetail | null>(cachedDetail?.data ?? null);
  const [workspace, setWorkspace] = useState<RiaClientWorkspace | null>(
    cachedWorkspace?.data ?? null
  );
  const [loading, setLoading] = useState(
    !cachedDetail?.data && !cachedWorkspace?.data && !isTestProfile
  );
  const [detailError, setDetailError] = useState<string | null>(null);
  const [iamUnavailable, setIamUnavailable] = useState(false);

  useEffect(() => {
    if (!clientId) return;
    setDetail(cachedDetail?.data ?? null);
    setWorkspace(cachedWorkspace?.data ?? null);
  }, [cachedDetail?.data, cachedWorkspace?.data, clientId]);

  useEffect(() => {
    if (!clientId) {
      setDetail(null);
      setWorkspace(null);
      setDetailError("Missing investor workspace identifier.");
      setLoading(false);
      return;
    }

    if (isTestProfile) {
      setDetail(buildKaiTestClientDetail(clientId));
      setWorkspace(buildKaiTestClientWorkspace(clientId));
      setDetailError(null);
      setIamUnavailable(false);
      setLoading(false);
      return;
    }

    if (!user) {
      setLoading(false);
      return;
    }

    const currentUser = user;
    let cancelled = false;

    async function load() {
      try {
        setLoading(!cachedDetail?.data && !cachedWorkspace?.data);
        setDetailError(null);
        setIamUnavailable(false);
        const idToken = await currentUser.getIdToken();
        const clientDetail = await RiaService.getClientDetail(idToken, clientId, {
          userId: currentUser.uid,
        });
        if (cancelled) return;
        setDetail(clientDetail);

        if (
          clientDetail.granted_scopes.length > 0 ||
          clientDetail.kai_specialized_bundle?.status !== "available"
        ) {
          try {
            const workspacePayload = await RiaService.getWorkspace(idToken, clientId, {
              userId: currentUser.uid,
            });
            if (!cancelled) {
              setWorkspace(workspacePayload);
            }
          } catch (workspaceError) {
            if (!cancelled) {
              setWorkspace(null);
              setDetailError(
                workspaceError instanceof Error
                  ? workspaceError.message
                  : "Failed to load workspace data"
              );
            }
          }
        } else if (!cancelled) {
          setWorkspace(null);
        }
      } catch (loadError) {
        if (!cancelled) {
          setDetail(null);
          setWorkspace(null);
          setIamUnavailable(isIAMSchemaNotReadyError(loadError));
          setDetailError(
            loadError instanceof Error ? loadError.message : "Failed to load client workspace"
          );
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    void load();
    return () => {
      cancelled = true;
    };
  }, [cachedDetail?.data, cachedWorkspace?.data, clientId, isTestProfile, user]);

  async function refreshWorkspace() {
    if (!user || !clientId || isTestProfile) return;
    try {
      setLoading(true);
      const idToken = await user.getIdToken();
      const [clientDetail, workspacePayload] = await Promise.all([
        RiaService.getClientDetail(idToken, clientId, { userId: user.uid, force: true }),
        RiaService.getWorkspace(idToken, clientId, {
          userId: user.uid,
          force: true,
        }).catch(() => null),
      ]);
      setDetail(clientDetail);
      setWorkspace(workspacePayload);
      setDetailError(null);
      setIamUnavailable(false);
    } catch (error) {
      setDetailError(error instanceof Error ? error.message : "Failed to refresh workspace");
    } finally {
      setLoading(false);
    }
  }

  return {
    user,
    riaCapability,
    personaLoading,
    isTestProfile,
    detail,
    workspace,
    loading,
    detailError,
    iamUnavailable,
    refreshWorkspace,
  };
}
