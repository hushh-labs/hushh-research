// SPDX-License-Identifier: Apache-2.0
/** Pure selected-environment check, shared by native config materialization. */
export function validateNativeFirebaseIdentity({ projectId, senderId, nativeAppId }, { expectedProject, expectedSender }) {
  if (!expectedProject) return;
  if (projectId !== expectedProject) throw new Error("Native/web Firebase project mismatch.");
  if (expectedSender && senderId !== expectedSender) throw new Error("Native/web Firebase sender mismatch.");
  if (expectedSender && !String(nativeAppId || "").startsWith(`1:${expectedSender}:`)) {
    throw new Error("Native Firebase app does not belong to the selected sender.");
  }
}
