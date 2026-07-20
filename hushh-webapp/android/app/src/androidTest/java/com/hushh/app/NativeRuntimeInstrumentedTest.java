package com.hushh.app;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;

import android.content.Context;
import android.content.pm.ApplicationInfo;

import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;

import org.junit.Test;
import org.junit.runner.RunWith;

/**
 * Minimal device-side guard for the native test surface. Cold audits can only
 * install the debug variant; production builds must not accept their extras.
 */
@RunWith(AndroidJUnit4.class)
public final class NativeRuntimeInstrumentedTest {
    @Test
    public void debugTestTargetUsesTheHushhApplicationIdentity() {
        Context appContext = InstrumentationRegistry.getInstrumentation().getTargetContext();

        assertEquals("com.hushh.app", appContext.getPackageName());
        assertTrue(
            "Instrumented native checks must execute a debuggable variant",
            (appContext.getApplicationInfo().flags & ApplicationInfo.FLAG_DEBUGGABLE) != 0
        );
    }
}
