import { NativeTestBeacon } from "@/components/app-ui/native-test-beacon";
import { NativeRouteMarker } from "@/components/app-ui/native-route-marker";
import KaiPermissionGateSection from "../../src/components/privacy/permission-gate/KaiPermissionGateSection";

export default function KaiPage() {
  return (
    <>
      <NativeRouteMarker
        routeId="/kai"
        marker="native-route-kai-home"
        authState="authenticated"
        dataState="loaded"
      />

      <NativeTestBeacon
        routeId="/kai"
        marker="native-route-kai-home"
        authState="authenticated"
        dataState="loaded"
      />

      <KaiPermissionGateSection />
    </>
  );
}