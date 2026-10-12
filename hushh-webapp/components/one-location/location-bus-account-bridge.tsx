"use client";

import { useEffect } from "react";
import { useAuth } from "@/hooks/use-auth";
import { LocationBus } from "@/lib/one-location/location-bus";

/**
 * Give the shared position store an account, once, for the whole app.
 *
 * The store can keep a fix across a reload, but only for somebody: a
 * coordinate has to belong to an account before it can be sealed to their key.
 * That attach used to happen in two places and effectively neither. The hook
 * only attached when a caller passed a `userId` and no caller did; key
 * bootstrap needs a vault token, so it landed after the Location page had
 * already taken — and failed — its first capture. The restored fix was
 * therefore missing at exactly the moment it existed to cover: the cold start.
 *
 * Here it runs for every signed-in route, before any surface asks. Idempotent,
 * so key bootstrap's call stays harmless; and attaching null on sign-out is
 * what clears one person's position before the next person's session.
 */
export function LocationBusAccountBridge() {
  const { userId } = useAuth();
  useEffect(() => {
    void LocationBus.attachUser(userId ?? null);
  }, [userId]);
  return null;
}
