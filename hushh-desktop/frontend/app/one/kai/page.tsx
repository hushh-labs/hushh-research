import { NativeTestBeacon } from "@/components/app-ui/native-test-beacon";
import { NativeRouteMarker } from "@/components/app-ui/native-route-marker";
import { KaiPreviewRouter } from "@/components/kai/views/kai-preview-router";

export default function KaiPage() {
  return (
    <>
      <NativeRouteMarker
        routeId="/one/kai"
        marker="native-route-kai-home"
        authState="authenticated"
        dataState="loaded"
      />

      <NativeTestBeacon
        routeId="/one/kai"
        marker="native-route-kai-home"
        authState="authenticated"
        dataState="loaded"
      />

      <KaiPreviewRouter />
    </>
  );
}
