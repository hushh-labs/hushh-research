package com.hussh.app

import java.util.concurrent.atomic.AtomicReference

/** One native microphone owner across calls and One Voice. */
internal object AndroidMicrophoneOwnership {
    private val active = AtomicReference<Any?>()
    fun claim(owner: Any): Boolean = active.compareAndSet(null, owner) || active.get() === owner
    fun release(owner: Any) { active.compareAndSet(owner, null) }
}
