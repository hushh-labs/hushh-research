package com.hushh.app

import android.os.Bundle
import android.util.Log
import com.getcapacitor.BridgeActivity
import com.hushh.app.plugins.HushhAuth.HushhAuthPlugin
import com.hushh.app.plugins.HushhConsent.HushhConsentPlugin
import com.hushh.app.plugins.HushhVault.HushhVaultPlugin
import com.hushh.app.plugins.HushhKeystore.HushhKeystorePlugin
import com.hushh.app.plugins.HushhSettings.HushhSettingsPlugin
import com.hushh.app.plugins.HushhSync.HushhSyncPlugin
import com.hushh.app.plugins.HushhAccount.HushhAccountPlugin
import com.hushh.app.plugins.HushhNotifications.HushhNotificationsPlugin
import com.hushh.app.plugins.Kai.KaiPlugin
import com.hushh.app.plugins.PersonalKnowledgeModel.PersonalKnowledgeModelPlugin

class MainActivity : BridgeActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        Log.d("MainActivity", "🔌 [MainActivity] Registering all native plugins...")
        
        // Register all Hushh native plugins
        registerPlugin(HushhAuthPlugin::class.java)
        registerPlugin(HushhVaultPlugin::class.java)
        registerPlugin(HushhConsentPlugin::class.java)
        registerPlugin(HushhSyncPlugin::class.java)
        registerPlugin(HushhSettingsPlugin::class.java)
        registerPlugin(HushhKeystorePlugin::class.java)
        registerPlugin(HushhNotificationsPlugin::class.java)
        registerPlugin(KaiPlugin::class.java) // Agent Kai plugin
        registerPlugin(PersonalKnowledgeModelPlugin::class.java) // PKM plugin
        registerPlugin(HushhAccountPlugin::class.java) // Account management (deletion)
        
        Log.d("MainActivity", "✅ [MainActivity] All 10 plugins registered successfully")
        
        super.onCreate(savedInstanceState)
    }
}
