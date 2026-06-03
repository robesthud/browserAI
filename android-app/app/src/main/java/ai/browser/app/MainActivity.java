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
import android.webkit.GeolocationPermissions;
import android.webkit.PermissionRequest;
import android.net.http.SslError;
import android.webkit.SslErrorHandler;
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
    private static final String LATEST_RELEASE_API =
            "https://api.github.com/repos/robesthud/browserAI/releases/latest";
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

        webView = new WebView(this);
        webView.setBackgroundColor(0xFF24262B);
        root.addView(webView, new FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT,
                FrameLayout.LayoutParams.MATCH_PARENT));

        // Progress bar — тонкая полоска сверху
        progressBar = new ProgressBar(this, null, android.R.attr.progressBarStyleHorizontal);
        progressBar.setMax(100);
        progressBar.setProgressTintList(
                android.content.res.ColorStateList.valueOf(0xFFE6E8EC));
        FrameLayout.LayoutParams pbp = new FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT, 6);
        pbp.gravity = android.view.Gravity.TOP;
        root.addView(progressBar, pbp);

        offlineView = new TextView(this);
        offlineView.setTextColor(0xFFE6E8EC);
        offlineView.setTextSize(16);
        offlineView.setGravity(android.view.Gravity.CENTER);
        offlineView.setPadding(48, 48, 48, 48);
        offlineView.setVisibility(View.GONE);
        root.addView(offlineView, new FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT,
                FrameLayout.LayoutParams.MATCH_PARENT));

        setContentView(root);
        configureWebView();
        loadApp();
        checkForUpdates();
    }

    @SuppressLint("SetJavaScriptEnabled")
    private void configureWebView() {
        WebSettings s = webView.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setLoadWithOverviewMode(false);
        s.setUseWideViewPort(false);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setAllowFileAccess(true);
        s.setAllowContentAccess(true);
        s.setCacheMode(WebSettings.LOAD_DEFAULT);
        s.setJavaScriptCanOpenWindowsAutomatically(true);
        s.setSupportMultipleWindows(true);
        s.setTextZoom(100);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP)
            s.setMixedContentMode(WebSettings.MIXED_CONTENT_COMPATIBILITY_MODE);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O)
            s.setSafeBrowsingEnabled(true);

        CookieManager cm = CookieManager.getInstance();
        cm.setAcceptCookie(true);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP)
            cm.setAcceptThirdPartyCookies(webView, true);

        // Отладка ТОЛЬКО в debug-сборке
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.KITKAT)
            WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG);

        webView.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                String url = request.getUrl().toString();
                if (isSameHost(url) || url.startsWith("about:")) return false;
                try { startActivity(new Intent(Intent.ACTION_VIEW, request.getUrl())); }
                catch (Exception ignored) {}
                return true;
            }

            @Override
            public void onPageStarted(WebView view, String url, android.graphics.Bitmap favicon) {
                progressBar.setVisibility(View.VISIBLE);
                progressBar.setProgress(10);
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                progressBar.setProgress(100);
                progressBar.setVisibility(View.GONE);
                offlineView.setVisibility(View.GONE);
                webView.setVisibility(View.VISIBLE);
                view.postDelayed(() -> view.evaluateJavascript(
                        "Boolean(document.getElementById('root')&&document.getElementById('root').children.length)",
                        value -> {
                            if (!"true".equals(value))
                                showError("Интерфейс не запустился.\n\nОбновите Android System WebView в Google Play или перезапустите приложение.");
                        }), 5000);
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
                    if (code >= 500)
                        showError("Сервер временно недоступен (HTTP " + code + ").\n\nПодождите немного.");
                }
            }

            @Override
            public void onReceivedSslError(WebView view, SslErrorHandler handler, SslError error) {
                progressBar.setVisibility(View.GONE);
                String reason;
                // SslError константы: NOT_YET_VALID=0, EXPIRED=1, IDMISMATCH=2, UNTRUSTED=3
                int sslCode = error.getPrimaryError();
                if (sslCode == 1)      reason = "Сертификат истёк";
                else if (sslCode == 3) reason = "Сертификат не доверенный";
                else if (sslCode == 2) reason = "Домен не совпадает";
                else if (sslCode == 0) reason = "Сертификат ещё не действует";
                else                   reason = "SSL-ошибка " + sslCode;
                new AlertDialog.Builder(MainActivity.this)
                        .setTitle("Ошибка SSL")
                        .setMessage(reason + "\n\nПродолжить небезопасно. Что делаем?")
                        .setPositiveButton("Продолжить", (d, w) -> handler.proceed())
                        .setNegativeButton("Отмена", (d, w) -> {
                            handler.cancel();
                            showError("Загрузка отменена: " + reason);
                        })
                        .setCancelable(false)
                        .show();
            }
        });

        webView.setWebChromeClient(new WebChromeClient() {
            @Override
            public void onProgressChanged(WebView view, int newProgress) {
                if (progressBar == null) return;
                progressBar.setProgress(newProgress);
                progressBar.setVisibility(newProgress == 100 ? View.GONE : View.VISIBLE);
            }

            @Override
            public boolean onConsoleMessage(ConsoleMessage msg) {
                return super.onConsoleMessage(msg);
            }

            // target="_blank" → открываем в браузере
            @Override
            public boolean onCreateWindow(WebView view, boolean isDialog,
                                          boolean isUserGesture, android.os.Message resultMsg) {
                WebView.HitTestResult r = view.getHitTestResult();
                String url = r != null ? r.getExtra() : null;
                if (url != null && !url.isEmpty()) {
                    try { startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(url))); }
                    catch (Exception ignored) {}
                    return false;
                }
                // Fallback: транспортный WebView для перехвата URL
                WebView transport = new WebView(MainActivity.this);
                transport.setWebViewClient(new WebViewClient() {
                    @Override
                    public boolean shouldOverrideUrlLoading(WebView v, WebResourceRequest req) {
                        try { startActivity(new Intent(Intent.ACTION_VIEW, req.getUrl())); }
                        catch (Exception ignored) {}
                        return true;
                    }
                });
                WebView.WebViewTransport wvt = (WebView.WebViewTransport) resultMsg.obj;
                wvt.setWebView(transport);
                resultMsg.sendToTarget();
                return true;
            }

            // Микрофон / камера — диалог разрешения
            @Override
            public void onPermissionRequest(PermissionRequest request) {
                if (Build.VERSION.SDK_INT < Build.VERSION_CODES.LOLLIPOP) {
                    request.deny(); return;
                }
                String[] resources = request.getResources();
                StringBuilder sb = new StringBuilder("Сайт запрашивает:\n");
                for (String res : resources) {
                    if (res.equals(PermissionRequest.RESOURCE_AUDIO_CAPTURE)) sb.append("• Микрофон\n");
                    if (res.equals(PermissionRequest.RESOURCE_VIDEO_CAPTURE)) sb.append("• Камера\n");
                }
                new AlertDialog.Builder(MainActivity.this)
                        .setTitle("Запрос разрешения")
                        .setMessage(sb.toString())
                        .setPositiveButton("Разрешить", (d, w) -> {
                            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP)
                                request.grant(resources);
                        })
                        .setNegativeButton("Отклонить", (d, w) -> {
                            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP)
                                request.deny();
                        })
                        .setCancelable(false).show();
            }

            // Геолокация
            @Override
            public void onGeolocationPermissionsShowPrompt(String origin,
                    GeolocationPermissions.Callback callback) {
                new AlertDialog.Builder(MainActivity.this)
                        .setTitle("Геолокация")
                        .setMessage("Разрешить определение местоположения для Web AI?")
                        .setPositiveButton("Да", (d, w) -> callback.invoke(origin, true, false))
                        .setNegativeButton("Нет", (d, w) -> callback.invoke(origin, false, false))
                        .setCancelable(false).show();
            }

            // Выбор файла
            @Override
            public boolean onShowFileChooser(WebView wv,
                                             ValueCallback<Uri[]> filePathCallback,
                                             FileChooserParams fileChooserParams) {
                if (MainActivity.this.filePathCallback != null)
                    MainActivity.this.filePathCallback.onReceiveValue(null);
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

        webView.setDownloadListener((url, userAgent, contentDisposition, mimeType, contentLength) -> {
            try {
                DownloadManager.Request req = new DownloadManager.Request(Uri.parse(url));
                req.setMimeType(mimeType);
                req.addRequestHeader("User-Agent", userAgent);
                req.setTitle(URLUtil.guessFileName(url, contentDisposition, mimeType));
                req.setDescription("BrowserAI download");
                req.setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED);
                req.setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS,
                        URLUtil.guessFileName(url, contentDisposition, mimeType));
                DownloadManager dm = (DownloadManager) getSystemService(DOWNLOAD_SERVICE);
                if (dm != null) {
                    dm.enqueue(req);
                    Toast.makeText(this, "Файл скачивается…", Toast.LENGTH_SHORT).show();
                }
            } catch (Exception e) {
                try { startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(url))); }
                catch (Exception ignored) {}
            }
        });
    }

    // ── OTA обновления ──────────────────────────────────────────────────────

    private void checkForUpdates() {
        new Thread(() -> {
            HttpURLConnection conn = null;
            try {
                URL url = new URL(LATEST_RELEASE_API);
                conn = (HttpURLConnection) url.openConnection();
                conn.setConnectTimeout(6000);
                conn.setReadTimeout(6000);
                conn.setRequestProperty("Accept", "application/vnd.github+json");
                conn.setRequestProperty("User-Agent", "BrowserAI-Android");
                if (conn.getResponseCode() < 200 || conn.getResponseCode() >= 300) return;
                BufferedReader reader = new BufferedReader(new InputStreamReader(conn.getInputStream()));
                StringBuilder body = new StringBuilder();
                String line;
                while ((line = reader.readLine()) != null) body.append(line);
                reader.close();
                JSONObject json     = new JSONObject(body.toString());
                String tag          = json.optString("tag_name", "");
                String releaseUrl   = json.optString("html_url", "https://github.com/robesthud/browserAI/releases/latest");
                String apkUrl       = findApkAssetUrl(json);
                String notes        = json.optString("body", "").trim();
                long latestCode     = parseReleaseCode(tag);
                long currentCode    = getCurrentVersionCode();
                if (latestCode > currentCode) {
                    final String ft = tag, fa = apkUrl, fu = releaseUrl, fn = notes;
                    runOnUiThread(() -> showUpdateDialog(fa, fu, ft, fn));
                }
            } catch (Exception ignored) {
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

    private String findApkAssetUrl(JSONObject json) {
        try {
            JSONArray assets = json.optJSONArray("assets");
            if (assets == null) return "";
            for (int i = 0; i < assets.length(); i++) {
                JSONObject a = assets.optJSONObject(i);
                if (a == null) continue;
                String name = a.optString("name", "").toLowerCase();
                String url  = a.optString("browser_download_url", "");
                if (name.endsWith(".apk") && !url.isEmpty()) return url;
            }
        } catch (Exception ignored) {}
        return "";
    }

    private void showUpdateDialog(String apkUrl, String releaseUrl, String tag, String notes) {
        String notesPart = (notes != null && !notes.isEmpty())
                ? "\n\nЧто нового:\n" + notes.substring(0, Math.min(notes.length(), 300))
                  + (notes.length() > 300 ? "…" : "") : "";
        new AlertDialog.Builder(this)
                .setTitle("Обновление BrowserAI")
                .setMessage("Версия " + tag + " готова." + notesPart + "\n\nУстановить?")
                .setPositiveButton("Обновить", (d, w) -> {
                    if (apkUrl != null && !apkUrl.isEmpty()) downloadAndInstallApk(apkUrl);
                    else { try { startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(releaseUrl))); } catch (Exception ignored) {} }
                })
                .setNegativeButton("Позже", null)
                .setCancelable(true).show();
    }

    private void downloadAndInstallApk(String apkUrl) {
        if (apkUrl == null || !apkUrl.startsWith("https://")) {
            Toast.makeText(this, "Небезопасный URL обновления", Toast.LENGTH_LONG).show(); return;
        }
        Toast.makeText(this, "Скачиваю обновление…", Toast.LENGTH_SHORT).show();
        new Thread(() -> {
            HttpsURLConnection conn = null;
            try {
                URL url = new URL(apkUrl);
                conn = (HttpsURLConnection) url.openConnection();
                conn.setConnectTimeout(15000);
                conn.setReadTimeout(30000);
                conn.setRequestProperty("User-Agent", "BrowserAI-Android");
                if (conn.getResponseCode() < 200 || conn.getResponseCode() >= 300)
                    throw new Exception("HTTP " + conn.getResponseCode());
                if (conn.getContentLengthLong() > MAX_APK_BYTES)
                    throw new Exception("APK слишком большой");
                File dir = new File(getCacheDir(), "updates");
                if (!dir.exists() && !dir.mkdirs()) throw new Exception("Cannot create dir");
                File apk = new File(dir, "BrowserAI-update.apk");
                try (InputStream in = conn.getInputStream();
                     FileOutputStream out = new FileOutputStream(apk)) {
                    byte[] buf = new byte[8192]; int n; long total = 0;
                    while ((n = in.read(buf)) != -1) {
                        total += n;
                        if (total > MAX_APK_BYTES) throw new Exception("Превышен лимит размера");
                        out.write(buf, 0, n);
                    }
                    out.flush();
                }
                runOnUiThread(() -> installApk(apk));
            } catch (Exception e) {
                runOnUiThread(() -> Toast.makeText(this,
                        "Ошибка загрузки: " + e.getMessage(), Toast.LENGTH_LONG).show());
            } finally {
                if (conn != null) conn.disconnect();
            }
        }).start();
    }

    private void installApk(File apk) {
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
                    && !getPackageManager().canRequestPackageInstalls()) {
                Toast.makeText(this, "Разрешите установку из неизвестных источников",
                        Toast.LENGTH_LONG).show();
                startActivity(new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
                        Uri.parse("package:" + getPackageName())));
                return;
            }
            Uri uri = FileProvider.getUriForFile(this, getPackageName() + ".fileprovider", apk);
            Intent intent = new Intent(Intent.ACTION_VIEW);
            intent.setDataAndType(uri, "application/vnd.android.package-archive");
            intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_ACTIVITY_NEW_TASK);
            startActivity(intent);
        } catch (Exception e) {
            Toast.makeText(this, "Ошибка установщика: " + e.getMessage(), Toast.LENGTH_LONG).show();
        }
    }

    // ── Вспомогательные ─────────────────────────────────────────────────────

    private void showError(String message) {
        if (progressBar != null) progressBar.setVisibility(View.GONE);
        offlineView.setText("BrowserAI\n\n" + message + "\n\nURL: " + appUrl);
        offlineView.setVisibility(View.VISIBLE);
        if (webView != null) webView.setVisibility(View.GONE);
    }

    private boolean isSameHost(String url) {
        try {
            Uri app = Uri.parse(appUrl), target = Uri.parse(url);
            return app.getHost() != null && app.getHost().equalsIgnoreCase(target.getHost());
        } catch (Exception e) { return false; }
    }

    private void loadApp() {
        if (appUrl == null || appUrl.contains("YOUR-RAILWAY-APP")) {
            showError("Замените app_url на Railway URL в strings.xml"); return;
        }
        if (!isOnline()) { showError("Нет интернета.\n\nПроверьте WiFi или мобильный интернет."); return; }
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
        if (webView != null && webView.canGoBack()) webView.goBack();
        else super.onBackPressed();
    }

    @Override
    protected void onPause() {
        super.onPause();
        CookieManager.getInstance().flush();
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
                for (int i = 0; i < count; i++) results[i] = data.getClipData().getItemAt(i).getUri();
            } else if (data.getData() != null) {
                results = new Uri[]{ data.getData() };
            }
        }
        filePathCallback.onReceiveValue(results);
        filePathCallback = null;
    }
}
