package com.hussh.app;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

public final class NativeTestModePolicyTest {
    @Test
    public void nativeTestBridgeRequiresTheDebugVariantAndExplicitRequest() {
        assertFalse(NativeTestModePolicy.isEnabled(false, true));
        assertFalse(NativeTestModePolicy.isEnabled(true, false));
        assertTrue(NativeTestModePolicy.isEnabled(true, true));
    }

    @Test
    public void uiFlowRunIdIsBoundedAndContainsOnlyStorageSafeMetadata() {
        assertEquals("androidrun_1", NativeTestModePolicy.uiFlowRunId("android:run_1!"));
        assertEquals("", NativeTestModePolicy.uiFlowRunId(null));
    }
}
