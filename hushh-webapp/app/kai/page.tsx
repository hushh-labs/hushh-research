import { NativeTestBeacon } from "@/components/app-ui/native-test-beacon";
import { KaiMarketPreviewView } from "@/components/kai/views/kai-market-preview-view";

export default function KaiPage() {
  return (
    <>
      <NativeTestBeacon
        routeId="/kai"
        marker="native-route-kai-home"
        authState="authenticated"
        dataState="loaded"
      />
      <KaiMarketPreviewView />
    </>
  );
}
