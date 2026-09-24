package com.notionless.app

import android.annotation.SuppressLint
import android.app.DownloadManager
import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Environment
import android.view.View
import android.webkit.CookieManager
import android.webkit.DownloadListener
import android.webkit.GeolocationPermissions
import android.webkit.JavascriptInterface
import android.webkit.PermissionRequest
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebSettings
import android.webkit.WebStorage
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Button
import android.widget.ProgressBar
import android.widget.TextView
import android.widget.Toast
import androidx.activity.OnBackPressedCallback
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.browser.customtabs.CustomTabsIntent
import androidx.swiperefreshlayout.widget.SwipeRefreshLayout

/**
 * Simple companion wrapper around the NotionLess web app.
 *
 * Persistence notes (why login + drafts survive):
 * - Cookies: CookieManager accept + third-party accept, flushed on pause.
 * - localStorage / IndexedDB / WebStorage: domStorage + database enabled,
 *   app-cache/database paths pointed at the app cache dir.
 */
class MainActivity : AppCompatActivity() {

    companion object {
        /** Change this for local testing, e.g. "http://10.0.2.2:5001/". */
        const val BASE_URL = "https://notionless.pythonanywhere.com/"
        private const val STATE_WEBVIEW = "webview_state"

        /**
         * The web app never scrolls the page itself (`html, body { overflow: hidden }` —
         * scrolling happens in inner divs like the sidebar / editor). So the WebView's
         * own scrollY stays 0 and SwipeRefreshLayout would think we are always at the
         * top, stealing every swipe-down as a refresh. This hook asks the page whether
         * ALL of its scrollers are at the top and reports back via NotionLessScroll.
         */
        private const val SCROLL_HOOK_JS = """(function(){
  if (window.__nlScrollReport) { window.__nlScrollReport(); return; }
  var scheduled = false;
  var candidates = null;
  var lastScan = 0;
  // Full DOM scan + getComputedStyle per scroll frame janks on large docs,
  // so cache the scrollable elements and re-scan at most every 2s.
  function refreshCandidates() {
    var found = [];
    try {
      var els = document.querySelectorAll('*');
      for (var i = 0; i < els.length; i++) {
        var el = els[i];
        if (el.scrollHeight > el.clientHeight + 8) {
          var oy = null;
          try { oy = window.getComputedStyle(el).overflowY; } catch (e) {}
          if (oy === 'auto' || oy === 'scroll' || oy === 'overlay') found.push(el);
        }
      }
    } catch (e) {}
    candidates = found;
    lastScan = Date.now();
  }
  function atTop() {
    try {
      if (window.scrollY > 4) return false;
      var de = document.scrollingElement || document.documentElement;
      if (de && de.scrollTop > 4) return false;
      if (document.body && document.body.scrollTop > 4) return false;
      if (!candidates || Date.now() - lastScan > 2000) refreshCandidates();
      for (var i = 0; i < candidates.length; i++) {
        if (candidates[i].scrollTop > 8) return false;
      }
      return true;
    } catch (e) { return true; }
  }
  function send() {
    scheduled = false;
    try { NotionLessScroll.onInnerScrollTop(atTop()); } catch (e) {}
  }
  function report() {
    // rAF-throttle: scroll events fire fast, the check only runs once per frame.
    if (scheduled) return;
    scheduled = true;
    if (window.requestAnimationFrame) window.requestAnimationFrame(send);
    else setTimeout(send, 32);
  }
  window.__nlScrollReport = send;
  window.__nlScrollRescan = refreshCandidates;
  document.addEventListener('scroll', report, {capture: true, passive: true});
  document.addEventListener('touchstart', report, {capture: true, passive: true});
  document.addEventListener('touchmove', report, {capture: true, passive: true});
  window.addEventListener('scroll', report, {passive: true});
  window.addEventListener('resize', function() { refreshCandidates(); report(); });
  refreshCandidates();
  send();
})();"""
    }

    private lateinit var webView: WebView
    private lateinit var swipeRefresh: SwipeRefreshLayout
    private lateinit var progressBar: ProgressBar
    private lateinit var errorView: View
    private lateinit var errorText: TextView

    private var filePathCallback: ValueCallback<Array<Uri>>? = null

    /**
     * Last known inner-scroll state from the page hook. Volatile because it is
     * written from the JS bridge thread and read on the UI thread during touch
     * interception. Defaults to true (fresh page = at top = refresh allowed).
     */
    @Volatile
    private var innerScrollAtTop = true

    /** Called from JS: true when every scroller in the page is at the top. */
    private inner class ScrollBridge {
        @JavascriptInterface
        fun onInnerScrollTop(atTop: Boolean) {
            runOnUiThread {
                innerScrollAtTop = atTop
                updateRefreshEnabled()
            }
        }
    }

    private fun updateRefreshEnabled() {
        if (!::swipeRefresh.isInitialized || !::webView.isInitialized) return
        swipeRefresh.isEnabled = innerScrollAtTop && webView.scrollY <= 0
    }

    private val fileChooserLauncher =
        registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
            val callback = filePathCallback
            filePathCallback = null
            if (result.resultCode == RESULT_OK) {
                val data = result.data
                val uris = WebChromeClient.FileChooserParams.parseResult(result.resultCode, data)
                callback?.onReceiveValue(uris)
            } else {
                callback?.onReceiveValue(null)
            }
        }

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)

        webView = findViewById(R.id.webView)
        swipeRefresh = findViewById(R.id.swipeRefresh)
        progressBar = findViewById(R.id.progressBar)
        errorView = findViewById(R.id.errorView)
        errorText = findViewById(R.id.errorText)
        findViewById<Button>(R.id.retryButton).setOnClickListener {
            errorView.visibility = View.GONE
            loadHome(force = true)
        }

        // ---- Storage / cookie setup: this is what makes the webapp work ----
        val cookieManager = CookieManager.getInstance()
        cookieManager.setAcceptCookie(true)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
            cookieManager.setAcceptThirdPartyCookies(webView, true)
        }

        val settings: WebSettings = webView.settings
        settings.javaScriptEnabled = true
        settings.domStorageEnabled = true      // localStorage
        settings.databaseEnabled = true        // IndexedDB / WebSQL quota path
        settings.mediaPlaybackRequiresUserGesture = false
        settings.loadWithOverviewMode = true
        settings.useWideViewPort = true
        settings.builtInZoomControls = false
        settings.displayZoomControls = false
        settings.allowFileAccess = true
        settings.allowContentAccess = true
        settings.cacheMode = WebSettings.LOAD_DEFAULT
        @Suppress("DEPRECATION")
        settings.saveFormData = true
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            settings.safeBrowsingEnabled = true
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
            settings.mixedContentMode = WebSettings.MIXED_CONTENT_ALWAYS_ALLOW
        }
        settings.databasePath = cacheDir.resolve("webview-db").apply { mkdirs() }.absolutePath
        settings.setGeolocationEnabled(true)
        settings.setGeolocationDatabasePath(
            cacheDir.resolve("webview-geo").apply { mkdirs() }.absolutePath
        )
        // Tag the UA so server logs can tell app traffic apart (site still works the same).
        if (!settings.userAgentString.contains("NotionLessAndroid")) {
            settings.userAgentString = settings.userAgentString + " NotionLessAndroid/1.0"
        }

        // Bridge for the scroll-top hook (pull-to-refresh guard). Must be added
        // before any page loads so the injected JS can reach it.
        webView.addJavascriptInterface(ScrollBridge(), "NotionLessScroll")

        webView.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                val url = request.url.toString()
                return handleNavigation(url)
            }

            @Suppress("OverridingDeprecatedMember")
            override fun shouldOverrideUrlLoading(view: WebView, url: String): Boolean {
                return handleNavigation(url)
            }

            override fun onPageStarted(view: WebView, url: String, favicon: Bitmap?) {
                super.onPageStarted(view, url, favicon)
                progressBar.visibility = View.VISIBLE
                errorView.visibility = View.GONE
                // Fresh navigation: assume top until the hook reports otherwise.
                innerScrollAtTop = true
                updateRefreshEnabled()
            }

            override fun onPageFinished(view: WebView, url: String) {
                super.onPageFinished(view, url)
                progressBar.visibility = View.GONE
                swipeRefresh.isRefreshing = false
                innerScrollAtTop = true
                updateRefreshEnabled()
                // (Re-)install the scroll-top reporter — needed on every page
                // load since each navigation gets a fresh JS context.
                view.evaluateJavascript(SCROLL_HOOK_JS, null)
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
                    CookieManager.getInstance().flush()
                }
            }

            override fun onReceivedError(
                view: WebView,
                request: WebResourceRequest,
                error: WebResourceError
            ) {
                super.onReceivedError(view, request, error)
                if (request.isForMainFrame) {
                    swipeRefresh.isRefreshing = false
                    progressBar.visibility = View.GONE
                    showError(getString(R.string.error_load, error.description))
                }
            }

            @Suppress("OverridingDeprecatedMember", "DEPRECATION")
            override fun onReceivedError(
                view: WebView,
                errorCode: Int,
                description: String,
                failingUrl: String
            ) {
                super.onReceivedError(view, errorCode, description, failingUrl)
                swipeRefresh.isRefreshing = false
                progressBar.visibility = View.GONE
                showError(getString(R.string.error_load, description))
            }
        }

        webView.webChromeClient = object : WebChromeClient() {
            override fun onProgressChanged(view: WebView, newProgress: Int) {
                progressBar.progress = newProgress
                progressBar.visibility = if (newProgress in 1..99) View.VISIBLE else View.GONE
            }

            override fun onExceededDatabaseQuota(
                url: String, databaseIdentifier: String, quota: Long,
                estimatedDatabaseSize: Long, totalQuota: Long,
                quotaUpdater: WebStorage.QuotaUpdater
            ) {
                // Be generous: offline drafts + IndexedDB need room.
                quotaUpdater.updateQuota(estimatedDatabaseSize * 2)
            }

            override fun onGeolocationPermissionsShowPrompt(
                origin: String, callback: GeolocationPermissions.Callback
            ) {
                callback.invoke(origin, true, false)
            }

            override fun onPermissionRequest(request: PermissionRequest) {
                // Grant camera/mic if the editor ever asks (e.g. image capture).
                runOnUiThread { request.grant(request.resources) }
            }

            override fun onShowFileChooser(
                view: WebView,
                callback: ValueCallback<Array<Uri>>,
                params: FileChooserParams
            ): Boolean {
                filePathCallback?.onReceiveValue(null)
                filePathCallback = callback
                return try {
                    fileChooserLauncher.launch(params.createIntent())
                    true
                } catch (e: ActivityNotFoundException) {
                    filePathCallback = null
                    Toast.makeText(this@MainActivity, R.string.no_file_app, Toast.LENGTH_SHORT).show()
                    false
                }
            }
        }

        webView.setDownloadListener(DownloadListener { url, userAgent, contentDisposition, mimeType, _ ->
            try {
                val request = DownloadManager.Request(Uri.parse(url)).apply {
                    addRequestHeader("Cookie", CookieManager.getInstance().getCookie(url))
                    addRequestHeader("User-Agent", userAgent)
                    setDescription(contentDisposition)
                    setMimeType(mimeType)
                    setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED)
                    setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS, Uri.parse(url).lastPathSegment ?: "notionless-download")
                }
                (getSystemService(Context.DOWNLOAD_SERVICE) as DownloadManager).enqueue(request)
                Toast.makeText(this, R.string.downloading, Toast.LENGTH_SHORT).show()
            } catch (e: Exception) {
                openExternal(url)
            }
        })

        swipeRefresh.setOnRefreshListener { webView.reload() }

        // Only allow the pull gesture when nothing on the page is scrolled:
        // - webView.canScrollVertically(-1) covers pages that scroll natively
        //   (login, landing, public pages where body scrolls).
        // - innerScrollAtTop covers the workspace, where scrolling happens in
        //   inner divs and the WebView itself never scrolls. It is kept fresh
        //   by the JS hook; this synchronous check guards the touch-intercept
        //   race. updateRefreshEnabled() disables the layout outright so the
        //   gesture never even starts mid-content.
        swipeRefresh.setOnChildScrollUpCallback { _, _ ->
            webView.canScrollVertically(-1) || !innerScrollAtTop
        }
        webView.setOnScrollChangeListener { _, _, scrollY, _, _ ->
            updateRefreshEnabled()
            if (scrollY == 0) {
                // Native scroll back at top — re-ask the page about its inners.
                webView.evaluateJavascript(
                    "try{window.__nlScrollReport&&window.__nlScrollReport()}catch(e){}",
                    null
                )
            }
        }

        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                if (::webView.isInitialized && webView.canGoBack()) webView.goBack()
                else finish()
            }
        })

        if (savedInstanceState != null) {
            webView.restoreState(savedInstanceState.getBundle(STATE_WEBVIEW) ?: Bundle())
            // Restored pages don't reliably trigger onPageFinished, so the
            // scroll hook would never install after rotation. Re-inject once
            // the restored page has had a moment to settle.
            webView.postDelayed({
                if (!isFinishing && !isDestroyed) {
                    webView.evaluateJavascript(SCROLL_HOOK_JS, null)
                }
            }, 500)
        } else {
            val deepLink = intent?.dataString
            if (deepLink != null && deepLink.startsWith(BASE_URL.trimEnd('/'))) {
                webView.loadUrl(deepLink)
            } else {
                loadHome()
            }
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        intent.dataString?.let { url ->
            if (url.startsWith(BASE_URL.trimEnd('/'))) webView.loadUrl(url)
        }
    }

    private fun loadHome(force: Boolean = false) {
        if (!isOnline()) {
            // Offline: still load — the web app boots from cache/IndexedDB
            // and shows its own "Offline — editing locally" state.
            Toast.makeText(this, R.string.offline_hint, Toast.LENGTH_LONG).show()
        }
        if (force || webView.url.isNullOrEmpty()) webView.loadUrl(BASE_URL)
        else webView.reload()
    }

    /** Keep app pages inside the WebView; open everything else outside. */
    private fun handleNavigation(url: String): Boolean {
        val uri = runCatching { Uri.parse(url) }.getOrNull() ?: return false
        val scheme = uri.scheme?.lowercase() ?: return false
        if (scheme !in listOf("http", "https")) {
            // tel:, mailto:, intent:, etc.
            return try {
                startActivity(Intent(Intent.ACTION_VIEW, uri))
                true
            } catch (e: ActivityNotFoundException) {
                false
            }
        }
        val host = (uri.host ?: "").lowercase()
        val appHost = runCatching { Uri.parse(BASE_URL).host?.lowercase() }.getOrNull().orEmpty()
        val stayInside = host == appHost ||
            host == "127.0.0.1" || host == "10.0.2.2" || host.endsWith(".localhost")
        if (stayInside) return false
        // target=_blank popups from the editor land here too.
        if (uri.toString().startsWith(BASE_URL.trimEnd('/'))) return false
        openExternal(url)
        return true
    }

    private fun openExternal(url: String) {
        try {
            CustomTabsIntent.Builder().build().launchUrl(this, Uri.parse(url))
        } catch (e: Exception) {
            try {
                startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url)))
            } catch (e2: ActivityNotFoundException) {
                Toast.makeText(this, R.string.no_browser, Toast.LENGTH_SHORT).show()
            }
        }
    }

    private fun showError(detail: CharSequence) {
        if (webView.url.isNullOrEmpty()) {
            errorText.text = detail
            errorView.visibility = View.VISIBLE
        } else {
            Toast.makeText(this, detail, Toast.LENGTH_SHORT).show()
        }
    }

    private fun isOnline(): Boolean {
        val cm = getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager
        val caps = cm.getNetworkCapabilities(cm.activeNetwork) ?: return false
        return caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET) &&
            caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED)
    }

    override fun onSaveInstanceState(outState: Bundle) {
        super.onSaveInstanceState(outState)
        if (::webView.isInitialized) {
            val bundle = Bundle()
            webView.saveState(bundle)
            outState.putBundle(STATE_WEBVIEW, bundle)
        }
    }

    override fun onPause() {
        super.onPause()
        webView.onPause()
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
            CookieManager.getInstance().flush()
        }
    }

    override fun onResume() {
        super.onResume()
        webView.onResume()
    }

    override fun onDestroy() {
        filePathCallback?.onReceiveValue(null)
        filePathCallback = null
        if (::webView.isInitialized) webView.destroy()
        super.onDestroy()
    }
}
