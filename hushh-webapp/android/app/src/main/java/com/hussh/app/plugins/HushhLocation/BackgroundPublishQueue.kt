package com.hussh.app.plugins.HushhLocation

/** Ciphertext-only bounded queue. Caller serializes access with the publisher lock. */
internal class BackgroundPublishQueue(private val now: () -> Long = System::currentTimeMillis) {
    data class Item(val grantId: String, val expiresAtMs: Long?, val body: String)
    private val pending = ArrayDeque<Item>()
    private val refused = mutableSetOf<String>()
    var generation = 0L
        private set
    val size get() = pending.size

    fun reset() { generation++; pending.clear(); refused.clear() }
    fun active(item: Item) = item.grantId !in refused && (item.expiresAtMs == null || item.expiresAtMs > now())
    fun offer(item: Item) {
        if (!active(item)) return
        if (pending.size == 50) pending.removeFirst()
        pending.addLast(item)
    }
    fun next(): Item? {
        while (pending.isNotEmpty()) {
            val item = pending.removeFirst()
            if (active(item)) return item
        }
        return null
    }
    fun refuse(grantId: String) { refused.add(grantId); pending.removeAll { it.grantId == grantId } }
}
