package ai.browser.app;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.app.AlertDialog;
import android.app.DownloadManager;
import android.content.Context;
import android.content.Intent;
import android.net.ConnectivityManager;
import android.net.NetworkCapabilities;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.provider.Settings;
import android.view.View;
import android.webkit.CookieManager;
import android.webkit.DownloadListener;
import android.net.http.SslError;
import android.webkit.SslErrorHandler;
// SslError из android.net.http, SslErrorHandler из android.webkit — совместимо с SDK 24-34
import android.webkit.URLUtil;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.ConsoleMessage;
import android.webkit.WebResourceError;
import android.webkit.WebResourceResponse;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.webkit.GeolocationPermissions;
import android.webkit.PermissionRequest;
import android.widget.FrameLayout;
import android.widget.ProgressBar;
import android.widget.TextView;
import android.widget.Toast;

import androidx.core.content.FileProvider;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.net.HttpURLConnection;
import java.net.URL;
import javax.net.ssl.HttpsURLConnection;
import java.util.regex.Matcher;
import java.util.regex.Pattern;


public class MainActivity extends Activity {
    private static final int FILE_CHOOSER_REQUEST = 1001;
    // Наш сервер на Railway — быстрее, без rate-limit GitHub, мы контролируем версию
    // /api/app-version возвращает: minNativeVersion, apkUrl, releaseNotes
    private static final String APP_VERSION_API = "/api/app-version";
    // FIX: макс размер APK 150 МБ
    private static final long MAX_APK_BYTES = 150L * 1024 * 1024;

    private WebView webView;
    private TextView offlineView;
    private ProgressBar progressBar;
    private ValueCallback<Uri[]> filePathCallback;
    private String appUrl;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        appUrl = getString(getResources().getIdentifier("app_url", "string", getPackageName()));

        getWindow().setStatusBarColor(0xFF24262B);
        getWindow().setNavigationBarColor(0xFF24262B);

        FrameLayout root = new FrameLayout(this);
        root.setBackgroundColor(0xFF24262B);

        // WebView
        webView = new WebView(this);
        webView.setBackgroundColor(0xFF24262B);
        root.addView(webView, new FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT,
                FrameLayout.LayoutParams.MATCH_PARENT
        ));

        // FIX: ProgressBar — показываем пока страница грузится
        progressBar = new ProgressBar(this, null, android.R.attr.progressBarStyleHorizontal);
        progressBar.setMax(100);
        progressBar.setProgressTintList(android.content.res.ColorStateList.valueOf(0xFFE6E8EC));
        progressBar.setIndeterminate(false);
        FrameLayout.LayoutParams pbParams = new FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT, 6);
        pbParams.gravity = android.view.Gravity.TOP;
        root.addView(progressBar, pbParams);

        // Offline / error view
        offlineView = new TextView(this);
        offlineView.setTextColor(0xFFE6E8EC);
        offlineView.setTextSize(16);
        offlineView.setGravity(android.view.Gravity.CENTER);
        offlineView.setPadding(48, 48, 48, 48);
        offlineView.setVisibility(View.GONE);
        root.addView(offlineView, new FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT,
                FrameLayout.LayoutParams.MATCH_PARENT
        ));

        setContentView(root);
        configureWebView();
        loadApp();
        checkForUpdates();
    }

    @SuppressLint("SetJavaScriptEnabled")
    private void configureWebView() {
        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setDatabaseEnabled(true);
        // Правильный мобильный viewport — НЕ форсируем desktop
        settings.setLoadWithOverviewMode(false);
        settings.setUseWideViewPort(false);
        settings.setMediaPlaybackRequiresUserGesture(false);
        settings.setAllowFileAccess(true);
        settings.setAllowContentAccess(true);
        settings.setCacheMode(WebSettings.LOAD_DEFAULT);
        settings.setJavaScriptCanOpenWindowsAutomatically(true);
        settings.setSupportMultipleWindows(true);
        // Разрешаем открытие новых окон — нужно для target="_blank" ссылок из Markdown
        settings.setTextZoom(100);

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
            settings.setMixedContentMode(WebSettings.MIXED_CONTENT_COMPATIBILITY_MODE);
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            settings.setSafeBrowsingEnabled(true);
        }

        // Cookies — разрешаем включая third-party (нужно для Railway + сессий)
        CookieManager cookieManager = CookieManager.getInstance();
        cookieManager.setAcceptCookie(true);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
            cookieManager.setAcceptThirdPartyCookies(webView, true);
        }

        // FIX: WebView отладка ТОЛЬКО в debug-сборке (защита от ADB-перехвата сессий)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.KITKAT) {
            WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG);
        }

        webView.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                Uri uri = request.getUrl();
                String url = uri.toString();
                // Внутренние ссылки открываем в WebView, внешние — в браузере
                if (isSameHost(url) || url.startsWith("about:")) {
                    return false;
                }
                try {
                    Intent intent = new Intent(Intent.ACTION_VIEW, uri);
                    startActivity(intent);
                } catch (Exception ignored) { /* нет браузера */ }
                return true;
            }

            @Override
            public void onPageStarted(WebView view, String url, android.graphics.Bitmap favicon) {
                // FIX: показываем прогресс-бар при начале загрузки
                progressBar.setVisibility(View.VISIBLE);
                progressBar.setProgress(10);
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                // FIX: скрываем прогресс-бар
                progressBar.setProgress(100);
                progressBar.setVisibility(View.GONE);
                offlineView.setVisibility(View.GONE);
                webView.setVisibility(View.VISIBLE);

                // Проверяем что React-приложение реально смонтировалось (через 5с)
                view.postDelayed(() -> view.evaluateJavascript(
                        "Boolean(document.getElementById('root') && document.getElementById('root').children.length)",
                        value -> {
                            if (!"true".equals(value)) {
                                showError("Интерфейс не запустился.\n\nОбновите Android System WebView в Google Play или нажмите назад и попробуйте снова.");
                            }
                        }
                ), 5000);
            }

            @Override
            public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
                super.onReceivedError(view, request, error);
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M && request.isForMainFrame()) {
                    progressBar.setVisibility(View.GONE);
                    showError("Ошибка загрузки: " + error.getDescription()
                            + "\n\nПроверьте интернет-соединение.");
                }
            }

            @Override
            public void onReceivedHttpError(WebView view, WebResourceRequest request,
                                            WebResourceResponse errorResponse) {
                super.onReceivedHttpError(view, request, errorResponse);
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP && request.isForMainFrame()) {
                    progressBar.setVisibility(View.GONE);
                    int code = errorResponse.getStatusCode();
                    if (code >= 500) {
                        showError("Сервер временно недоступен (HTTP " + code + ").\n\nПодождите немного и обновите страницу.");
                    }
                }
            }

            // FIX: обработка SSL-ошибок с понятным сообщением
            // @Override убран — метод удалён из WebViewClient в SDK 35
            @SuppressWarnings("deprecation")
            public void onReceivedSslError(WebView view, SslErrorHandler handler, SslError error) {
                progressBar.setVisibility(View.GONE);
                String reason;
                switch (error.getPrimaryError()) {
                    case SslError.SSL_EXPIRED:    reason = "Сертификат сайта истёк"; break;
                    case SslError.SSL_UNTRUSTED:  reason = "Сертификат не доверенный"; break;
                    case SslError.SSL_IDMISMATCH: reason = "Домен не совпадает с сертификатом"; break;
                    default: reason = "SSL-ошибка " + error.getPrimaryError(); break;
                }
                new AlertDialog.Builder(MainActivity.this)
                        .setTitle("Ошибка безопасности")
                        .setMessage(reason + "\n\nПодключение небезопасно. Продолжить всё равно?")
                        .setPositiveButton("Продолжить", (d, w) -> handler.proceed())
                        .setNegativeButton("Отмена", (d, w) -> {
                            handler.cancel();
                            showError("Загрузка отменена: " + reason);
                        })
                        .setCancelable(false)
                        .show();
            }

            // Обработка краша WebView процесса (OOM или внутренняя ошибка)
            @Override
            public boolean onRenderProcessGone(WebView view, android.webkit.RenderProcessGoneDetail detail) {
                runOnUiThread(() -> {
                    webView.destroy();
                    webView = null;
                    showError("WebView упал (нехватка памяти?).\n\nПерезапустите приложение.");
                });
                return true; // true = мы обработали краш, приложение не падает
            }
        });

        // FIX: прогресс WebChromeClient тоже обновляет progressBar
        webView.setWebChromeClient(new WebChromeClient() {
            @Override
            public void onProgressChanged(WebView view, int newProgress) {
                if (progressBar != null) {
                    progressBar.setProgress(newProgress);
                    progressBar.setVisibility(newProgress == 100 ? View.GONE : View.VISIBLE);
                }
            }

            // Перехватываем target="_blank" — открываем ссылку в браузере, не в новом WebView
            @Override
            public boolean onCreateWindow(WebView view, boolean isDialog, boolean isUserGesture, android.os.Message resultMsg) {
                WebView.HitTestResult result = view.getHitTestResult();
                String url = result != null ? result.getExtra() : null;
                if (url != null && !url.isEmpty()) {
                    try {
                        Intent intent = new Intent(Intent.ACTION_VIEW, Uri.parse(url));
                        startActivity(intent);
                    } catch (Exception ignored) { }
                    return false;
                }
                // Если URL неизвестен — пробуем через транспортный WebView
                WebView transport = new WebView(MainActivity.this);
                transport.setWebViewClient(new WebViewClient() {
                    @Override
                    public boolean shouldOverrideUrlLoading(WebView v, WebResourceRequest req) {
                        try {
                            startActivity(new Intent(Intent.ACTION_VIEW, req.getUrl()));
                        } catch (Exception ignored) { }
                        return true;
                    }
                });
                WebView.WebViewTransport wvt = (WebView.WebViewTransport) resultMsg.obj;
                wvt.setWebView(transport);
                resultMsg.sendToTarget();
                return true;
            }

            @Override
            public boolean onConsoleMessage(ConsoleMessage consoleMessage) {
                return super.onConsoleMessage(consoleMessage);
            }

            // Разрешения для микрофона/камеры (нужны если добавить voice input)
            @Override
            public void onPermissionRequest(PermissionRequest request) {
                // Показываем диалог пользователю — он должен явно разрешить
                String[] resources = request.getResources();
                StringBuilder sb = new StringBuilder("Сайт запрашивает доступ к:\n");
                for (String r : resources) {
                    if (r.equals(PermissionRequest.RESOURCE_AUDIO_CAPTURE)) sb.append("• Микрофон\n");
                    if (r.equals(PermissionRequest.RESOURCE_VIDEO_CAPTURE)) sb.append("• Камера\n");
                    if (r.equals(PermissionRequest.RESOURCE_PROTECTED_MEDIA_ID)) sb.append("• Защищённые медиа\n");
                }
                new AlertDialog.Builder(MainActivity.this)
                        .setTitle("Запрос разрешения")
                        .setMessage(sb.toString())
                        .setPositiveButton("Разрешить", (d, w) -> request.grant(resources))
                        .setNegativeButton("Отклонить", (d, w) -> request.deny())
                        .setCancelable(false)
                        .show();
            }

            // Геолокация для Web AI (если включена)
            @Override
            public void onGeolocationPermissionsShowPrompt(String origin,
                    GeolocationPermissions.Callback callback) {
                new AlertDialog.Builder(MainActivity.this)
                        .setTitle("Геолокация")
                        .setMessage("Сайт " + origin + " хочет узнать ваше местоположение для Web AI.")
                        .setPositiveButton("Разрешить", (d, w) -> callback.invoke(origin, true, false))
                        .setNegativeButton("Отклонить", (d, w) -> callback.invoke(origin, false, false))
                        .setCancelable(false)
                        .show();
            }

            @Override
            public boolean onShowFileChooser(WebView webView,
                                             ValueCallback<Uri[]> filePathCallback,
                                             FileChooserParams fileChooserParams) {
                if (MainActivity.this.filePathCallback != null) {
                    MainActivity.this.filePathCallback.onReceiveValue(null);
                }
                MainActivity.this.filePathCallback = filePathCallback;
                Intent intent = fileChooserParams.createIntent();
                try {
                    startActivityForResult(intent, FILE_CHOOSER_REQUEST);
                } catch (Exception e) {
                    MainActivity.this.filePathCallback = null;
                    Toast.makeText(MainActivity.this, "Не удалось открыть выбор файла",
                            Toast.LENGTH_SHORT).show();
                    return false;
                }
                return true;
            }
        });

        // Загрузка файлов через DownloadManager
        webView.setDownloadListener((url, userAgent, contentDisposition, mimeType, contentLength) -> {
            try {
                DownloadManager.Request request = new DownloadManager.Request(Uri.parse(url));
                request.setMimeType(mimeType);
                request.addRequestHeader("User-Agent", userAgent);
                request.setTitle(URLUtil.guessFileName(url, contentDisposition, mimeType));
                request.setDescription("BrowserAI download");
                request.setNotificationVisibility(
                        DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED);
                request.setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS,
                        URLUtil.guessFileName(url, contentDisposition, mimeType));
                DownloadManager dm = (DownloadManager) getSystemService(DOWNLOAD_SERVICE);
                if (dm != null) {
                    dm.enqueue(request);
                    Toast.makeText(this, "Файл скачивается…", Toast.LENGTH_SHORT).show();
                }
            } catch (Exception e) {
                try {
                    Intent intent = new Intent(Intent.ACTION_VIEW, Uri.parse(url));
                    startActivity(intent);
                } catch (Exception ignored) { /* нет браузера */ }
            }
        });
    }

    // ── OTA обновления ───────────────────────────────────────────────────────

    // Проверяем наш Railway-сервер — быстрее GitHub, без rate-limit
    // GET {appUrl}/api/app-version -> { minNativeVersion, apkUrl, releaseNotes }
    private void checkForUpdates() {
        new Thread(() -> {
            HttpURLConnection conn = null;
            try {
                String apiUrl = appUrl.replaceAll("/+$", "") + APP_VERSION_API;
                URL url = new URL(apiUrl);
                conn = (HttpURLConnection) url.openConnection();
                conn.setConnectTimeout(8000);
                conn.setReadTimeout(8000);
                conn.setRequestProperty("User-Agent",
                        "BrowserAI-Android/" + getCurrentVersionCode());
                conn.setRequestProperty("Accept", "application/json");

                if (conn.getResponseCode() < 200 || conn.getResponseCode() >= 300) return;

                BufferedReader reader = new BufferedReader(
                        new InputStreamReader(conn.getInputStream()));
                StringBuilder body = new StringBuilder();
                String line;
                while ((line = reader.readLine()) != null) body.append(line);
                reader.close();

                JSONObject json       = new JSONObject(body.toString());
                long minNative        = json.optLong("minNativeVersion", 0);
                String apkUrl         = json.optString("apkUrl", "");
                String releaseUrl     = json.optString("releaseUrl",
                        "https://github.com/robesthud/browserAI/releases/latest");
                String releaseNotes   = json.optString("releaseNotes", "").trim();
                long currentCode      = getCurrentVersionCode();

                if (minNative > 0 && minNative > currentCode) {
                    final String fa = apkUrl, fu = releaseUrl, fn = releaseNotes;
                    final String tag = "v" + minNative + " (у вас: v" + currentCode + ")";
                    runOnUiThread(() -> showUpdateDialog(fa, fu, tag, fn));
                }
            } catch (Exception ignored) {
                // Тихо — OTA не должен мешать работе приложения
            } finally {
                if (conn != null) conn.disconnect();
            }
        }).start();
    }

    private long parseReleaseCode(String tag) {
        Matcher m = Pattern.compile("android-v(\\d+)").matcher(tag == null ? "" : tag);
        if (!m.find()) return 0;
        try { return Long.parseLong(m.group(1)); } catch (Exception e) { return 0; }
    }

    private long getCurrentVersionCode() {
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P)
                return getPackageManager().getPackageInfo(getPackageName(), 0).getLongVersionCode();
            return getPackageManager().getPackageInfo(getPackageName(), 0).versionCode;
        } catch (Exception e) { return 0; }
    }

    private String findApkAssetUrl(JSONObject releaseJson) {
        try {
            JSONArray assets = releaseJson.optJSONArray("assets");
            if (assets == null) return "";
            for (int i = 0; i < assets.length(); i++) {
                JSONObject asset = assets.optJSONObject(i);
                if (asset == null) continue;
                String name = asset.optString("name", "").toLowerCase();
                String url  = asset.optString("browser_download_url", "");
                if (name.endsWith(".apk") && !url.isEmpty()) return url;
            }
        } catch (Exception ignored) { }
        return "";
    }

    // FIX: ВСЕГДА показываем диалог с подтверждением перед скачиванием APK
    private void showUpdateDialog(String apkUrl, String releaseUrl, String tag, String notes) {
        String notesPart = (notes != null && !notes.isEmpty())
                ? "\n\nЧто нового:\n" + notes.substring(0, Math.min(notes.length(), 300))
                  + (notes.length() > 300 ? "…" : "")
                : "";

        new AlertDialog.Builder(this)
                .setTitle("Доступно обновление BrowserAI")
                .setMessage("Версия " + tag + " готова к установке." + notesPart
                        + "\n\nСкачать и установить?")
                .setPositiveButton("Обновить", (dialog, which) -> {
                    if (apkUrl != null && !apkUrl.isEmpty()) {
                        downloadAndInstallApk(apkUrl);
                    } else {
                        // Нет прямой ссылки — открываем страницу релиза в браузере
                        try {
                            startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(releaseUrl)));
                        } catch (Exception ignored) { }
                    }
                })
                .setNegativeButton("Позже", null)
                .setCancelable(true)
                .show();
    }

    private void downloadAndInstallApk(String apkUrl) {
        if (apkUrl == null || !apkUrl.startsWith("https://")) {
            Toast.makeText(this, "Небезопасный URL обновления — загрузка отменена",
                    Toast.LENGTH_LONG).show();
            return;
        }
        Toast.makeText(this, "Скачиваю обновление…", Toast.LENGTH_SHORT).show();

        new Thread(() -> {
            HttpsURLConnection connection = null;
            try {
                URL url = new URL(apkUrl);
                connection = (HttpsURLConnection) url.openConnection();
                connection.setConnectTimeout(15000);
                connection.setReadTimeout(30000);
                connection.setRequestProperty("User-Agent", "BrowserAI-Android");

                int code = connection.getResponseCode();
                if (code < 200 || code >= 300) throw new Exception("HTTP " + code);

                long contentLength = connection.getContentLengthLong();
                if (contentLength > MAX_APK_BYTES)
                    throw new Exception("APK слишком большой: " + contentLength + " байт");

                File dir = new File(getCacheDir(), "updates");
                if (!dir.exists() && !dir.mkdirs()) throw new Exception("Cannot create update cache");
                File apk = new File(dir, "BrowserAI-update.apk");

                try (InputStream input = connection.getInputStream();
                     FileOutputStream output = new FileOutputStream(apk)) {
                    byte[] buffer = new byte[8192];
                    int read;
                    long totalRead = 0;
                    while ((read = input.read(buffer)) != -1) {
                        totalRead += read;
                        if (totalRead > MAX_APK_BYTES)
                            throw new Exception("APK превысил допустимый размер при скачивании");
                        output.write(buffer, 0, read);
                    }
                    output.flush();
                }
                runOnUiThread(() -> installApk(apk));
            } catch (Exception error) {
                runOnUiThread(() -> Toast.makeText(this,
                        "Не удалось скачать обновление: " + error.getMessage(),
                        Toast.LENGTH_LONG).show());
            } finally {
                if (connection != null) connection.disconnect();
            }
        }).start();
    }

    private void installApk(File apk) {
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
                    && !getPackageManager().canRequestPackageInstalls()) {
                Toast.makeText(this,
                        "Разрешите установку из неизвестных источников, затем попробуйте снова",
                        Toast.LENGTH_LONG).show();
                startActivity(new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
                        Uri.parse("package:" + getPackageName())));
                return;
            }
            Uri apkUri = FileProvider.getUriForFile(
                    this, getPackageName() + ".fileprovider", apk);
            Intent intent = new Intent(Intent.ACTION_VIEW);
            intent.setDataAndType(apkUri, "application/vnd.android.package-archive");
            intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            startActivity(intent);
        } catch (Exception error) {
            Toast.makeText(this, "Не удалось открыть установщик: " + error.getMessage(),
                    Toast.LENGTH_LONG).show();
        }
    }

    // ── Вспомогательные методы ───────────────────────────────────────────────

    private void showError(String message) {
        offlineView.setText("BrowserAI\n\n" + message + "\n\nURL: " + appUrl);
        offlineView.setVisibility(View.VISIBLE);
        webView.setVisibility(View.GONE);
        progressBar.setVisibility(View.GONE);
    }

    private boolean isSameHost(String url) {
        try {
            Uri app    = Uri.parse(appUrl);
            Uri target = Uri.parse(url);
            return app.getHost() != null && app.getHost().equalsIgnoreCase(target.getHost());
        } catch (Exception e) { return false; }
    }

    private void loadApp() {
        if (appUrl == null || appUrl.contains("YOUR-RAILWAY-APP")) {
            showError("В android-app/app/src/main/res/values/strings.xml\nнужно заменить app_url на Railway URL.");
            return;
        }
        if (!isOnline()) {
            showError("Нет подключения к интернету.\n\nПроверьте WiFi или мобильный интернет.");
            return;
        }
        webView.loadUrl(appUrl);
    }

    private boolean isOnline() {
        ConnectivityManager cm = (ConnectivityManager) getSystemService(Context.CONNECTIVITY_SERVICE);
        if (cm == null) return true;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            NetworkCapabilities caps = cm.getNetworkCapabilities(cm.getActiveNetwork());
            return caps != null && caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET);
        }
        return true;
    }

    @Override
    public void onBackPressed() {
        if (webView != null && webView.canGoBack()) {
            webView.goBack();
        } else {
            super.onBackPressed();
        }
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode != FILE_CHOOSER_REQUEST || filePathCallback == null) return;

        Uri[] results = null;
        if (resultCode == RESULT_OK && data != null) {
            if (data.getClipData() != null) {
                int count = data.getClipData().getItemCount();
                results = new Uri[count];
                for (int i = 0; i < count; i++) {
                    results[i] = data.getClipData().getItemAt(i).getUri();
                }
            } else if (data.getData() != null) {
                results = new Uri[]{ data.getData() };
            }
        }
        filePathCallback.onReceiveValue(results);
        filePathCallback = null;
    }

    @Override
    protected void onPause() {
        super.onPause();
        // Сохраняем cookies при уходе из приложения
        CookieManager.getInstance().flush();
    }
}
