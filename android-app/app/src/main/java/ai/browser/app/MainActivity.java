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

import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.net.HttpURLConnection;
import java.net.URL;
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
        settings.setLoadWithOverviewMode(true);
        settings.setUseWideViewPort(true);
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
                long latestCode = parseReleaseCode(tag);
                long currentCode = getCurrentVersionCode();

                if (latestCode > currentCode) {
                    runOnUiThread(() -> showUpdateDialog(htmlUrl, tag));
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

    private void showUpdateDialog(String releaseUrl, String tag) {
        new AlertDialog.Builder(this)
                .setTitle("Доступно обновление BrowserAI")
                .setMessage("Найдена новая версия: " + tag + "\n\nОткройте страницу релиза, скачайте APK и установите его поверх текущей версии.")
                .setPositiveButton("Скачать", (dialog, which) -> {
                    Intent intent = new Intent(Intent.ACTION_VIEW, Uri.parse(releaseUrl));
                    startActivity(intent);
                })
                .setNegativeButton("Позже", null)
                .show();
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
