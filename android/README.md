# NotionLess Android companion app

Tiny native wrapper so users tap one icon and land straight in the web app —
no browser, no typing the site name. It is just a full-screen `WebView`
pointed at the live site, with all the storage bits the web app needs turned on.

## What it does

- Opens `https://notionless.pythonanywhere.com/` directly
- Keeps login alive via cookies (`CookieManager`, third-party cookies on, flush on pause)
- Enables `localStorage` (`domStorageEnabled`), `IndexedDB` (`databaseEnabled` + quota bump + DB path), cache (`LOAD_DEFAULT`)
- File uploads (`onShowFileChooser`), camera/mic permission grants, downloads via `DownloadManager`
- Back button goes back in page history; pull-to-refresh reloads
- App links for `notionless.pythonanywhere.com` open in the app; other links open in a Custom Tab
- Rotation-safe (`saveState`/`restoreState`), offline still boots from cache so the web app can show its own "Offline — editing locally" state

## Project layout

```
android/
├── settings.gradle
├── build.gradle
├── gradle.properties
├── gradle/wrapper/gradle-wrapper.properties
└── app/
    ├── build.gradle
    ├── proguard-rules.pro
    └── src/main/
        ├── AndroidManifest.xml
        ├── java/com/notionless/app/MainActivity.kt
        ├── java/com/notionless/app/NotionLessApp.kt
        └── res/{layout,values,drawable,mipmap-anydpi-v26}/
```

## Build

Quick way (no Gradle needed — the script fetches Gradle 8.7 itself):

```bash
cd android
./build_apk.sh           # build debug APK
./build_apk.sh --install # build + install to attached device + launch
./build_apk.sh --release --install  # release flavor
```

APK lands at `app/build/outputs/apk/debug/app-debug.apk` (5–6 MB).

Command line (needs JDK 17 + Android SDK 34):

```bash
cd android
# if you don't have gradle installed, use Android Studio once to generate gradlew,
# or: gradle wrapper --gradle-version 8.7
./gradlew assembleDebug
# APK lands at: app/build/outputs/apk/debug/app-debug.apk
adb install -r app/build/outputs/apk/debug/app-debug.apk
```

Release:

```bash
./gradlew assembleRelease
```

## Point it somewhere else (local dev)

In `MainActivity.kt`:

```kotlin
const val BASE_URL = "https://notionless.pythonanywhere.com/"
```

For the emulator talking to your dev server: `"http://10.0.2.2:5001/"`.
Plain-http + `10.0.2.2` stays inside the WebView by design; for a real
http device on LAN you would also need `usesCleartextTraffic="true"` —
left `false` on purpose so production stays https-only.

Package: `com.notionless.app` · minSdk 24 · target/compile 34.
