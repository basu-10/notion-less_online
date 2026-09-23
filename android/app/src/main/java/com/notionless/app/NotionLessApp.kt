package com.notionless.app

import android.app.Application
import android.webkit.CookieManager
import android.webkit.WebView

class NotionLessApp : Application() {
    override fun onCreate() {
        super.onCreate()
        // Accept cookies globally so the Flask login session survives restarts.
        CookieManager.getInstance().setAcceptCookie(true)
        // Enable WebView debugging only for debuggable builds (Chrome inspect).
        WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG)
    }
}
