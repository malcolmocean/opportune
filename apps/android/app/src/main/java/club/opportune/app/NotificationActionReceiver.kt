package club.opportune.app

import android.app.NotificationManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.util.Log
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch

/** A tapped notification button: POST { nudgeResponse: { nudgeId, key } } and dismiss. */
class NotificationActionReceiver : BroadcastReceiver() {
    companion object {
        private const val TAG = "NudgeAction"
        const val ACTION_RESPOND = "club.opportune.app.RESPOND"
        const val EXTRA_NUDGE_ID = "nudgeId"
        const val EXTRA_KEY = "key"
        const val EXTRA_NOTIFICATION_ID = "notificationId"

        fun intent(context: Context, nudgeId: String, key: String, notificationId: Int, requestCode: Int): PendingIntent {
            val i = Intent(context, NotificationActionReceiver::class.java).apply {
                action = ACTION_RESPOND
                putExtra(EXTRA_NUDGE_ID, nudgeId); putExtra(EXTRA_KEY, key); putExtra(EXTRA_NOTIFICATION_ID, notificationId)
            }
            return PendingIntent.getBroadcast(context, requestCode, i, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
        }

        /** Used by the notification buttons. onDone runs after the POST attempt. */
        fun respond(context: Context, nudgeId: String, key: String, onDone: (() -> Unit)? = null) {
            Prefs.markResponded(context, nudgeId, key)
            context.getSystemService(NotificationManager::class.java).cancel(nudgeId, FCMService.notificationId(nudgeId))
            context.sendBroadcast(Intent(FCMService.ACTION_NUDGES_CHANGED).setPackage(context.packageName))
            scope.launch {
                try {
                    val ok = ApiClient.respond(context, nudgeId, key)
                    Log.d(TAG, "respond $nudgeId=$key → $ok")
                } finally { onDone?.invoke() }
            }
        }

        private val scope = CoroutineScope(Dispatchers.IO + SupervisorJob())
    }

    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != ACTION_RESPOND) return
        val nudgeId = intent.getStringExtra(EXTRA_NUDGE_ID) ?: return
        val key = intent.getStringExtra(EXTRA_KEY) ?: return
        // goAsync keeps the process alive (~10 s) until the POST has been attempted.
        val pending = goAsync()
        respond(context, nudgeId, key) { pending.finish() }
    }
}
