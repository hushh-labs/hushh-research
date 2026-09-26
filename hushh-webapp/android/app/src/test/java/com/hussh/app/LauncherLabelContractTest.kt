package com.hussh.app

import java.io.File
import javax.xml.parsers.DocumentBuilderFactory
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.w3c.dom.Element

/**
 * The installed app name under the launcher icon matches iOS
 * (CFBundleDisplayName "Agent One"). The Play Store listing title is set in
 * Play Console and is intentionally different.
 */
class LauncherLabelContractTest {
    private fun elements(file: String, tag: String): List<Element> {
        val doc = DocumentBuilderFactory.newInstance().apply { isNamespaceAware = true }
            .newDocumentBuilder().parse(File(file))
        val nodes = doc.getElementsByTagName(tag)
        return (0 until nodes.length).map { nodes.item(it) as Element }
    }

    private val strings: Map<String, String> by lazy {
        elements("src/main/res/values/strings.xml", "string")
            .associate { it.getAttribute("name") to it.textContent }
    }

    private fun resolve(label: String): String {
        assertTrue("label must be a string resource: $label", label.startsWith("@string/"))
        return strings.getValue(label.removePrefix("@string/"))
    }

    @Test fun releaseLauncherLabelIsAgentOne() {
        val ns = "http://schemas.android.com/apk/res/android"
        val manifest = "src/main/AndroidManifest.xml"
        val application = elements(manifest, "application").single()
        assertEquals("Agent One", resolve(application.getAttributeNS(ns, "label")))

        // The launcher shows the launcher activity's own label when it has one.
        val launcher = elements(manifest, "activity").single { activity ->
            activity.getElementsByTagName("category").let { categories ->
                (0 until categories.length).any {
                    (categories.item(it) as Element).getAttributeNS(ns, "name") ==
                        "android.intent.category.LAUNCHER"
                }
            }
        }
        assertEquals("Agent One", resolve(launcher.getAttributeNS(ns, "label")))
    }

    @Test fun noVariantOrLocaleOverridesTheLauncherLabel() {
        val overrides = File("src").walk()
            .filter { it.isFile && it.name.endsWith(".xml") && it.path.contains("/res/values") }
            .filter { it.path != "src/main/res/values/strings.xml" }
            .filter { file ->
                val text = file.readText()
                text.contains("name=\"app_name\"") || text.contains("name=\"title_activity_main\"")
            }
            .toList()
        assertEquals(emptyList<File>(), overrides)
        val gradle = File("build.gradle").readText()
        assertTrue(!gradle.contains("\"app_name\"") && !gradle.contains("\"title_activity_main\""))
    }
}
