package com.malcolmocean.opportune

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

/** Bring the location service back after a reboot or app update, if the app is set up. */
class BootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action == Intent.ACTION_BOOT_COMPLETED || intent.action == Intent.ACTION_MY_PACKAGE_REPLACED) {
            LocationService.start(context)
        }
    }
}
