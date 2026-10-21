const noop = () => undefined;
const presence = () => ({
  presence: {
    status: "active", audience: "all_opted_in", radiusMeters: 500,
    allowConnectionRequests: false, consentVersion: "one-location-nearby-presence-v3",
    checkedInAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    placeLabel: "A long test venue name, Building Nine, Riverside Business Centre",
    placeLat: 37.4275, placeLng: -122.1697,
  }, attendees: [],
});
export const OneLocationService = {
  getNearbyPresence: async () => presence(),
  getPermissionState: async () => ({ state: "granted", precise: true, locationServicesEnabled: true }),
  nearbyPlaces: async () => [],
  listPlaceRatingSummaries: async () => [],
  extendNearbyPresence: async () => { document.body.dataset.extended = "true"; return presence(); },
  checkoutNearby: async () => ({ presence: null, attendees: [], checkedOut: true }),
};
export const useRouter = () => ({ push: noop });
export const useLocalOnboardingActionHandler = noop;
export const usePathname = () => "/one/location";
export const recordVisitNote = noop;
export const trackOneLocationJourneyAction = noop;
export const trackReviewHandoffOpened = noop;
export const trackVisitRated = noop;
export const readLastKnownFix = async () => null;
export const rememberLastKnownFix = noop;
export const rememberLocationGrant = noop;
export const loadSavedLocations = async () => [];
export const addSavedLocation = noop;
export const findDuplicateSavedLocation = () => null;
export class DuplicateSavedLocationError extends Error {}
