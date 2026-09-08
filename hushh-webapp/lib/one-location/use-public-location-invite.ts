"use client";

import { useEffect, useState } from "react";

import { OneLocationService } from "@/lib/one-location/service";
import type {
  OneLocationPublicInvite,
  PlainLocationPoint,
} from "@/lib/one-location/types";
import { ApiError } from "@/lib/services/api-client";

const POLL_INTERVAL_MS = 15_000;

type PublicInviteState = {
  token: string;
  invite: OneLocationPublicInvite | null;
  publicLocation: PlainLocationPoint | null;
  loading: boolean;
  error: string | null;
  confirmedExpired: boolean;
};

function initialState(token: string): PublicInviteState {
  return {
    token,
    invite: null,
    publicLocation: null,
    loading: true,
    error: null,
    confirmedExpired: false,
  };
}

/** One request at a time; only the server decides when bearer access ends. */
export function usePublicLocationInvite(
  publicToken: string,
): PublicInviteState {
  const [state, setState] = useState(() => initialState(publicToken));

  useEffect(() => {
    let cancelled = false;
    let terminal = false;
    let inFlight = false;
    let hasResolved = false;
    let expiryCheck: ReturnType<typeof setTimeout> | undefined;
    setState(initialState(publicToken));

    const refresh = async () => {
      if (cancelled || terminal || inFlight) return;
      if (hasResolved && document.visibilityState === "hidden") return;
      inFlight = true;
      try {
        const response =
          await OneLocationService.resolvePublicInvite(publicToken);
        if (cancelled) return;
        hasResolved = true;
        terminal = response.invite.status !== "active";
        setState({
          token: publicToken,
          invite: response.invite,
          publicLocation: terminal ? null : (response.publicLocation ?? null),
          loading: false,
          error: null,
          confirmedExpired: terminal,
        });
        clearTimeout(expiryCheck);
        // Ask again at the displayed deadline, but never expire a successful
        // server response using a potentially fast browser clock.
        const remaining =
          Date.parse(response.invite.expiresAt ?? "") - Date.now();
        if (!terminal && remaining > 0 && remaining < POLL_INTERVAL_MS) {
          expiryCheck = setTimeout(() => void refresh(), remaining);
        }
      } catch (error) {
        if (cancelled) return;
        terminal =
          error instanceof ApiError &&
          (error.status === 404 || error.status === 410);
        setState((current) => ({
          ...current,
          loading: false,
          publicLocation: terminal ? null : current.publicLocation,
          confirmedExpired: terminal,
          error: hasResolved
            ? null
            : error instanceof Error
              ? error.message
              : "This live location link is unavailable.",
        }));
      } finally {
        inFlight = false;
      }
    };

    if (!publicToken) {
      setState({
        ...initialState(publicToken),
        loading: false,
        error: "This live location link is invalid.",
      });
      return;
    }
    void refresh();
    const interval = setInterval(() => void refresh(), POLL_INTERVAL_MS);
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") void refresh();
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      cancelled = true;
      clearInterval(interval);
      clearTimeout(expiryCheck);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [publicToken]);

  // Do not render the previous person's pin even for one frame during navigation.
  return state.token === publicToken ? state : initialState(publicToken);
}
