type NativeRouteMarkerProps = {
  routeId: string;
  marker: string;
  authState?: string;
  dataState?: string;
};

export function NativeRouteMarker({
  routeId,
  marker,
  authState = "",
  dataState = "",
}: NativeRouteMarkerProps) {
  return (
    <div
      style={{ display: "none" }}
      aria-hidden="true"
      data-testid={marker}
      data-native-route-marker="true"
      data-native-route-id={routeId}
      data-native-auth-default={authState}
      data-native-data-default={dataState}
    />
  );
}
