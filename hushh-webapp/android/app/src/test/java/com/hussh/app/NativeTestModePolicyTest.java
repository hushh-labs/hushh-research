package com.hussh.app;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;
import com.hussh.app.plugins.HushhSettings.HushhAppHapticFeedbackState;
import com.hussh.app.plugins.HushhSettings.HushhAppHapticPreference;

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

    @Test
    public void feedbackRequiresCurrentDocumentPrivacyAndPreference() {
        HushhAppHapticFeedbackState state = new HushhAppHapticFeedbackState();
        assertFalse(state.consume("choice", "selection", 1000.0, 1001.0, false, 3, 3, true, false, true));
        assertFalse(state.consume("choice", "selection", 1000.0, 1001.0, true, 2, 3, true, false, true));
        assertFalse(state.consume("choice", "selection", 1000.0, 1001.0, true, null, 3, true, false, true));
        assertFalse(state.consume("choice", "selection", 1000.0, 1001.0, true, 3, 3, false, false, true));
        assertFalse(state.consume("choice", "selection", 1000.0, 1001.0, true, 3, 3, true, true, true));
        assertFalse(state.consume("choice", "selection", 1000.0, 1001.0, true, 3, 3, true, false, false));
        // Positive control: refusals do not consume an otherwise valid intent.
        assertTrue(state.consume("choice", "selection", 1000.0, 1001.0, true, 3, 3, true, false, true));
        assertTrue(state.consume("light-choice", "light", 1000.0, 1001.0, true, 3, 3, true, false, true));
    }

    @Test
    public void feedbackDropsMalformedExpiredAndDuplicateRequests() {
        HushhAppHapticFeedbackState state = new HushhAppHapticFeedbackState();
        assertFalse(state.consume("choice", "heavy", 1000.0, 1001.0, true, 0, 0, true, false, true));
        assertFalse(state.consume("choice", "selection", null, 1001.0, true, 0, 0, true, false, true));
        assertFalse(state.consume("choice", "selection", Double.NaN, 1001.0, true, 0, 0, true, false, true));
        assertFalse(state.consume("choice", "selection", 1000.0, Double.POSITIVE_INFINITY, true, 0, 0, true, false, true));
        assertFalse(state.consume("choice", "selection", 1000.0, 1251.0, true, 0, 0, true, false, true));
        assertFalse(state.consume("choice", "selection", 1100.0, 1000.0, true, 0, 0, true, false, true));
        assertFalse(state.consume("", "selection", 1000.0, 1001.0, true, 0, 0, true, false, true));
        assertFalse(state.consume("x".repeat(129), "selection", 1000.0, 1001.0, true, 0, 0, true, false, true));
        assertFalse(state.consume("choice", "selection", 1000.0, 1001.0, true, -1, -1, true, false, true));
        assertTrue(state.consume("choice", "selection", 1000.0, 1250.0, true, 0, 0, true, false, true));
        assertFalse(state.consume("choice", "selection", 1000.0, 1001.0, true, 0, 0, true, false, true));
    }

    @Test
    public void feedbackKeepsOnlyTheMostRecent256IntentIds() {
        HushhAppHapticFeedbackState state = new HushhAppHapticFeedbackState();
        for (int index = 0; index < 256; index++) {
            assertTrue(state.consume("choice-" + index, "selection", 1000.0, 1001.0, true, 0, 0, true, false, true));
        }
        assertFalse(state.consume("choice-0", "selection", 1000.0, 1001.0, true, 0, 0, true, false, true));
        assertTrue(state.consume("choice-256", "selection", 1000.0, 1001.0, true, 0, 0, true, false, true));
        assertFalse(state.consume("choice-1", "selection", 1000.0, 1001.0, true, 0, 0, true, false, true));
        assertTrue(state.consume("choice-0", "selection", 1000.0, 1001.0, true, 0, 0, true, false, true));
    }

    @Test
    public void hapticMigrationLetsExplicitFalseWinOnlyOnce() {
        assertFalse(HushhAppHapticPreference.enabled(false, true, false));
        assertFalse(HushhAppHapticPreference.enabled(false, false, true));
        assertFalse(HushhAppHapticPreference.enabled(false, null, false));
        assertTrue(HushhAppHapticPreference.enabled(false, null, null));
        assertTrue(HushhAppHapticPreference.enabled(true, true, false));
        assertFalse(HushhAppHapticPreference.enabled(true, false, true));
    }
}
