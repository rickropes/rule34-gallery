# Send to Gallery Android app

Edit `app/src/main/java/com/gallery/mobilequeue/QueueConfig.java`, then open this folder in Android Studio and select **Build > Build APK(s)**. The app appears in Android's share sheet for shared text/links, sends the first URL to the Apps Script queue, shows a short toast, and closes.


## Background share queue

Shared links are persisted with Android WorkManager. The share activity closes immediately after showing “Queued for Gallery”; uploads run one at a time when a network connection is available and retry temporary failures. Multiple Twitter/X shares can therefore be queued without blocking normal phone use.

## Android Studio dependency refresh

After replacing an older copy of this project, use **File > Sync Project with Gradle Files**.
If Android Studio still displays stale `androidx.work` import errors, use **Build > Clean Project** and rebuild while Gradle has internet access so it can download AndroidX WorkManager.
