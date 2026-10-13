package club.opportune.app

import android.appwidget.AppWidgetManager
import android.content.Intent
import android.os.Bundle
import androidx.appcompat.app.AlertDialog
import androidx.appcompat.app.AppCompatActivity
import org.json.JSONObject
import java.time.Instant
import java.time.ZonedDateTime

/**
 * The widget's long-press menu: the launcher's "Widget settings" (the widget is reconfigurable) lands here. A list
 * over the home screen with the porch sheet's choices (web/app.js openPorchSheet, minus the note). Before Android 12
 * the launcher also opens this when the widget is placed; any answer, or none, keeps the widget.
 */
class PorchlightMenuActivity : AppCompatActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val widgetId = intent.getIntExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, AppWidgetManager.INVALID_APPWIDGET_ID)
        setResult(RESULT_OK, Intent().putExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, widgetId))

        if (!Prefs.isConfigured(this)) return openApp()

        val choices: List<Pair<Int, () -> JSONObject?>> = listOf(
            R.string.menu_on_1h to { open(1) },
            R.string.menu_on_2h to { open(2) },
            R.string.menu_on_4h to { open(4) },
            R.string.menu_on_tonight to ::tonight,
            R.string.menu_ask to { JSONObject().put("porchlight", "ask") },
            R.string.menu_off to { JSONObject().put("porchlight", "closed") },
            R.string.menu_off_night to { JSONObject().put("porchlight", "closed").put("until", "morning") },
            R.string.menu_open_app to { null },
        )
        AlertDialog.Builder(this)
            .setTitle(PorchlightWidget.describe(this))
            .setItems(choices.map { getString(it.first) }.toTypedArray()) { _, i ->
                val status = choices[i].second()
                if (status == null) openApp() else PorchlightWidget.set(this, status)
            }
            .setOnDismissListener { if (!isFinishing) finish() }
            .show()
    }

    private fun open(hours: Int) = JSONObject().put("porchlight", "open").put("hours", hours)

    /** Same as the porch sheet's "tonight": until 11:30pm, or 2am if that's under 45 minutes off. */
    private fun tonight(): JSONObject {
        val now = ZonedDateTime.now()
        var until = now.withHour(23).withMinute(30).withSecond(0).withNano(0)
        if (until.toInstant().toEpochMilli() - now.toInstant().toEpochMilli() < 45 * 60_000) until = until.plusDays(1).withHour(2).withMinute(0)
        val hours = maxOf(1.0, (until.toInstant().toEpochMilli() - now.toInstant().toEpochMilli()) / 3_600_000.0)
        return JSONObject().put("porchlight", "open").put("until", Instant.from(until).toString()).put("hours", hours)
    }

    private fun openApp() {
        startActivity(Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        finish()
    }
}
