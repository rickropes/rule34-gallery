# Send to Gallery Android app

Edit `app/src/main/java/com/gallery/mobilequeue/QueueConfig.java`, then open this folder in Android Studio and select **Build > Build APK(s)**. The app appears in Android's share sheet for shared text/links, saves the first URL locally, schedules delivery to the Apps Script queue, shows a short toast, and closes.

## Durable background share queue

Shared links are first written to an on-device `SharedPreferences` queue. WorkManager then uploads pending links when a network connection is available. A link is removed from the device only after the Apps Script response explicitly contains `{"ok":true}`.

Network errors, timeouts, HTTP errors, malformed responses, and Apps Script application errors such as `{"error":"Unauthorized"}` keep the link locally and return `Result.retry()`, so WorkManager retries with backoff across normal app/process restarts. If a response is lost after the server wrote the URL, a retry is harmless because the Apps Script deduplicates identical URLs.

The share toast says the link was **saved to the Gallery queue**, not that the remote upload already succeeded. When more than one unique URL is pending locally, the toast includes the pending count.

## Queue service configuration

`QueueConfig.ENDPOINT` must point to the deployed Apps Script web app and `QueueConfig.TOKEN` must exactly match `PRIVATE_TOKEN` in `google-apps-script/Code.gs` and the token configured in the desktop app.

## Android Studio dependency refresh

After replacing an older copy of this project, use **File > Sync Project with Gradle Files**.
If Android Studio still displays stale `androidx.work` import errors, use **Build > Clean Project** and rebuild while Gradle has internet access so it can download AndroidX WorkManager.
