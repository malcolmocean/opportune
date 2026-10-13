package club.opportune.app

import android.Manifest
import android.annotation.SuppressLint
import android.content.ActivityNotFoundException
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageManager
import android.graphics.Bitmap
import android.location.Location
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.provider.Settings
import android.util.Log
import android.view.View
import android.webkit.ConsoleMessage
import android.webkit.GeolocationPermissions
import android.webkit.JavascriptInterface
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Button
import android.widget.EditText
import android.widget.TextView
import androidx.activity.OnBackPressedCallback
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AlertDialog
import androidx.appcompat.app.AppCompatActivity
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.lifecycle.lifecycleScope
import com.google.android.gms.location.FusedLocationProviderClient
import com.google.android.gms.location.LocationServices
import com.google.android.gms.location.Priority
import com.google.android.gms.tasks.CancellationTokenSource
import com.google.firebase.FirebaseApp
import com.google.firebase.messaging.FirebaseMessaging
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import org.json.JSONArray
import org.json.JSONObject
import java.time.Instant
import java.time.format.DateTimeFormatter

/**
 * The shell. A full-screen WebView loads `<node>/app?token=<token>[#nudges]` and exposes
 * `window.opportuneNative` (see docs/APP-BRIDGE.md). Everything a person sees is the web app; this
 * class only does what a browser can't: permissions, background location, FCM, contacts, deep links.
 * If the node can't be reached a small native screen offers Retry and a node URL field.
 */
class MainActivity : AppCompatActivity() {

    companion object {
        private const val TAG = "MainActivity"
        private const val BG_COLOR = 0xFF090B22.toInt()
        private const val NUDGES_HASH = "#nudges"
    }

    private lateinit var webView: WebView
    private lateinit var fallback: View
    private lateinit var fallbackMessage: TextView
    private lateinit var nodeInput: EditText
    private lateinit var fused: FusedLocationProviderClient

    /** True once the current main-frame load finished without a main-frame error. */
    @Volatile private var pageReady = false
    private var loadFailed = false
    /** getCurrentLocation() was asked for before we had location permission; deliver after the chain. */
    private var pendingFix = false
    /** A notification tap arrived while the page was loading; apply #nudges once it is ready. */
    private var pendingNudgesHash = false

    private val nudgeReceived = object : BroadcastReceiver() {
        override fun onReceive(context: Context, intent: Intent) {
            val id = intent.getStringExtra("nudgeId") ?: return
            val actions = try { JSONArray(intent.getStringExtra("actions") ?: "[]") } catch (e: Exception) { JSONArray() }
            callWeb("onNativeNudge", JSONObject().put("nudgeId", id).put("text", intent.getStringExtra("text") ?: "").put("actions", actions))
        }
    }
    private val nudgesChanged = object : BroadcastReceiver() {
        // answered from a notification button while the app is open: let the web app refresh its state
        override fun onReceive(context: Context, intent: Intent) { callWeb("onNativeResume", null) }
    }

    // ---- permission launchers (the chain: fine/coarse → background → activity recognition) ----
    private val notificationPermission = registerForActivityResult(ActivityResultContracts.RequestPermission()) { emitPermissions() }

    private val locationPermission = registerForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) { granted ->
        val ok = granted[Manifest.permission.ACCESS_FINE_LOCATION] == true || granted[Manifest.permission.ACCESS_COARSE_LOCATION] == true
        if (ok) requestBackgroundLocation() else {
            pendingFix = false
            emitPermissions()
            AlertDialog.Builder(this).setTitle(R.string.perm_location_title)
                .setMessage(R.string.perm_location_denied)
                .setPositiveButton(R.string.settings) { _, _ -> openAppSettings() }.setNegativeButton(R.string.later, null).show()
        }
    }

    private val backgroundPermission = registerForActivityResult(ActivityResultContracts.RequestPermission()) { requestActivityRecognition() }

    private val activityPermission = registerForActivityResult(ActivityResultContracts.RequestPermission()) { finishLocationSetup() }

    private val contactsPermission = registerForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        Prefs.setShareContacts(this, granted)
        if (granted) syncContactsNow()
        emitPermissions()
    }

    // ---- lifecycle ----
    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        WindowCompat.setDecorFitsSystemWindows(window, false)
        setContentView(R.layout.activity_main)
        FCMService.ensureChannel(this)
        fused = LocationServices.getFusedLocationProviderClient(this)

        val root = findViewById<View>(R.id.root)
        root.setBackgroundColor(BG_COLOR)
        // Edge-to-edge: the root draws the dark background under the bars and pads the content past them
        // (plus the keyboard), so the web page never has to know about safe areas.
        ViewCompat.setOnApplyWindowInsetsListener(root) { v, insets ->
            val bars = insets.getInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout())
            val ime = insets.getInsets(WindowInsetsCompat.Type.ime())
            v.setPadding(bars.left, bars.top, bars.right, maxOf(bars.bottom, ime.bottom))
            WindowInsetsCompat.CONSUMED
        }

        webView = findViewById(R.id.webView)
        fallback = findViewById(R.id.fallback)
        fallbackMessage = findViewById(R.id.fallbackMessage)
        nodeInput = findViewById(R.id.nodeInput)
        findViewById<Button>(R.id.retryButton).setOnClickListener {
            val typed = nodeInput.text.toString()
            val normalized = Prefs.normalizeNodeUrl(typed)
            if (typed.isNotBlank() && normalized == null) { fallbackMessage.text = getString(R.string.fallback_bad_url); return@setOnClickListener }
            if (normalized != null && normalized != Prefs.nodeUrl(this)) Prefs.setNodeUrl(this, normalized)
            loadApp(openNudges = false)
        }

        setupWebView()

        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                if (fallback.visibility != View.VISIBLE && webView.canGoBack()) webView.goBack()
                else { isEnabled = false; onBackPressedDispatcher.onBackPressed() }
            }
        })

        if (Prefs.isConfigured(this)) {
            LocationService.start(this)
            registerFcmToken()
        }
        val link = appLink(intent)
        if (link != null) loadLink(link) else loadApp(openNudges = wantsNudges(intent))
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        appLink(intent)?.let { loadLink(it); return }
        if (wantsNudges(intent)) showNudges()
    }

    /** An https://<node>/app… link (sign-in mail, email verify) delivered by App Links. Null for anything else. */
    private fun appLink(i: Intent?): String? {
        val u = i?.data ?: return null
        if (i.action != Intent.ACTION_VIEW || u.scheme != "https" || u.path?.startsWith("/app") != true) return null
        return u.toString()
    }

    /** Load a link in the WebView so its ?claim=CODE lands in the shell. The link's origin becomes the node. */
    private fun loadLink(url: String) {
        val origin = Uri.parse(url).let { "${it.scheme}://${it.authority}" }
        if (origin != Prefs.nodeUrl(this)) Prefs.setNodeUrl(this, origin)
        hideFallback()
        pageReady = false
        webView.loadUrl(url)
    }

    override fun onResume() {
        super.onResume()
        ContextCompat.registerReceiver(this, nudgeReceived, IntentFilter(FCMService.ACTION_NUDGE_RECEIVED), ContextCompat.RECEIVER_NOT_EXPORTED)
        ContextCompat.registerReceiver(this, nudgesChanged, IntentFilter(FCMService.ACTION_NUDGES_CHANGED), ContextCompat.RECEIVER_NOT_EXPORTED)
        webView.onResume()
        if (pageReady) callWeb("onNativeResume", null)
        lifecycleScope.launch(Dispatchers.IO) { ContactsSync.maybeSync(this@MainActivity) }
    }

    override fun onPause() {
        super.onPause()
        webView.onPause()
        // The web app may have just changed the porchlight; the widget only finds out by asking.
        PorchlightWidget.refresh(this)
        try { unregisterReceiver(nudgeReceived) } catch (e: IllegalArgumentException) {}
        try { unregisterReceiver(nudgesChanged) } catch (e: IllegalArgumentException) {}
    }

    override fun onDestroy() {
        webView.destroy()
        super.onDestroy()
    }

    private fun wantsNudges(i: Intent?) = i?.getBooleanExtra(FCMService.EXTRA_OPEN_NUDGES, false) == true || i?.hasExtra("nudgeId") == true

    // ---- WebView ----
    @SuppressLint("SetJavaScriptEnabled")
    private fun setupWebView() {
        webView.setBackgroundColor(BG_COLOR)
        webView.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            databaseEnabled = true
            setGeolocationEnabled(true)
            mediaPlaybackRequiresUserGesture = false
            cacheMode = WebSettings.LOAD_DEFAULT
            setSupportMultipleWindows(false)
            javaScriptCanOpenWindowsAutomatically = false
            useWideViewPort = true
            loadWithOverviewMode = true
            userAgentString = "$userAgentString opportune-android/${BuildConfig.VERSION_NAME}"
        }
        if (BuildConfig.DEBUG) WebView.setWebContentsDebuggingEnabled(true)
        webView.addJavascriptInterface(Bridge(), "opportuneNative")

        webView.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                val url = request.url
                if (isNodeOrigin(url) || url.scheme == "about" || url.scheme == "blob" || url.scheme == "data") return false
                openExternal(url.toString())
                return true
            }

            override fun onPageStarted(view: WebView, url: String?, favicon: Bitmap?) {
                pageReady = false
                loadFailed = false
            }

            override fun onPageFinished(view: WebView, url: String?) {
                if (loadFailed) return
                pageReady = true
                hideFallback()
                if (pendingNudgesHash) { pendingNudgesHash = false; showNudges() }
                emitPermissions()
            }

            override fun onReceivedError(view: WebView, request: WebResourceRequest, error: WebResourceError) {
                if (!request.isForMainFrame) return
                Log.w(TAG, "load failed: ${error.errorCode} ${error.description} ${request.url}")
                loadFailed = true; pageReady = false
                showFallback(getString(R.string.fallback_unreachable, Prefs.nodeUrl(this@MainActivity), error.description))
            }

            override fun onReceivedHttpError(view: WebView, request: WebResourceRequest, errorResponse: WebResourceResponse) {
                if (!request.isForMainFrame || errorResponse.statusCode < 500) return
                Log.w(TAG, "HTTP ${errorResponse.statusCode} for ${request.url}")
                loadFailed = true; pageReady = false
                showFallback(getString(R.string.fallback_http_error, Prefs.nodeUrl(this@MainActivity), errorResponse.statusCode))
            }
        }

        webView.webChromeClient = object : WebChromeClient() {
            override fun onGeolocationPermissionsShowPrompt(origin: String, callback: GeolocationPermissions.Callback) {
                val node = Uri.parse(Prefs.nodeUrl(this@MainActivity))
                val ours = isNodeOrigin(Uri.parse(origin))
                if (ours && !hasLocation()) requestLocationChain()
                callback.invoke(origin, ours && hasLocation(), false)
                Log.d(TAG, "geolocation prompt from $origin (node ${node.host}): ${ours && hasLocation()}")
            }

            override fun onConsoleMessage(m: ConsoleMessage): Boolean {
                Log.d("WebApp", "${m.message()} (${m.sourceId()}:${m.lineNumber()})")
                return true
            }
        }
    }

    private fun isNodeOrigin(u: Uri): Boolean {
        val node = Uri.parse(Prefs.nodeUrl(this))
        if (u.scheme != "http" && u.scheme != "https") return false
        if (!u.host.equals(node.host, ignoreCase = true)) return false
        fun port(x: Uri) = if (x.port > 0) x.port else if (x.scheme == "https") 443 else 80
        return port(u) == port(node) && u.scheme == node.scheme
    }

    private fun appUrl(openNudges: Boolean): String {
        val sb = StringBuilder(Prefs.nodeUrl(this)).append("/app")
        Prefs.token(this)?.let { sb.append("?token=").append(Uri.encode(it)) }
        if (openNudges) sb.append(NUDGES_HASH)
        return sb.toString()
    }

    private fun loadApp(openNudges: Boolean) {
        hideFallback()
        pageReady = false
        webView.loadUrl(appUrl(openNudges))
    }

    /** Notification body tapped: switch the already-loaded web app to #nudges (or reload there). */
    private fun showNudges() {
        if (fallback.visibility == View.VISIBLE) { loadApp(openNudges = true); return }
        if (!pageReady) { pendingNudgesHash = true; return }
        val current = webView.url?.let { Uri.parse(it) }
        if (current == null || !isNodeOrigin(current)) { loadApp(openNudges = true); return }
        webView.evaluateJavascript(
            "if (location.hash !== '$NUDGES_HASH') location.hash = '$NUDGES_HASH'; else window.dispatchEvent(new HashChangeEvent('hashchange'));", null)
    }

    private fun showFallback(message: String) {
        fallbackMessage.text = message
        if (nodeInput.text.isNullOrBlank()) nodeInput.setText(Prefs.nodeUrl(this))
        fallback.visibility = View.VISIBLE
        webView.visibility = View.INVISIBLE
    }

    private fun hideFallback() {
        fallback.visibility = View.GONE
        webView.visibility = View.VISIBLE
    }

    /** window.<fn>(<arg>) on the page, if the page defines it. Safe from any thread. */
    private fun callWeb(fn: String, arg: Any?) {
        val js = if (arg == null) "if (typeof window.$fn === 'function') window.$fn();"
                 else "if (typeof window.$fn === 'function') window.$fn($arg);"
        runOnUiThread { if (pageReady) webView.evaluateJavascript(js, null) }
    }

    // ---- permissions ----
    private fun granted(p: String) = ContextCompat.checkSelfPermission(this, p) == PackageManager.PERMISSION_GRANTED
    private fun hasLocation() = granted(Manifest.permission.ACCESS_FINE_LOCATION) || granted(Manifest.permission.ACCESS_COARSE_LOCATION)
    private fun hasBackground() = Build.VERSION.SDK_INT < Build.VERSION_CODES.Q || granted(Manifest.permission.ACCESS_BACKGROUND_LOCATION)
    private fun hasActivity() = Build.VERSION.SDK_INT < Build.VERSION_CODES.Q || granted(Manifest.permission.ACTIVITY_RECOGNITION)
    private fun hasNotifications() =
        (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU || granted(Manifest.permission.POST_NOTIFICATIONS)) &&
            NotificationManagerCompat.from(this).areNotificationsEnabled()
    private fun hasContacts() = ContactsSync.hasPermission(this) && Prefs.shareContacts(this)

    private fun permissionsJson(): JSONObject = JSONObject()
        .put("notifications", hasNotifications())
        .put("location", hasLocation())
        .put("backgroundLocation", hasLocation() && hasBackground())
        .put("activity", hasActivity())
        .put("contacts", hasContacts())

    private fun emitPermissions() = callWeb("onNativePermissions", permissionsJson())

    private fun requestNotificationsChain() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU && !granted(Manifest.permission.POST_NOTIFICATIONS)) {
            notificationPermission.launch(Manifest.permission.POST_NOTIFICATIONS)
        } else if (!NotificationManagerCompat.from(this).areNotificationsEnabled()) {
            // granted at the OS level but switched off in settings: the only way back is the settings screen
            try {
                startActivity(Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS).putExtra(Settings.EXTRA_APP_PACKAGE, packageName))
            } catch (e: ActivityNotFoundException) { openAppSettings() }
            emitPermissions()
        } else emitPermissions()
    }

    private fun requestLocationChain() {
        if (hasLocation()) requestBackgroundLocation()
        else locationPermission.launch(arrayOf(Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION))
    }

    private fun requestBackgroundLocation() {
        if (!hasBackground()) {
            AlertDialog.Builder(this).setTitle(R.string.perm_background_title)
                .setMessage(R.string.perm_background_rationale)
                .setPositiveButton(android.R.string.ok) { _, _ -> backgroundPermission.launch(Manifest.permission.ACCESS_BACKGROUND_LOCATION) }
                .setNegativeButton(R.string.skip) { _, _ -> requestActivityRecognition() }
                .setOnCancelListener { requestActivityRecognition() }
                .show()
        } else requestActivityRecognition()
    }

    private fun requestActivityRecognition() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q && !hasActivity()) activityPermission.launch(Manifest.permission.ACTIVITY_RECOGNITION)
        else finishLocationSetup()
    }

    private fun finishLocationSetup() {
        LocationService.start(this)
        registerFcmToken()
        emitPermissions()
        if (pendingFix) { pendingFix = false; fetchLocation() }
    }

    private fun requestContactsChain() {
        if (ContactsSync.hasPermission(this)) { Prefs.setShareContacts(this, true); syncContactsNow(); emitPermissions() }
        else contactsPermission.launch(Manifest.permission.READ_CONTACTS)
    }

    private fun syncContactsNow() {
        lifecycleScope.launch(Dispatchers.IO) {
            val n = ContactsSync.sync(this@MainActivity)
            Log.d(TAG, "contacts sync: $n")
            withContext(Dispatchers.Main) { emitPermissions() }
        }
    }

    private fun registerFcmToken() {
        if (!Prefs.isConfigured(this)) return
        if (FirebaseApp.getApps(this).isEmpty()) { Log.w(TAG, "Firebase not configured (no google-services.json); push off"); return }
        FirebaseMessaging.getInstance().token.addOnCompleteListener { task ->
            if (!task.isSuccessful) { Log.w(TAG, "FCM token unavailable", task.exception); return@addOnCompleteListener }
            val token = task.result ?: return@addOnCompleteListener
            if (Prefs.fcmRegisteredToken(this) == token) return@addOnCompleteListener
            lifecycleScope.launch(Dispatchers.IO) {
                val ok = ApiClient.registerToken(this@MainActivity, token)
                Log.d(TAG, "token registered: $ok")
            }
        }
    }

    // ---- one location fix ----
    @SuppressLint("MissingPermission")
    private fun fetchLocation() {
        if (!hasLocation()) { pendingFix = true; requestLocationChain(); return }
        val cts = CancellationTokenSource()
        fused.getCurrentLocation(Priority.PRIORITY_HIGH_ACCURACY, cts.token)
            .addOnSuccessListener { l ->
                if (l != null) emitLocation(l)
                else fused.lastLocation.addOnSuccessListener { last -> if (last != null) emitLocation(last) else emitLocationError("unavailable") }
                    .addOnFailureListener { e -> emitLocationError(e.message ?: "unavailable") }
            }
            .addOnFailureListener { e -> emitLocationError(e.message ?: "unavailable") }
    }

    private fun emitLocation(l: Location) {
        callWeb("onNativeLocation", JSONObject()
            .put("lat", l.latitude).put("lng", l.longitude)
            .put("acc", if (l.hasAccuracy()) l.accuracy.toDouble() else JSONObject.NULL)
            .put("at", DateTimeFormatter.ISO_INSTANT.format(Instant.ofEpochMilli(l.time))))
    }

    private fun emitLocationError(reason: String) = callWeb("onNativeLocation", JSONObject().put("error", reason))

    // ---- misc ----
    private fun openExternal(url: String) {
        try { startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url)).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) }
        catch (e: ActivityNotFoundException) { Log.w(TAG, "nothing handles $url") }
    }

    private fun openAppSettings() = startActivity(Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.fromParts("package", packageName, null)))

    /** window.opportuneNative — the contract in docs/APP-BRIDGE.md. Methods run on the WebView's bridge thread. */
    inner class Bridge {
        @JavascriptInterface fun getNodeUrl(): String = Prefs.nodeUrl(this@MainActivity)

        @JavascriptInterface fun getIngestUrl(): String = Prefs.ingestUrl(this@MainActivity) ?: ""

        @JavascriptInterface fun setIngestUrl(url: String?) {
            val parsed = Prefs.parseIngestUrl(url)
            if (parsed == null) { Log.w(TAG, "setIngestUrl: not an ingest URL: $url"); return }
            Prefs.setIngestUrl(this@MainActivity, url)
            Log.d(TAG, "ingest URL set for node ${parsed.baseUrl}")
            runOnUiThread {
                LocationService.start(this@MainActivity)
                registerFcmToken()
                lifecycleScope.launch(Dispatchers.IO) { ContactsSync.maybeSync(this@MainActivity) }
            }
        }

        /**
         * The web app forgets its token and calls this so the shell forgets too: ingest URL, FCM
         * registration, contacts switch, queued points, the running service. Nothing is posted after it
         * returns. Permissions stay granted at the OS level; `contacts` reads false because the switch is off.
         */
        @JavascriptInterface fun signOut() {
            Session.signOut(this@MainActivity, "web app signed out")
            runOnUiThread { emitPermissions() }
        }

        @JavascriptInterface fun getPermissions(): String = permissionsJson().toString()

        @JavascriptInterface fun requestLocation() { runOnUiThread { requestLocationChain() } }

        @JavascriptInterface fun requestNotifications() { runOnUiThread { requestNotificationsChain() } }

        @JavascriptInterface fun requestContacts() { runOnUiThread { requestContactsChain() } }

        /** Not in the contract: turns the daily contacts sync back off (the OS permission stays). */
        @JavascriptInterface fun stopContacts() { Prefs.setShareContacts(this@MainActivity, false); emitPermissions() }

        @JavascriptInterface fun getCurrentLocation() { runOnUiThread { fetchLocation() } }

        @JavascriptInterface fun openExternal(url: String?) { if (!url.isNullOrBlank()) runOnUiThread { this@MainActivity.openExternal(url) } }

        @JavascriptInterface fun getDeviceInfo(): String = JSONObject()
            .put("model", Build.MODEL)
            .put("manufacturer", Build.MANUFACTURER)
            .put("androidVersion", Build.VERSION.RELEASE)
            .put("sdk", Build.VERSION.SDK_INT)
            .put("appVersion", BuildConfig.VERSION_NAME)
            .put("versionCode", BuildConfig.VERSION_CODE)
            .toString()
    }
}
