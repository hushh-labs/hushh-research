package com.hussh.app;

import android.app.Instrumentation;
import android.content.Intent;
import android.os.Bundle;
import android.os.SystemClock;
import android.view.accessibility.AccessibilityNodeInfo;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import org.junit.Test;
import org.junit.runner.RunWith;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertTrue;
import static org.junit.Assume.assumeTrue;

/** Uses the existing onboarding session; never resets auth or sends an SMS. */
@RunWith(AndroidJUnit4.class)
public final class CountryPickerInstrumentedTest {
    private final Instrumentation instrumentation = InstrumentationRegistry.getInstrumentation();

    private AccessibilityNodeInfo find(AccessibilityNodeInfo node, String label, boolean prefix) {
        if (node == null) return null;
        String text = String.valueOf(node.getText());
        String description = String.valueOf(node.getContentDescription());
        if (prefix ? text.startsWith(label) || description.startsWith(label) : text.equals(label) || description.equals(label)) return node;
        for (int i = 0; i < node.getChildCount(); i++) {
            AccessibilityNodeInfo result = find(node.getChild(i), label, prefix);
            if (result != null) return result;
        }
        return null;
    }

    private AccessibilityNodeInfo waitFor(String label, boolean prefix) {
        long deadline = SystemClock.uptimeMillis() + 10000;
        do {
            AccessibilityNodeInfo result = find(instrumentation.getUiAutomation().getRootInActiveWindow(), label, prefix);
            if (result != null) return result;
            SystemClock.sleep(100);
        } while (SystemClock.uptimeMillis() < deadline);
        return null;
    }

    private void tap(String label, boolean prefix) {
        AccessibilityNodeInfo node = waitFor(label, prefix);
        assertNotNull("Missing picker control: " + label, node);
        while (!node.isClickable() && node.getParent() != null) node = node.getParent();
        assertTrue(node.performAction(AccessibilityNodeInfo.ACTION_CLICK));
    }

    @Test public void selectsCountriesWithoutResettingTheSession() {
        Intent launch = instrumentation.getTargetContext().getPackageManager().getLaunchIntentForPackage("com.hussh.app");
        assertNotNull(launch);
        launch.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        instrumentation.getTargetContext().startActivity(launch);
        assumeTrue("Existing phone-entry session required", waitFor("Country code:", true) != null);
        String[][] countries = {{"United States", "+1"}, {"United Kingdom", "+44"}, {"India", "+91"}, {"Angola", "+244"}, {"Brazil", "+55"}};
        for (String[] country : countries) {
            tap("Country code:", true);
            AccessibilityNodeInfo search = waitFor("Search countries", false);
            assertNotNull(search);
            Bundle arguments = new Bundle();
            arguments.putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, country[0]);
            assertTrue(search.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, arguments));
            tap(country[0] + " (" + country[1] + ")", false);
            assertNotNull(waitFor("Country code: " + country[0] + " (" + country[1] + ")", false));
        }
        tap("Country code:", true);
        tap("Cancel", false);
        assertNotNull(waitFor("Country code: Brazil (+55)", false));
    }
}
