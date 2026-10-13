package club.opportune.app

import android.app.AlarmManager
import android.app.PendingIntent
import android.appwidget.AppWidgetManager
import android.appwidget.AppWidgetProvider
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.Bundle
import android.text.format.DateFormat
import android.util.SizeF
import android.widget.RemoteViews
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import org.json.JSONObject
import java.time.Instant
import java.util.Date

/**
 * The home-screen porchlight: a lantern and a line. Tap it dark (off or ask) → on for ON_HOURS; tap it lit → off.
 * Signed out, a tap just opens the app. The launcher's long-press "Widget settings" opens PorchlightMenuActivity
 * for the other choices. It draws from the porchlight cached in Prefs so a redraw never waits on the network, and
 * asks the node (/api/app/state) on the system's 30-min tick, when the app is backgrounded (the web app may have
 * changed it), after a change, and at the porchlight's `until`, when it changes by itself.
 *
 * Sizes: 1×1 is the lantern alone, 1×2 and 2×2 put the words under it, 2×1 and wider put them beside it.
 */
class PorchlightWidget : AppWidgetProvider() {
    companion object {
        private const val ACTION_TOGGLE = "club.opportune.app.PORCHLIGHT_TOGGLE"
        private const val ACTION_REFRESH = "club.opportune.app.PORCHLIGHT_REFRESH"
        const val ON_HOURS = 2
        // dp; at least this wide → words beside the lantern, at least this tall → words under it
        private const val WIDE_DP = 130
        private const val TALL_DP = 130

        private val scope = CoroutineScope(Dispatchers.IO + SupervisorJob())

        private fun ids(c: Context): IntArray =
            AppWidgetManager.getInstance(c).getAppWidgetIds(ComponentName(c, PorchlightWidget::class.java))

        /** Redraw from the cache, then ask the node. No-op when no widget is placed. */
        fun refresh(context: Context) {
            val c = context.applicationContext
            if (ids(c).isEmpty()) return
            redraw(c)
            scope.launch { fetch(c) }
        }

        /** Redraw every placed widget from what's cached (or the signed-out face). */
        fun redraw(context: Context, busy: Int? = null) {
            val c = context.applicationContext
            val mgr = AppWidgetManager.getInstance(c)
            val face = face(c, busy)
            for (id in ids(c)) mgr.updateAppWidget(id, views(c, mgr, id, face))
        }

        /**
         * Post a status ({ porchlight, hours?, until? }) and show it: "Turning on…", then the flip as soon as the
         * node accepts it, then the node's own answer (with `until`). onDone runs after all that.
         */
        fun set(context: Context, status: JSONObject, onDone: (() -> Unit)? = null) {
            val c = context.applicationContext
            val state = status.optString("porchlight")
            redraw(c, when (state) { "open" -> R.string.widget_sub_turning_on; "closed" -> R.string.widget_sub_turning_off; else -> R.string.widget_sub_saving })
            scope.launch {
                try {
                    if (ApiClient.setStatus(c, status) in 200..299) {
                        Prefs.setPorchlight(c, JSONObject().put("state", state))
                        redraw(c)
                        fetch(c)
                    } else {
                        redraw(c, R.string.widget_sub_failed)
                        delay(3_000)
                        redraw(c)
                    }
                } finally { onDone?.invoke() }
            }
        }

        /** "Porchlight on · until 9:40", for the menu's title. */
        fun describe(context: Context): String = face(context, null).let { f -> listOfNotNull(f.title, f.until?.let { context.getString(R.string.widget_until, it) }).joinToString(" · ") }

        private suspend fun fetch(c: Context) {
            if (!Prefs.isConfigured(c)) return redraw(c)
            val pl = ApiClient.myPorchlight(c) ?: return
            Prefs.setPorchlight(c, pl)
            redraw(c)
            scheduleAt(c, pl.optString("until").takeIf { !pl.isNull("until") && it.isNotBlank() })
        }

        private class Face(val lit: Boolean, val title: String, val sub: String, val until: String?, val tap: PendingIntent)

        private fun face(c: Context, busy: Int?): Face {
            val signedIn = Prefs.isConfigured(c)
            val pl = if (signedIn) Prefs.porchlight(c) else null
            val state = pl?.optString("state")
            val lit = state == "open"
            val until = pl?.takeIf { !it.isNull("until") }?.optString("until")?.let { iso ->
                try { DateFormat.getTimeFormat(c).format(Date.from(Instant.parse(iso))) } catch (e: Exception) { null }
            }
            val title = when {
                !signedIn -> c.getString(R.string.widget_title_signed_out)
                lit -> c.getString(R.string.widget_title_on)
                state == "ask" -> c.getString(R.string.widget_title_ask)
                else -> c.getString(R.string.widget_title_off)
            }
            val sub = when {
                busy != null -> c.getString(busy)
                !signedIn -> c.getString(R.string.widget_sub_signed_out)
                lit && until != null -> c.getString(R.string.widget_sub_until_turn_off, until)
                lit -> c.getString(R.string.widget_sub_turn_off)
                else -> c.getString(R.string.widget_sub_turn_on, ON_HOURS)
            }
            val tap = if (signedIn) {
                PendingIntent.getBroadcast(c, 0, Intent(c, PorchlightWidget::class.java).setAction(ACTION_TOGGLE),
                    PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
            } else {
                PendingIntent.getActivity(c, 0, Intent(c, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
                    PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
            }
            return Face(lit, title, sub, until, tap)
        }

        /** Android 12+ picks the layout itself as the widget is resized; before that, go by the reported size. */
        private fun views(c: Context, mgr: AppWidgetManager, id: Int, f: Face): RemoteViews {
            val small = R.layout.widget_porchlight_small
            val tall = R.layout.widget_porchlight_tall
            val wide = R.layout.widget_porchlight
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                return RemoteViews(mapOf(
                    SizeF(0f, 0f) to render(c, small, f),
                    SizeF(0f, TALL_DP.toFloat()) to render(c, tall, f),
                    SizeF(WIDE_DP.toFloat(), 0f) to render(c, wide, f),
                    SizeF(WIDE_DP.toFloat(), TALL_DP.toFloat()) to render(c, tall, f),
                ))
            }
            val o = mgr.getAppWidgetOptions(id)
            val w = o.getInt(AppWidgetManager.OPTION_APPWIDGET_MIN_WIDTH, WIDE_DP)
            val h = o.getInt(AppWidgetManager.OPTION_APPWIDGET_MAX_HEIGHT, 0)
            return render(c, if (h >= TALL_DP) tall else if (w >= WIDE_DP) wide else small, f)
        }

        private fun render(c: Context, layout: Int, f: Face) = RemoteViews(c.packageName, layout).apply {
            setImageViewResource(R.id.lantern, if (f.lit) R.drawable.lantern_on else R.drawable.lantern_off)
            setInt(android.R.id.background, "setBackgroundResource", if (f.lit) R.drawable.widget_bg_on else R.drawable.widget_bg)
            setOnClickPendingIntent(android.R.id.background, f.tap)
            if (layout == R.layout.widget_porchlight_small) {
                setContentDescription(android.R.id.background, "${f.title}. ${f.sub}")
            } else {
                setTextViewText(R.id.title, f.title)
                setTextViewText(R.id.sub, f.sub)
            }
        }

        /** Wake at `until` (+ a little, so the node has moved on) to redraw; no `until` cancels it. Inexact is fine. */
        private fun scheduleAt(c: Context, iso: String?) {
            val am = c.getSystemService(AlarmManager::class.java) ?: return
            val pi = PendingIntent.getBroadcast(c, 1, Intent(c, PorchlightWidget::class.java).setAction(ACTION_REFRESH),
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
            val at = iso?.let { try { Instant.parse(it).toEpochMilli() } catch (e: Exception) { null } }
            if (at == null || at < System.currentTimeMillis()) am.cancel(pi)
            else am.setAndAllowWhileIdle(AlarmManager.RTC, at + 30_000, pi)
        }
    }

    override fun onReceive(context: Context, intent: Intent) {
        when (intent.action) {
            ACTION_TOGGLE -> toggle(context)
            ACTION_REFRESH -> { val pending = goAsync(); scope.launch { try { fetch(context.applicationContext) } finally { pending.finish() } } }
            else -> super.onReceive(context, intent)
        }
    }

    override fun onUpdate(context: Context, mgr: AppWidgetManager, appWidgetIds: IntArray) {
        redraw(context)
        val pending = goAsync()
        scope.launch { try { fetch(context.applicationContext) } finally { pending.finish() } }
    }

    // Before Android 12 the layout is ours to pick, so a resize needs a redraw.
    override fun onAppWidgetOptionsChanged(context: Context, mgr: AppWidgetManager, appWidgetId: Int, newOptions: Bundle) = redraw(context)

    override fun onDisabled(context: Context) = scheduleAt(context, null)

    private fun toggle(context: Context) {
        val c = context.applicationContext
        if (!Prefs.isConfigured(c)) return redraw(c)
        val on = Prefs.porchlight(c)?.optString("state") != "open"
        val status = JSONObject().put("porchlight", if (on) "open" else "closed")
        if (on) status.put("hours", ON_HOURS)
        // goAsync keeps the process alive (~10 s) for the POST and the re-read.
        val pending = goAsync()
        set(c, status) { pending.finish() }
    }
}
