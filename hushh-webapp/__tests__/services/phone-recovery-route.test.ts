import { expect, it } from "vitest";
import { phoneRecoveryId, phoneRecoveryReviewRoute, phoneRecoveryRouteFromHref } from "@/lib/auth/phone-recovery-route";
const id = "27b517dc-d694-44e3-a9be-ed8ae0484de2";
it("retains only an opaque UUID when normalizing the existing review entry", () => {
  expect(phoneRecoveryRouteFromHref(`/register-phone?recovery=${id}&phone=private&action=delete#token=secret`))
    .toBe(phoneRecoveryReviewRoute(id));
});
it.each(["delete", "../one/profile", "123456", `${id}/extra`])("refuses a non-UUID continuation: %s", value => {
  expect(phoneRecoveryId(value)).toBeNull();
  expect(phoneRecoveryRouteFromHref(`/register-phone?recovery=${encodeURIComponent(value)}`)).toBeNull();
});
