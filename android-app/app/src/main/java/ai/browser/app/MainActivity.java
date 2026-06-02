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
    private static final String LATEST_RELEASE_API = "https://api.github.com/repos/robesthud/browserAI/releases/latest";
    private WebView webView;
    private TextView offlineView;
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
                FrameLayout.LayoutParams.MATCH_PARENT
        ));

        offlineView = new TextView(this);
        offlineView.setText("BrowserAI\n\nНет подключения или приложение Railway ещё не доступно.\nПроверьте интернет и URL backend.");
        offlineView.setTextColor(0xFFE6E8EC);
        offlineView.setTextSize(16);
        offlineView.setGravity(android.view.Gravity.CENTER);
        offlineView.setPadding(40, 40, 40, 40);
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
        // Let the HTML viewport follow the real phone width. Wide viewport forces
        // desktop layout and makes the React UI look squeezed on Android.
        settings.setLoadWithOverviewMode(false);
        settings.setUseWideViewPort(false);
        settings.setMediaPlaybackRequiresUserGesture(false);
        settings.setAllowFileAccess(true);
        settings.setAllowContentAccess(true);
        settings.setCacheMode(WebSettings.LOAD_DEFAULT);
        settings.setJavaScriptCanOpenWindowsAutomatically(true);
        settings.setSupportMultipleWindows(true);
        settings.setTextZoom(100);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
            settings.setMixedContentMode(WebSettings.MIXED_CONTENT_COMPATIBILITY_MODE);
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            settings.setSafeBrowsingEnabled(true);
        }

        CookieManager cookieManager = CookieManager.getInstance();
        cookieManager.setAcceptCookie(true);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
            cookieManager.setAcceptThirdPartyCookies(webView, true);
        }

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.KITKAT) {
            WebView.setWebContentsDebuggingEnabled(true);
        }

        webView.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                Uri uri = request.getUrl();
                String url = uri.toString();

                if (isSameHost(url) || url.startsWith("about:")) {
                    return false;
                }

                Intent intent = new Intent(Intent.ACTION_VIEW, uri);
                startActivity(intent);
                return true;
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                offlineView.setVisibility(View.GONE);
                webView.setVisibility(View.VISIBLE);
                view.postDelayed(() -> view.evaluateJavascript(
                        "Boolean(document.getElementById('root') && document.getElementById('root').children.length)",
                        value -> {
                            if (!"true".equals(value)) {
                                showError("Интерфейс не запустился. Обновите Android System WebView/Chrome или нажмите назад и откройте снова.");
                            }
                        }
                ), 5000);
            }

            @Override
            public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
                super.onReceivedError(view, request, error);
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M && request.isForMainFrame()) {
                    showError("Ошибка загрузки: " + error.getDescription());
                }
            }

            @Override
            public void onReceivedHttpError(WebView view, WebResourceRequest request, WebResourceResponse errorResponse) {
                super.onReceivedHttpError(view, request, errorResponse);
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP && request.isForMainFrame()) {
                    showError("HTTP ошибка: " + errorResponse.getStatusCode());
                }
            }
        });

        webView.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onConsoleMessage(ConsoleMessage consoleMessage) {
                return super.onConsoleMessage(consoleMessage);
            }

            @Override
            public boolean onShowFileChooser(WebView webView, ValueCallback<Uri[]> filePathCallback, FileChooserParams fileChooserParams) {
                if (MainActivity.this.filePathCallback != null) {
                    MainActivity.this.filePathCallback.onReceiveValue(null);
                }
                MainActivity.this.filePathCallback = filePathCallback;

                Intent intent = fileChooserParams.createIntent();
                try {
                    startActivityForResult(intent, FILE_CHOOSER_REQUEST);
                } catch (Exception e) {
                    MainActivity.this.filePathCallback = null;
                    Toast.makeText(MainActivity.this, "Не удалось открыть выбор файла", Toast.LENGTH_SHORT).show();
                    return false;
                }
                return true;
            }
        });

        webView.setDownloadListener((url, userAgent, contentDisposition, mimeType, contentLength) -> {
            try {
                DownloadManager.Request request = new DownloadManager.Request(Uri.parse(url));
                request.setMimeType(mimeType);
                request.addRequestHeader("User-Agent", userAgent);
                request.setTitle(URLUtil.guessFileName(url, contentDisposition, mimeType));
                request.setDescription("BrowserAI download");
                request.setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED);
                request.setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS,
                        URLUtil.guessFileName(url, contentDisposition, mimeType));
                DownloadManager dm = (DownloadManager) getSystemService(DOWNLOAD_SERVICE);
                dm.enqueue(request);
                Toast.makeText(this, "Файл скачивается", Toast.LENGTH_SHORT).show();
            } catch (Exception e) {
                Intent intent = new Intent(Intent.ACTION_VIEW, Uri.parse(url));
                startActivity(intent);
            }
        });
    }

    private void checkForUpdates() {
        new Thread(() -> {
            HttpURLConnection connection = null;
            try {
                URL url = new URL(LATEST_RELEASE_API);
                connection = (HttpURLConnection) url.openConnection();
                connection.setConnectTimeout(5000);
                connection.setReadTimeout(5000);
                connection.setRequestProperty("Accept", "application/vnd.github+json");
                connection.setRequestProperty("User-Agent", "BrowserAI-Android");

                int code = connection.getResponseCode();
                if (code < 200 || code >= 300) return;

                BufferedReader reader = new BufferedReader(new InputStreamReader(connection.getInputStream()));
                StringBuilder body = new StringBuilder();
                String line;
                while ((line = reader.readLine()) != null) body.append(line);
                reader.close();

                JSONObject json = new JSONObject(body.toString());
                String tag = json.optString("tag_name", "");
                String htmlUrl = json.optString("html_url", "https://github.com/robesthud/browserAI/releases/latest");
                String apkUrl = findApkAssetUrl(json);
                long latestCode = parseReleaseCode(tag);
                long currentCode = getCurrentVersionCode();

                if (latestCode > currentCode) {
                    runOnUiThread(() -> showUpdateDialog(apkUrl, htmlUrl, tag));
                }
            } catch (Exception ignored) {
                // Silent by design: updates are optional and must not break app startup.
            } finally {
                if (connection != null) connection.disconnect();
            }
        }).start();
    }

    private long parseReleaseCode(String tag) {
        Matcher matcher = Pattern.compile("android-v(\\d+)").matcher(tag == null ? "" : tag);
        if (!matcher.find()) return 0;
        try {
            return Long.parseLong(matcher.group(1));
        } catch (Exception e) {
            return 0;
        }
    }

    private long getCurrentVersionCode() {
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
                return getPackageManager().getPackageInfo(getPackageName(), 0).getLongVersionCode();
            }
            return getPackageManager().getPackageInfo(getPackageName(), 0).versionCode;
        } catch (Exception e) {
            return 0;
        }
    }

    private String findApkAssetUrl(JSONObject releaseJson) {
        try {
            JSONArray assets = releaseJson.optJSONArray("assets");
            if (assets == null) return "";
            for (int i = 0; i < assets.length(); i++) {
                JSONObject asset = assets.optJSONObject(i);
                if (asset == null) continue;
                String name = asset.optString("name", "").toLowerCase();
                String url = asset.optString("browser_download_url", "");
                if (name.endsWith(".apk") && !url.isEmpty()) return url;
            }
        } catch (Exception ignored) {
            // fallback below
        }
        return "";
    }

    private void showUpdateDialog(String apkUrl, String releaseUrl, String tag) {
        // Авто-обновление: сразу скачиваем без диалога если APK URL доступен
        if (apkUrl != null && !apkUrl.isEmpty()) {
            downloadAndInstallApk(apkUrl);
            return;
        }
        // Fallback: если нет прямой ссылки на APK — открываем страницу релиза
        new AlertDialog.Builder(this)
                .setTitle("Доступно обновление BrowserAI")
                .setMessage("Версия " + tag + " доступна. Нажмите «Обновить» для перехода на страницу скачивания.")
                .setPositiveButton("Обновить", (dialog, which) -> {
                    Intent intent = new Intent(Intent.ACTION_VIEW, Uri.parse(releaseUrl));
                    startActivity(intent);
                })
                .setCancelable(false)
                .show();
    }

    // #15 FIX: загрузка APK только по HTTPS; добавлен лимит размера (100 МБ);
    // добавлена проверка что URL начинается с https:// перед открытием соединения
    private static final long MAX_APK_BYTES = 100L * 1024 * 1024; // 100 МБ

    private void downloadAndInstallApk(String apkUrl) {
        if (apkUrl == null || !apkUrl.startsWith("https://")) {
            Toast.makeText(this, "Небезопасный URL обновления — загрузка отменена", Toast.LENGTH_LONG).show();
            return;
        }
        Toast.makeText(this, "Скачиваю обновление…", Toast.LENGTH_SHORT).show();
        new Thread(() -> {
            HttpsURLConnection connection = null;
            try {
                URL url = new URL(apkUrl);
                // Используем HttpsURLConnection — гарантирует TLS-верификацию по умолчанию
                connection = (HttpsURLConnection) url.openConnection();
                connection.setConnectTimeout(15000);
                connection.setReadTimeout(30000);
                connection.setRequestProperty("User-Agent", "BrowserAI-Android");
                int code = connection.getResponseCode();
                if (code < 200 || code >= 300) throw new Exception("HTTP " + code);

                long contentLength = connection.getContentLengthLong();
                if (contentLength > MAX_APK_BYTES) {
                    throw new Exception("APK слишком большой: " + contentLength + " байт");
                }

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
                        if (totalRead > MAX_APK_BYTES) {
                            throw new Exception("APK превысил допустимый размер при скачивании");
                        }
                        output.write(buffer, 0, read);
                    }
                    output.flush();
                }

                runOnUiThread(() -> installApk(apk));
            } catch (Exception error) {
                runOnUiThread(() -> Toast.makeText(this,
                    "Не удалось скачать обновление: " + error.getMessage(), Toast.LENGTH_LONG).show());
            } finally {
                if (connection != null) connection.disconnect();
            }
        }).start();
    }

    private void installApk(File apk) {
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && !getPackageManager().canRequestPackageInstalls()) {
                Toast.makeText(this, "Разрешите установку из этого приложения, затем нажмите обновление ещё раз", Toast.LENGTH_LONG).show();
                Intent settingsIntent = new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
                        Uri.parse("package:" + getPackageName()));
                startActivity(settingsIntent);
                return;
            }

            Uri apkUri = FileProvider.getUriForFile(this, getPackageName() + ".fileprovider", apk);
            Intent intent = new Intent(Intent.ACTION_VIEW);
            intent.setDataAndType(apkUri, "application/vnd.android.package-archive");
            intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            startActivity(intent);
        } catch (Exception error) {
            Toast.makeText(this, "Не удалось открыть установщик: " + error.getMessage(), Toast.LENGTH_LONG).show();
        }
    }

    private void showError(String message) {
        offlineView.setText("BrowserAI\n\n" + message + "\n\nURL: " + appUrl);
        offlineView.setVisibility(View.VISIBLE);
        webView.setVisibility(View.GONE);
    }

    private boolean isSameHost(String url) {
        try {
            Uri app = Uri.parse(appUrl);
            Uri target = Uri.parse(url);
            return app.getHost() != null && app.getHost().equalsIgnoreCase(target.getHost());
        } catch (Exception e) {
            return false;
        }
    }

    private void loadApp() {
        if (appUrl.contains("YOUR-RAILWAY-APP")) {
            showError("В android-app/app/src/main/res/values/strings.xml нужно заменить app_url на Railway URL.");
            return;
        }

        if (!isOnline()) {
            showError("Нет подключения к интернету.");
            return;
        }

        webView.loadUrl(appUrl);
    }

    private boolean isOnline() {
        ConnectivityManager cm = (ConnectivityManager) getSystemService(Context.CONNECTIVITY_SERVICE);
        if (cm == null) return true;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            NetworkCapabilities capabilities = cm.getNetworkCapabilities(cm.getActiveNetwork());
            return capabilities != null && capabilities.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET);
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
                results = new Uri[]{data.getData()};
            }
        }

        filePathCallback.onReceiveValue(results);
        filePathCallback = null;
    }
}
