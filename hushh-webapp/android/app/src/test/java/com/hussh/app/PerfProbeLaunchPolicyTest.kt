package com.hussh.app

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class PerfProbeLaunchPolicyTest {
    @Test
    fun probeSeedsOnlyInDebuggableBuildsWithAnExplicitRequest() {
        assertEquals(
            PerfProbeLaunchPolicy.Action.SEED,
            PerfProbeLaunchPolicy.decide(isDebugBuild = true, probeRequested = true, route = null).action
        )
        assertEquals(
            PerfProbeLaunchPolicy.Action.CLEAR,
            PerfProbeLaunchPolicy.decide(isDebugBuild = true, probeRequested = false, route = "/one").action
        )
    }

    @Test
    fun aNonDebuggableBuildNeverTouchesThePreferences() {
        val decision = PerfProbeLaunchPolicy.decide(isDebugBuild = false, probeRequested = true, route = "/one/kai")
        assertEquals(PerfProbeLaunchPolicy.Action.LEAVE, decision.action)
        assertNull(decision.route)
        assertEquals(
            PerfProbeLaunchPolicy.Action.LEAVE,
            PerfProbeLaunchPolicy.decide(isDebugBuild = false, probeRequested = false, route = null).action
        )
    }

    @Test
    fun aClearedLaunchCarriesNoRoute() {
        val decision = PerfProbeLaunchPolicy.decide(isDebugBuild = true, probeRequested = false, route = "/one/kai")
        assertEquals(PerfProbeLaunchPolicy.Action.CLEAR, decision.action)
        assertNull(decision.route)
        assertTrue(PerfProbeLaunchPolicy.decide(isDebugBuild = true, probeRequested = true, route = "/one/kai").route == "/one/kai")
    }

    @Test
    fun routeAcceptsOnlyAppRelativePaths() {
        assertEquals("/one/kai", PerfProbeLaunchPolicy.sanitizeRoute("/one/kai"))
        assertEquals("/one/feed?tab=all", PerfProbeLaunchPolicy.sanitizeRoute(" /one/feed?tab=all "))
        assertNull(PerfProbeLaunchPolicy.sanitizeRoute("https://example.com/one"))
        assertNull(PerfProbeLaunchPolicy.sanitizeRoute("//evil.example"))
        assertNull(PerfProbeLaunchPolicy.sanitizeRoute("one/kai"))
        assertNull(PerfProbeLaunchPolicy.sanitizeRoute("/one/<script>"))
        assertNull(PerfProbeLaunchPolicy.sanitizeRoute(null))
    }

    @Test
    fun preferenceNamesMatchTheWebProbeContract() {
        // lib/perf/perf-probe-enablement.ts and @capacitor/preferences (group "CapacitorStorage").
        assertEquals("CapacitorStorage", PerfProbeLaunchPolicy.PREFERENCES_GROUP)
        assertEquals("hushh_perf_probe", PerfProbeLaunchPolicy.PROBE_PREFERENCE_KEY)
        assertEquals("hushh_perf_route", PerfProbeLaunchPolicy.ROUTE_PREFERENCE_KEY)
    }
}
