# BrowserAI ProGuard rules
# Сохраняем JSON-классы (нужны для OTA-парсинга GitHub API)
-keepclassmembers class org.json.** { *; }

# Сохраняем FileProvider
-keep class androidx.core.content.FileProvider { *; }

# WebView JavaScript interface (если добавим в будущем)
-keepclassmembers class * {
    @android.webkit.JavascriptInterface <methods>;
}

# Не обфусцировать Activity
-keep class ai.browser.app.** { *; }
