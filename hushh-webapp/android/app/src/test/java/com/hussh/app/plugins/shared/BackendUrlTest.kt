package com.hussh.app.plugins.shared

import org.junit.Assert.assertEquals
import org.junit.Test

class BackendUrlTest {
    @Test
    fun physicalReverseTransportDoesNotChangeEmulatorOrHostedRouting() {
        for (host in listOf("localhost", "127.0.0.1")) {
            val local = "http://$host:8000"
            assertEquals(local, BackendUrl.normalize(local, "adb_reverse"))
            assertEquals("http://10.0.2.2:8000", BackendUrl.normalize(local))
            assertEquals("http://10.0.2.2:8000", BackendUrl.normalize(local, "unknown"))
        }
        val hosted = "https://api.example.test"
        assertEquals(hosted, BackendUrl.normalize(hosted, "adb_reverse"))
        assertEquals(hosted, BackendUrl.normalize(hosted))
    }
}
