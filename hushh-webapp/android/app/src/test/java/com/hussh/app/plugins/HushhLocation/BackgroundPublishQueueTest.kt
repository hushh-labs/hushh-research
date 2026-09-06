package com.hussh.app.plugins.HushhLocation

import org.junit.Assert.*
import org.junit.Test

class BackgroundPublishQueueTest {
    @Test fun expiryIsRecheckedBeforeRetry() {
        var time = 10L
        val queue = BackgroundPublishQueue { time }
        queue.offer(BackgroundPublishQueue.Item("grant", 11, "ciphertext"))
        time = 11
        assertNull(queue.next())
    }
    @Test fun revocationRemovesQueuedAndFutureWrites() {
        val queue = BackgroundPublishQueue { 1 }
        val item = BackgroundPublishQueue.Item("grant", null, "ciphertext")
        queue.offer(item)
        queue.refuse("grant")
        queue.offer(item)
        assertNull(queue.next())
        assertFalse(queue.active(item))
    }
    @Test fun newSessionCannotReplayPreviousOwnerQueue() {
        val queue = BackgroundPublishQueue { 1 }
        val oldGeneration = queue.generation
        queue.offer(BackgroundPublishQueue.Item("old-owner", null, "ciphertext"))
        queue.reset()
        assertNotEquals(oldGeneration, queue.generation)
        assertNull(queue.next())
    }
    @Test fun offlineQueueRetainsOnlyNewestFiftyCiphertexts() {
        val queue = BackgroundPublishQueue { 1 }
        repeat(100) { queue.offer(BackgroundPublishQueue.Item("grant", null, "$it")) }
        assertEquals(50, queue.size)
        assertEquals("50", queue.next()?.body)
    }
}
