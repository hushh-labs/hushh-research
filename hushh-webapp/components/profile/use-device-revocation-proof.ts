"use client";
import { useEffect, useMemo, useState } from "react";
import { useAuth } from "@/hooks/use-auth";
import { DeviceRevocationProofSession, type DeviceProofView } from "./device-revocation-proof";

export function useDeviceRevocationProof(device: string | null, current: () => boolean, continuationId?: string) {
  const { user, resolveVerifiedPhoneNumber } = useAuth();
  const [state, setState] = useState<{ session: DeviceRevocationProofSession; view: DeviceProofView } | null>(null);
  const [code, setCode] = useState("");
  const session = useMemo(() => user && device ? new DeviceRevocationProofSession(user, device, current,
    resolveVerifiedPhoneNumber, view => setState({ session: session!, view }), continuationId) : null,
    // A refreshed SDK User object is the same owner; the validated owner fence is current.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [user?.uid, device, current, continuationId]);
  useEffect(() => {
    setCode("");
    if (session) void session.prepare();
    return () => session?.dispose();
  }, [session]);
  return { view: state?.session === session ? state.view : session?.view ?? null, code, setCode,
    send: () => session?.send(), proof: () => session?.proof(code) ?? Promise.resolve(null),
    ownsOperation: (id: string) => session?.ownsOperation(id) === true,
    clear: () => session?.cancel() ?? Promise.resolve(null) };
}
