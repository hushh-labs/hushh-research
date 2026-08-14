import { resolveAppEnvironment } from "@/lib/app-env";
import type { PlainLocationPoint } from "@/lib/one-location/types";
import { isNativeUiTestSession } from "@/lib/testing/native-test";

export type LocationMapDemoPerson = {
  key: string;
  label: string;
  point: PlainLocationPoint;
  tint: { r: number; g: number; b: number; a: number };
};

const DEMO_TINTS = [
  { r: 0, g: 122, b: 255, a: 255 },
  { r: 52, g: 199, b: 89, a: 255 },
  { r: 255, g: 149, b: 0, a: 255 },
  { r: 175, g: 82, b: 222, a: 255 },
  { r: 255, g: 59, b: 48, a: 255 },
  { r: 90, g: 200, b: 250, a: 255 },
  { r: 255, g: 45, b: 85, a: 255 },
  { r: 88, g: 86, b: 214, a: 255 },
  { r: 48, g: 176, b: 199, a: 255 },
  { r: 162, g: 132, b: 94, a: 255 },
] as const;

// Fictional identities placed at public city-center coordinates. The fixture
// is deterministic so screenshots, clustering, and native parity tests do not
// drift between sessions.
const DEMO_COORDINATES = [
  ["maya-chen", "Maya Chen", 37.7749, -122.4194],
  ["jordan-lee", "Jordan Lee", 40.7128, -74.006],
  ["sam-rivera", "Sam Rivera", 19.4326, -99.1332],
  ["avery-patel", "Avery Patel", 43.6532, -79.3832],
  ["noah-williams", "Noah Williams", -23.5505, -46.6333],
  ["lina-costa", "Lina Costa", -34.6037, -58.3816],
  ["theo-martin", "Theo Martin", -12.0464, -77.0428],
  ["zoe-clarke", "Zoe Clarke", 51.5072, -0.1276],
  ["leo-dubois", "Leo Dubois", 48.8566, 2.3522],
  ["mila-schmidt", "Mila Schmidt", 52.52, 13.405],
  ["elias-rossi", "Elias Rossi", 41.9028, 12.4964],
  ["nora-garcia", "Nora Garcia", 40.4168, -3.7038],
  ["kai-jensen", "Kai Jensen", 55.6761, 12.5683],
  ["ella-lind", "Ella Lind", 59.3293, 18.0686],
  ["finn-koskinen", "Finn Koskinen", 60.1699, 24.9384],
  ["sara-novak", "Sara Novak", 50.0755, 14.4378],
  ["adam-kowalski", "Adam Kowalski", 52.2297, 21.0122],
  ["irem-kaya", "Irem Kaya", 41.0082, 28.9784],
  ["layla-haddad", "Layla Haddad", 25.2048, 55.2708],
  ["omar-nasser", "Omar Nasser", 30.0444, 31.2357],
  ["amina-bello", "Amina Bello", 6.5244, 3.3792],
  ["kwame-mensah", "Kwame Mensah", 5.6037, -0.187],
  ["zuri-kimani", "Zuri Kimani", -1.2921, 36.8219],
  ["themba-dlamini", "Themba Dlamini", -26.2041, 28.0473],
  ["hana-tesfaye", "Hana Tesfaye", 8.9806, 38.7578],
  ["aarav-shah", "Aarav Shah", 19.076, 72.8777],
  ["diya-mehta", "Diya Mehta", 28.6139, 77.209],
  ["anika-sen", "Anika Sen", 22.5726, 88.3639],
  ["reza-rahman", "Reza Rahman", 23.8103, 90.4125],
  ["saanvi-gurung", "Saanvi Gurung", 27.7172, 85.324],
  ["mei-lin", "Mei Lin", 31.2304, 121.4737],
  ["chen-wei", "Chen Wei", 39.9042, 116.4074],
  ["haru-sato", "Haru Sato", 35.6762, 139.6503],
  ["yuna-kim", "Yuna Kim", 37.5665, 126.978],
  ["minh-nguyen", "Minh Nguyen", 10.8231, 106.6297],
  ["mai-tran", "Mai Tran", 21.0278, 105.8342],
  ["narin-chai", "Narin Chai", 13.7563, 100.5018],
  ["putri-ayu", "Putri Ayu", -6.2088, 106.8456],
  ["amir-ismail", "Amir Ismail", 3.139, 101.6869],
  ["jia-tan", "Jia Tan", 1.3521, 103.8198],
  ["mia-wilson", "Mia Wilson", -33.8688, 151.2093],
  ["jack-thompson", "Jack Thompson", -37.8136, 144.9631],
  ["aroha-ngata", "Aroha Ngata", -36.8509, 174.7645],
  ["lani-fale", "Lani Fale", -18.1248, 178.4501],
  ["siti-koro", "Siti Koro", -9.4438, 147.1803],
  ["lucas-torres", "Lucas Torres", -33.4489, -70.6693],
  ["isla-rojas", "Isla Rojas", 4.711, -74.0721],
  ["mateo-silva", "Mateo Silva", -0.1807, -78.4678],
  ["sofia-pereira", "Sofia Pereira", 38.7223, -9.1393],
  ["ana-souza", "Ana Souza", -22.9068, -43.1729],
] as const;

export function locationMapDemoPeople(): LocationMapDemoPerson[] {
  const capturedAt = new Date().toISOString();
  return DEMO_COORDINATES.map(([key, label, latitude, longitude], index) => ({
    key: `demo-${key}`,
    label,
    tint: DEMO_TINTS[index % DEMO_TINTS.length]!,
    point: {
      latitude,
      longitude,
      capturedAt,
      sourcePlatform: "web",
    },
  }));
}

export function isLocationMapDemoEnabled(
  demoParameter: string | null | undefined,
): boolean {
  return demoParameter === "people" && isLocationMapDemoAvailable();
}

/**
 * Fictional people are an operator preview: local development, injected native
 * UI-test sessions, and any build that explicitly opts in.
 *
 * This is deliberately NOT gated on `resolveAppEnvironment() !== "production"`.
 * The public App Store and Play Store builds are stamped
 * `NEXT_PUBLIC_APP_ENV=uat` because they ship against the UAT backend
 * (`.github/workflows/release-ios-appstore.yml`, `ship-android-playstore-v1.yml`),
 * so an environment-shaped check reads every store install as non-production
 * and hands real users a map of fifty fictional people. In a product whose
 * entire promise is that the map shows only people who chose to share with
 * you, that is the worst possible bug.
 *
 * Distribution and backend environment are separate facts. Opt in explicitly,
 * and store lanes simply never set the flag.
 */
export function isLocationMapDemoAvailable(): boolean {
  if (isNativeUiTestSession()) return true;
  if (resolveAppEnvironment() === "development") return true;
  // The opt-in narrows who sees the fixture; this keeps the old hard floor
  // underneath it. A production build must never show fabricated people no
  // matter what a copied .env or an inherited build-args block sets, and
  // defence in depth here costs nothing.
  if (resolveAppEnvironment() === "production") return false;
  return (
    String(process.env.NEXT_PUBLIC_LOCATION_MAP_DEMO ?? "")
      .trim()
      .toLowerCase() === "true"
  );
}
