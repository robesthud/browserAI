# BrowserAI Android

Android-обёртка для BrowserAI (production-сервер). Это WebView-приложение, поэтому интерфейс, стиль и функции остаются такими же, как в web-версии:

- чаты;
- настройки API-ключей;
- Vault/шифрование;
- Workspace;
- загрузка файлов;
- скачивание файлов;
- web search через backend.

## Настройка URL

Откройте файл:

```text
app/src/main/res/values/strings.xml
```

И замените:

```xml
<string name="app_url">https://YOUR-SERVER.example</string>
```

на ваш production URL, например:

```xml
<string name="app_url">http://72.56.116.15</string>
```

## Сборка APK

Откройте папку `android-app` в Android Studio и нажмите:

```text
Build > Build Bundle(s) / APK(s) > Build APK(s)
```

Или из консоли при установленном Android SDK/Gradle:

```bash
gradle assembleDebug
```

APK будет в:

```text
app/build/outputs/apk/debug/app-debug.apk
```

## Важно

Backend должен быть задеплоен на сервере и доступен по HTTPS. Локальный Node/SQLite внутри APK не запускается — это сделано специально, чтобы сохранить все текущие функции без переписывания backend под Android.
