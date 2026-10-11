package com.hussh.app.plugins.HushhNotifications

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class ChatDeliveryPolicyTest {
    @Test fun delayedAlertCannotReplaceNewerUnreadMessage() {
        assertFalse(ChatDeliveryPolicy.shouldAlert(10.0, 0.0, 11.0, "m10", setOf("m11")))
        assertTrue(ChatDeliveryPolicy.shouldAlert(12.0, 10.0, 11.0, "m12", setOf("m11")))
    }
    @Test fun readBeforeDeliveryCannotResurrectNotification() {
        assertFalse(ChatDeliveryPolicy.shouldAlert(11.0, 11.0, 0.0, "m11", setOf("")))
    }
    @Test fun duplicateDeliveryDoesNotRingAgain() {
        assertFalse(ChatDeliveryPolicy.shouldAlert(11.0, 0.0, 11.0, "m11", setOf("m11")))
    }
    @Test fun equalTimestampReplayCannotRingAfterAnotherMessage() {
        assertFalse(ChatDeliveryPolicy.shouldAlert(11.0, 0.0, 11.0, "A", setOf("A", "B")))
    }
    @Test fun distinctDirectMessagesAtSameTimestampRemainDeliverable() {
        assertTrue(ChatDeliveryPolicy.shouldAlert(1700000000.0, 0.0, 1700000000.0, "new", setOf("old")))
    }
}
