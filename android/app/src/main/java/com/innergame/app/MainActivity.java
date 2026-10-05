package com.innergame.app;

import android.Manifest;
import android.annotation.SuppressLint;
import android.app.Activity;
import android.app.AlertDialog;
import android.app.Notification;
import android.app.PendingIntent;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.content.Context;
import android.content.ContentUris;
import android.database.ContentObserver;
import android.database.Cursor;
import android.content.Intent;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Handler;
import android.os.Looper;
import android.os.Build;
import android.os.Bundle;
import android.provider.MediaStore;
import android.provider.Settings;
import android.util.Base64;
import android.webkit.JavascriptInterface;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.widget.Toast;

import androidx.webkit.WebViewAssetLoader;
import androidx.webkit.WebViewClientCompat;
import androidx.work.Data;
import androidx.work.OneTimeWorkRequest;
import androidx.work.WorkManager;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.Arrays;
import java.util.Comparator;
import java.util.UUID;
import java.util.concurrent.TimeUnit;

import org.json.JSONObject;

public final class MainActivity extends Activity {
    private static final int NOTIFICATION_PERMISSION_REQUEST = 42;
    private static final int MEDIA_PERMISSION_REQUEST = 43;
    private static final int MAX_BREAK_REMINDERS = 24;
    private static final String HAND_CHANNEL_ID = "hand_capture_fast_v2";
    private static final String HAND_ANALYSIS_URL = "https://inner-game-production.up.railway.app/analyze-hand";
    private static final String PENDING_HAND_PREFIX = "pending_hand_";
    private WebView webView;
    private String pendingScreenshotDataUrl;
    private String pendingHandId;
    private String pendingHandNotificationPayload;
    private boolean autoScreenshotEnabled = true;
    private boolean capturePermissionPromptedThisLaunch = false;
    private boolean notificationPermissionPromptedThisLaunch = false;
    private ContentObserver screenshotObserver;
    private String lastScreenshotUri = "";
    private long lastScreenshotMediaId = -1L;
    private long lastScreenshotHandledAt = 0L;

    @SuppressLint({"SetJavaScriptEnabled", "JavascriptInterface"})
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        webView = new WebView(this);
        setContentView(webView);

        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setDatabaseEnabled(true);
        settings.setAllowContentAccess(false);
        settings.setAllowFileAccess(true);
        settings.setAllowFileAccessFromFileURLs(false);
        settings.setAllowUniversalAccessFromFileURLs(false);
        settings.setSupportZoom(false);
        settings.setBuiltInZoomControls(false);
        settings.setDisplayZoomControls(false);

        createNotificationChannel();
        createHandNotificationChannel();
        webView.addJavascriptInterface(new NativeBridge(), "InnerGameNative");
        WebViewAssetLoader assetLoader = new WebViewAssetLoader.Builder()
                .addPathHandler("/assets/", new WebViewAssetLoader.AssetsPathHandler(this))
                .build();

        webView.setWebViewClient(new WebViewClientCompat() {
            @Override
            public android.webkit.WebResourceResponse shouldInterceptRequest(
                    WebView view,
                    android.webkit.WebResourceRequest request
            ) {
                return assetLoader.shouldInterceptRequest(request.getUrl());
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                super.onPageFinished(view, url);
                dispatchPendingScreenshot();
                dispatchPendingHandOpen();
                dispatchPendingNativeAnalyses();
            }
        });
        handleIncomingIntent(getIntent());
        webView.loadUrl("https://appassets.androidplatform.net/assets/www/index.html");
    }

    private void handleIncomingIntent(Intent intent) {
        if (intent == null) return;
        String handId = intent.getStringExtra("handId");
        if (handId != null && !handId.isEmpty()) {
            pendingHandId = handId;
            dispatchPendingHandOpen();
        }
        if (!Intent.ACTION_SEND.equals(intent.getAction())) return;
        String type = intent.getType();
        if (type == null || !type.startsWith("image/")) return;

        Uri uri;
        if (Build.VERSION.SDK_INT >= 33) {
            uri = intent.getParcelableExtra(Intent.EXTRA_STREAM, Uri.class);
        } else {
            //noinspection deprecation
            uri = intent.getParcelableExtra(Intent.EXTRA_STREAM);
        }
        if (uri == null) return;

        try (InputStream input = getContentResolver().openInputStream(uri);
             ByteArrayOutputStream output = new ByteArrayOutputStream()) {
            if (input == null) return;
            byte[] buffer = new byte[8192];
            int read;
            int total = 0;
            while ((read = input.read(buffer)) != -1) {
                total += read;
                if (total > 14_000_000) throw new IllegalArgumentException("Screenshot too large");
                output.write(buffer, 0, read);
            }
            String mime = getContentResolver().getType(uri);
            if (mime == null || !mime.startsWith("image/")) mime = "image/png";
            pendingScreenshotDataUrl = "data:" + mime + ";base64," +
                    Base64.encodeToString(output.toByteArray(), Base64.NO_WRAP);
            dispatchPendingScreenshot();
        } catch (Exception error) {
            Toast.makeText(this, "Could not import screenshot", Toast.LENGTH_SHORT).show();
        }
    }

    private void dispatchPendingScreenshot() {
        if (pendingScreenshotDataUrl == null) return;
        final String dataUrl = pendingScreenshotDataUrl;
        dispatchScreenshotData(dataUrl, "android_share", () -> pendingScreenshotDataUrl = null);
    }

    private void dispatchPendingHandOpen() {
        if (webView == null || pendingHandId == null || pendingHandId.isEmpty()) return;
        final String handId = pendingHandId;
        webView.post(() -> webView.evaluateJavascript(
                "(function(){if(window.innerGameOpenHand){return window.innerGameOpenHand(" +
                        JSONObject.quote(handId) + ");}return false;})()",
                result -> {
                    if ("true".equals(result)) pendingHandId = null;
                }
        ));
    }

    private void dispatchScreenshotData(String dataUrl, String source, Runnable onAccepted) {
        if (webView == null || dataUrl == null) return;
        webView.post(() -> webView.evaluateJavascript(
                "(function(){if(window.innerGameReceiveScreenshot){window.innerGameReceiveScreenshot(" +
                        JSONObject.quote(dataUrl) + "," + JSONObject.quote(source) + ");return true;}return false;})()",
                result -> {
                    if ("true".equals(result) && onAccepted != null) onAccepted.run();
                }
        ));
    }

    private boolean hasMediaReadPermission() {
        if (Build.VERSION.SDK_INT >= 33) {
            return checkSelfPermission(Manifest.permission.READ_MEDIA_IMAGES) == PackageManager.PERMISSION_GRANTED;
        }
        return checkSelfPermission(Manifest.permission.READ_EXTERNAL_STORAGE) == PackageManager.PERMISSION_GRANTED;
    }

    private boolean hasLimitedMediaAccess() {
        return Build.VERSION.SDK_INT >= 34
                && checkSelfPermission(Manifest.permission.READ_MEDIA_VISUAL_USER_SELECTED) == PackageManager.PERMISSION_GRANTED
                && !hasMediaReadPermission();
    }

    private boolean hasNotificationPermission() {
        return Build.VERSION.SDK_INT < 33
                || checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED;
    }

    private void requestMediaPermissionIfNeeded() {
        if (hasMediaReadPermission()) {
            registerScreenshotObserver();
            requestNotificationPermissionIfNeeded();
            return;
        }
        if (Build.VERSION.SDK_INT >= 34) {
            requestPermissions(
                    new String[]{
                            Manifest.permission.READ_MEDIA_IMAGES,
                            Manifest.permission.READ_MEDIA_VISUAL_USER_SELECTED
                    },
                    MEDIA_PERMISSION_REQUEST
            );
        } else if (Build.VERSION.SDK_INT >= 33) {
            requestPermissions(new String[]{Manifest.permission.READ_MEDIA_IMAGES}, MEDIA_PERMISSION_REQUEST);
        } else {
            requestPermissions(new String[]{Manifest.permission.READ_EXTERNAL_STORAGE}, MEDIA_PERMISSION_REQUEST);
        }
    }

    private void ensureCapturePermissionsOnOpen() {
        if (!autoScreenshotEnabled) return;
        if (hasMediaReadPermission()) {
            registerScreenshotObserver();
            requestNotificationPermissionIfNeeded();
            flushPendingHandNotification();
            return;
        }
        if (capturePermissionPromptedThisLaunch) return;
        capturePermissionPromptedThisLaunch = true;
        requestMediaPermissionIfNeeded();
    }

    private void openAppSettings() {
        Intent intent = new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS);
        intent.setData(Uri.fromParts("package", getPackageName(), null));
        startActivity(intent);
    }

    private void showMediaPermissionHelp() {
        final boolean partial = hasLimitedMediaAccess();
        final boolean canAskAgain = !partial
                && Build.VERSION.SDK_INT >= 23
                && shouldShowRequestPermissionRationale(
                        Build.VERSION.SDK_INT >= 33
                                ? Manifest.permission.READ_MEDIA_IMAGES
                                : Manifest.permission.READ_EXTERNAL_STORAGE
                );

        String message = partial
                ? "Inner Game only has access to selected photos. Automatic poker screenshot detection needs access to all photos so it can see new screenshots."
                : "Inner Game needs Photos and videos access to detect new poker screenshots automatically. Without it, screenshots cannot be captured into Hands.";

        new AlertDialog.Builder(this)
                .setTitle("Enable screenshot detection")
                .setMessage(message)
                .setNegativeButton("Not now", null)
                .setPositiveButton(canAskAgain ? "Allow access" : "Open settings", (dialog, which) -> {
                    if (canAskAgain) {
                        requestMediaPermissionIfNeeded();
                    } else {
                        openAppSettings();
                    }
                })
                .show();
    }

    private void showNotificationPermissionHelp() {
        new AlertDialog.Builder(this)
                .setTitle("Enable hand notifications")
                .setMessage("Allow notifications so Inner Game can tell you when a screenshot is being analyzed and when the hand is saved.")
                .setNegativeButton("Not now", null)
                .setPositiveButton("Open settings", (dialog, which) -> openAppSettings())
                .show();
    }

    private void setAutoScreenshotEnabled(boolean enabled) {
        autoScreenshotEnabled = enabled;
        if (!enabled) {
            unregisterScreenshotObserver();
            return;
        }
        ensureCapturePermissionsOnOpen();
    }

    private void registerScreenshotObserver() {
        if (!autoScreenshotEnabled || screenshotObserver != null || !hasMediaReadPermission()) return;
        screenshotObserver = new ContentObserver(new Handler(Looper.getMainLooper())) {
            @Override
            public void onChange(boolean selfChange, Uri uri) {
                super.onChange(selfChange, uri);
                if (!autoScreenshotEnabled || uri == null) return;
                inspectScreenshotUri(uri);
            }
        };
        getContentResolver().registerContentObserver(
                MediaStore.Images.Media.EXTERNAL_CONTENT_URI,
                true,
                screenshotObserver
        );
    }

    private void unregisterScreenshotObserver() {
        if (screenshotObserver == null) return;
        try { getContentResolver().unregisterContentObserver(screenshotObserver); } catch (Exception ignored) {}
        screenshotObserver = null;
    }

    private boolean looksLikeScreenshot(String name, String relativePath) {
        String hay = ((name == null ? "" : name) + " " + (relativePath == null ? "" : relativePath)).toLowerCase();
        return hay.contains("screenshot") || hay.contains("screen shot") || hay.contains("screen_shot")
                || hay.contains("screenshots") || hay.contains("screencapture");
    }

    private Uri resolveRecentScreenshotUri(Uri changedUri) {
        String[] projection = Build.VERSION.SDK_INT >= 29
                ? new String[]{
                        MediaStore.Images.Media._ID,
                        MediaStore.Images.Media.DISPLAY_NAME,
                        MediaStore.Images.Media.RELATIVE_PATH,
                        MediaStore.Images.Media.DATE_ADDED
                }
                : new String[]{
                        MediaStore.Images.Media._ID,
                        MediaStore.Images.Media.DISPLAY_NAME,
                        MediaStore.Images.Media.DATE_ADDED
                };

        try (Cursor cursor = getContentResolver().query(
                changedUri,
                projection,
                null,
                null,
                MediaStore.Images.Media.DATE_ADDED + " DESC"
        )) {
            if (cursor == null) return null;
            int scanned = 0;
            while (cursor.moveToNext() && scanned++ < 6) {
                long id = cursor.getLong(0);
                String name = cursor.getString(1);
                String relativePath = Build.VERSION.SDK_INT >= 29 ? cursor.getString(2) : "";
                long dateAddedSeconds = cursor.getLong(Build.VERSION.SDK_INT >= 29 ? 3 : 2);
                if (!looksLikeScreenshot(name, relativePath)) continue;
                if (dateAddedSeconds > 0 && Math.abs((System.currentTimeMillis() / 1000L) - dateAddedSeconds) > 30L) continue;
                return ContentUris.withAppendedId(MediaStore.Images.Media.EXTERNAL_CONTENT_URI, id);
            }
        } catch (Exception ignored) {}

        // Some devices notify the collection URI rather than the new item URI.
        // Fall back to the newest recent image and apply the same screenshot checks.
        try (Cursor cursor = getContentResolver().query(
                MediaStore.Images.Media.EXTERNAL_CONTENT_URI,
                projection,
                MediaStore.Images.Media.DATE_ADDED + ">=?",
                new String[]{String.valueOf((System.currentTimeMillis() / 1000L) - 30L)},
                MediaStore.Images.Media.DATE_ADDED + " DESC"
        )) {
            if (cursor == null) return null;
            int scanned = 0;
            while (cursor.moveToNext() && scanned++ < 8) {
                long id = cursor.getLong(0);
                String name = cursor.getString(1);
                String relativePath = Build.VERSION.SDK_INT >= 29 ? cursor.getString(2) : "";
                if (looksLikeScreenshot(name, relativePath)) {
                    return ContentUris.withAppendedId(MediaStore.Images.Media.EXTERNAL_CONTENT_URI, id);
                }
            }
        } catch (Exception ignored) {}
        return null;
    }

    private long mediaId(Uri uri) {
        try { return ContentUris.parseId(uri); } catch (Exception ignored) { return -1L; }
    }

    private boolean mediaItemReady(Uri uri) {
        if (Build.VERSION.SDK_INT < 29) return true;
        String[] projection = new String[]{MediaStore.Images.Media.IS_PENDING, MediaStore.Images.Media.SIZE};
        try (Cursor cursor = getContentResolver().query(uri, projection, null, null, null)) {
            if (cursor == null || !cursor.moveToFirst()) return false;
            int pending = cursor.getInt(0);
            long size = cursor.getLong(1);
            return pending == 0 && size > 4096L;
        } catch (Exception ignored) {
            return false;
        }
    }

    private void notifyAutoCaptureDetected() {
        try {
            JSONObject payload = new JSONObject();
            payload.put("stage", "analyzing");
            payload.put("title", "Poker hand detected");
            payload.put("body", "Screenshot captured. Analyzing the hand…");
            payload.put("handId", "");
            showHandNotification(payload.toString());
        } catch (Exception ignored) {}
    }

    private void notifyAutoCaptureReadFailed() {
        try {
            JSONObject payload = new JSONObject();
            payload.put("stage", "failed");
            payload.put("title", "Screenshot capture failed");
            payload.put("body", "Inner Game detected the screenshot but could not read it. Try another screenshot or Share → Inner Game.");
            payload.put("handId", "");
            showHandNotification(payload.toString());
        } catch (Exception ignored) {}
    }

    private void inspectScreenshotUri(Uri changedUri) {
        final Uri screenshotUri = resolveRecentScreenshotUri(changedUri);
        if (screenshotUri == null) return;

        final long mediaId = mediaId(screenshotUri);
        final String uriText = screenshotUri.toString();
        final long now = System.currentTimeMillis();
        if ((mediaId >= 0 && mediaId == lastScreenshotMediaId && now - lastScreenshotHandledAt < 15_000L)
                || (uriText.equals(lastScreenshotUri) && now - lastScreenshotHandledAt < 15_000L)) {
            return;
        }

        final String captureId = UUID.randomUUID().toString();

        // The first notification is intentionally emitted before decode, resize or network I/O.
        lastScreenshotMediaId = mediaId;
        lastScreenshotUri = uriText;
        lastScreenshotHandledAt = now;
        notifyAutoCaptureDetected();

        new Thread(() -> {
            String dataUrl = null;
            try {
                dataUrl = readCompactImageDataUrlWhenReady(screenshotUri);
                if (dataUrl == null) {
                    notifyAutoCaptureReadFailed();
                    return;
                }

                JSONObject parsed = analyzeHandNative(dataUrl);
                if (!parsed.optBoolean("isPokerHand", false)) {
                    cancelAutoCaptureNotification();
                    return;
                }

                persistPendingNativeHand(captureId, dataUrl, parsed.toString());
                dispatchPendingNativeAnalyses();
                notifyAutoCaptureSaved(captureId, parsed.optString("title", "Poker hand"));
            } catch (Exception error) {
                try {
                    if (dataUrl != null) {
                        JSONObject failed = new JSONObject();
                        failed.put("__error", String.valueOf(error.getMessage() == null ? "Analysis request failed" : error.getMessage()));
                        persistPendingNativeHand(captureId, dataUrl, failed.toString());
                        dispatchPendingNativeAnalyses();
                    }
                } catch (Exception ignored) {}
                notifyAutoCaptureAnalysisFailed(captureId);
            }
        }, "innergame-native-hand-analysis").start();
    }

    private String readCompactImageDataUrlWhenReady(Uri uri) throws Exception {
        // MediaStore can fire before the screenshot file is fully committed.
        for (int attempt = 0; attempt < 6; attempt++) {
            if (attempt > 0) Thread.sleep(60L * attempt);
            if (!mediaItemReady(uri)) continue;
            String dataUrl = compactImageDataUrl(uri);
            if (dataUrl != null && dataUrl.length() > 6000) return dataUrl;
        }
        if (Build.VERSION.SDK_INT < 29 || mediaItemReady(uri)) return compactImageDataUrl(uri);
        return null;
    }

    private String compactImageDataUrl(Uri uri) throws Exception {
        Bitmap bitmap;
        try (InputStream input = getContentResolver().openInputStream(uri)) {
            if (input == null) return null;
            bitmap = BitmapFactory.decodeStream(input);
        }
        if (bitmap == null) return null;

        final int maxDimension = 1120;
        int width = bitmap.getWidth();
        int height = bitmap.getHeight();
        Bitmap outputBitmap = bitmap;
        int largest = Math.max(width, height);
        if (largest > maxDimension) {
            float scale = maxDimension / (float) largest;
            int scaledWidth = Math.max(1, Math.round(width * scale));
            int scaledHeight = Math.max(1, Math.round(height * scale));
            outputBitmap = Bitmap.createScaledBitmap(bitmap, scaledWidth, scaledHeight, true);
        }

        ByteArrayOutputStream output = new ByteArrayOutputStream();
        outputBitmap.compress(Bitmap.CompressFormat.JPEG, 74, output);
        if (outputBitmap != bitmap) outputBitmap.recycle();
        bitmap.recycle();

        byte[] bytes = output.toByteArray();
        if (bytes.length < 4096) return null;
        return "data:image/jpeg;base64," + Base64.encodeToString(bytes, Base64.NO_WRAP);
    }

    private JSONObject analyzeHandNative(String dataUrl) throws Exception {
        JSONObject body = new JSONObject();
        body.put("imageDataUrl", dataUrl);
        body.put("context", new JSONObject());
        byte[] payload = body.toString().getBytes(StandardCharsets.UTF_8);

        Exception lastError = null;
        for (int attempt = 0; attempt < 2; attempt++) {
            HttpURLConnection connection = null;
            try {
                connection = (HttpURLConnection) new URL(HAND_ANALYSIS_URL).openConnection();
                connection.setRequestMethod("POST");
                connection.setConnectTimeout(8_000);
                connection.setReadTimeout(22_000);
                connection.setDoOutput(true);
                connection.setRequestProperty("Content-Type", "application/json");
                connection.setRequestProperty("Accept", "application/json");
                connection.setFixedLengthStreamingMode(payload.length);

                try (OutputStream output = connection.getOutputStream()) {
                    output.write(payload);
                }

                int status = connection.getResponseCode();
                InputStream responseStream = status >= 200 && status < 300
                        ? connection.getInputStream()
                        : connection.getErrorStream();
                String responseBody = readUtf8(responseStream);
                if (status >= 200 && status < 300) return new JSONObject(responseBody);
                lastError = new IllegalStateException("Analysis HTTP " + status);
            } catch (Exception error) {
                lastError = error;
            } finally {
                if (connection != null) connection.disconnect();
            }
            if (attempt == 0) Thread.sleep(180L);
        }
        throw lastError == null ? new IllegalStateException("Analysis request failed") : lastError;
    }

    private String readUtf8(InputStream input) throws Exception {
        if (input == null) return "";
        try (InputStream stream = input; ByteArrayOutputStream output = new ByteArrayOutputStream()) {
            byte[] buffer = new byte[16_384];
            int read;
            while ((read = stream.read(buffer)) != -1) output.write(buffer, 0, read);
            return output.toString(StandardCharsets.UTF_8.name());
        }
    }

    private File pendingHandFile(String captureId) {
        return new File(getFilesDir(), PENDING_HAND_PREFIX + captureId + ".json");
    }

    private void persistPendingNativeHand(String captureId, String dataUrl, String analysisJson) throws Exception {
        JSONObject pending = new JSONObject();
        pending.put("id", captureId);
        pending.put("dataUrl", dataUrl);
        pending.put("analysisJson", analysisJson);
        byte[] bytes = pending.toString().getBytes(StandardCharsets.UTF_8);
        try (FileOutputStream output = new FileOutputStream(pendingHandFile(captureId))) {
            output.write(bytes);
        }
    }

    private void dispatchPendingNativeAnalyses() {
        if (webView == null) return;
        File[] files = getFilesDir().listFiles((dir, name) ->
                name.startsWith(PENDING_HAND_PREFIX) && name.endsWith(".json"));
        if (files == null || files.length == 0) return;
        Arrays.sort(files, Comparator.comparingLong(File::lastModified));

        for (File file : files) {
            try {
                String text;
                try (FileInputStream input = new FileInputStream(file)) {
                    text = readUtf8(input);
                }
                JSONObject pending = new JSONObject(text);
                String captureId = pending.getString("id");
                String dataUrl = pending.getString("dataUrl");
                String analysisJson = pending.getString("analysisJson");

                webView.post(() -> webView.evaluateJavascript(
                        "(function(){if(window.innerGameReceiveNativeAnalysis){window.innerGameReceiveNativeAnalysis(" +
                                JSONObject.quote(captureId) + "," +
                                JSONObject.quote(dataUrl) + "," +
                                JSONObject.quote(analysisJson) +
                                ");return true;}return false;})()",
                        null
                ));
            } catch (Exception ignored) {}
        }
    }

    private void acknowledgePendingNativeHand(String captureId) {
        if (captureId == null || captureId.isEmpty()) return;
        try { pendingHandFile(captureId).delete(); } catch (Exception ignored) {}
    }

    private void cancelAutoCaptureNotification() {
        NotificationManager manager = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        if (manager != null) manager.cancel(6100);
    }

    private void notifyAutoCaptureSaved(String captureId, String title) {
        try {
            JSONObject payload = new JSONObject();
            payload.put("stage", "saved");
            payload.put("title", "Hand saved");
            payload.put("body", title == null || title.isEmpty() ? "Poker hand analyzed and saved." : title + " · Saved to Inner Game.");
            payload.put("handId", captureId);
            showHandNotification(payload.toString());
        } catch (Exception ignored) {}
    }

    private void notifyAutoCaptureAnalysisFailed(String captureId) {
        try {
            JSONObject payload = new JSONObject();
            payload.put("stage", "failed");
            payload.put("title", "Hand analysis failed");
            payload.put("body", "The screenshot is saved in Inner Game. Tap to retry analysis.");
            payload.put("handId", captureId);
            showHandNotification(payload.toString());
        } catch (Exception ignored) {}
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        if (requestCode == MEDIA_PERMISSION_REQUEST) {
            if (hasMediaReadPermission()) {
                registerScreenshotObserver();
                requestNotificationPermissionIfNeeded();
            } else {
                showMediaPermissionHelp();
            }
            return;
        }
        if (requestCode == NOTIFICATION_PERMISSION_REQUEST) {
            if (hasNotificationPermission()) {
                flushPendingHandNotification();
            } else {
                showNotificationPermissionHelp();
            }
        }
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        handleIncomingIntent(intent);
    }

    private void createNotificationChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationManager manager = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        if (manager == null) return;
        NotificationChannel channel = new NotificationChannel(
                BreakReminderReceiver.CHANNEL_ID,
                "Session break reminders",
                NotificationManager.IMPORTANCE_HIGH
        );
        channel.enableVibration(true);
        channel.setVibrationPattern(new long[]{0, 500, 250, 500, 250, 800});
        manager.createNotificationChannel(channel);
    }

    private void createHandNotificationChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationManager manager = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        if (manager == null) return;
        NotificationChannel channel = new NotificationChannel(
                HAND_CHANNEL_ID,
                "Poker hand capture",
                NotificationManager.IMPORTANCE_HIGH
        );
        channel.setDescription("Updates when Inner Game captures and analyzes poker screenshots.");
        channel.enableVibration(true);
        manager.createNotificationChannel(channel);
    }

    private void showHandNotification(String payload) {
        if (!hasNotificationPermission()) {
            pendingHandNotificationPayload = payload;
            requestNotificationPermissionIfNeeded();
            return;
        }
        showHandNotificationNow(payload);
    }

    private void flushPendingHandNotification() {
        if (!hasNotificationPermission() || pendingHandNotificationPayload == null) return;
        String payload = pendingHandNotificationPayload;
        pendingHandNotificationPayload = null;
        showHandNotificationNow(payload);
    }

    private void showHandNotificationNow(String payload) {
        try {
            JSONObject data = new JSONObject(payload);
            String title = data.optString("title", "Inner Game");
            String body = data.optString("body", "");
            String stage = data.optString("stage", "");
            String handId = data.optString("handId", "");

            Intent openIntent = new Intent(this, MainActivity.class);
            openIntent.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP);
            if (!handId.isEmpty()) openIntent.putExtra("handId", handId);
            PendingIntent contentIntent = PendingIntent.getActivity(
                    this,
                    9100 + Math.abs(handId.hashCode() % 500),
                    openIntent,
                    PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
            );

            Notification.Builder builder = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
                    ? new Notification.Builder(this, HAND_CHANNEL_ID)
                    : new Notification.Builder(this);

            NotificationManager manager = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
            if (manager == null) return;
            if (!"analyzing".equals(stage)) manager.cancel(6100);

            Notification notification = builder
                    .setSmallIcon(android.R.drawable.ic_menu_camera)
                    .setContentTitle(title)
                    .setContentText(body)
                    .setStyle(new Notification.BigTextStyle().bigText(body))
                    .setContentIntent(contentIntent)
                    .setAutoCancel(!"analyzing".equals(stage))
                    .setOngoing("analyzing".equals(stage))
                    .setOnlyAlertOnce(false)
                    .setCategory(Notification.CATEGORY_STATUS)
                    .setPriority(Notification.PRIORITY_DEFAULT)
                    .build();

            int id = 6100 + Math.abs(handId.hashCode() % 500);
            manager.notify(id, notification);
        } catch (Exception ignored) {}
    }

    private void requestNotificationPermissionIfNeeded() {
        if (hasNotificationPermission()) {
            flushPendingHandNotification();
            return;
        }
        if (Build.VERSION.SDK_INT >= 33 && !notificationPermissionPromptedThisLaunch) {
            notificationPermissionPromptedThisLaunch = true;
            requestPermissions(new String[]{Manifest.permission.POST_NOTIFICATIONS}, NOTIFICATION_PERMISSION_REQUEST);
        }
    }

    private String breakWorkName(int index) {
        return "innergame-session-break-" + index;
    }

    private void scheduleBreaks(String payload) {
        requestNotificationPermissionIfNeeded();
        cancelBreaks();

        long startedAt = System.currentTimeMillis();
        int intervalMinutes = 60;
        int breakMinutes = 5;
        try {
            JSONObject data = new JSONObject(payload);
            startedAt = data.optLong("startedAt", startedAt);
            intervalMinutes = Math.max(1, data.optInt("intervalMinutes", 60));
            breakMinutes = Math.max(1, data.optInt("breakMinutes", 5));
        } catch (Exception ignored) {}

        long intervalMs = intervalMinutes * 60_000L;
        long now = System.currentTimeMillis();
        WorkManager workManager = WorkManager.getInstance(getApplicationContext());

        for (int i = 0; i < MAX_BREAK_REMINDERS; i++) {
            long triggerAt = startedAt + (long) (i + 1) * intervalMs;
            long delayMs = triggerAt - now;
            if (delayMs <= 0) continue;

            Data input = new Data.Builder()
                    .putInt("breakNumber", i + 1)
                    .putInt("breakMinutes", breakMinutes)
                    .build();

            OneTimeWorkRequest request = new OneTimeWorkRequest.Builder(BreakReminderWorker.class)
                    .setInitialDelay(delayMs, TimeUnit.MILLISECONDS)
                    .setInputData(input)
                    .addTag("innergame-session-breaks")
                    .build();

            workManager.enqueueUniqueWork(
                    breakWorkName(i),
                    androidx.work.ExistingWorkPolicy.REPLACE,
                    request
            );
        }
    }

    private void cancelBreaks() {
        WorkManager workManager = WorkManager.getInstance(getApplicationContext());
        workManager.cancelAllWorkByTag("innergame-session-breaks");
        for (int i = 0; i < MAX_BREAK_REMINDERS; i++) {
            workManager.cancelUniqueWork(breakWorkName(i));
        }
    }

    private final class NativeBridge {
        @JavascriptInterface
        public void scheduleBreakReminders(String payload) {
            runOnUiThread(() -> scheduleBreaks(payload));
        }

        @JavascriptInterface
        public void cancelBreakReminders(String payload) {
            runOnUiThread(MainActivity.this::cancelBreaks);
        }

        @JavascriptInterface
        public void captureHand(String payload) {
            runOnUiThread(() -> Toast.makeText(
                    MainActivity.this,
                    "Take a screenshot — Inner Game will detect poker hands automatically. Share also works.",
                    Toast.LENGTH_LONG
            ).show());
        }

        @JavascriptInterface
        public void notifyHand(String payload) {
            runOnUiThread(() -> MainActivity.this.showHandNotification(payload));
        }

        @JavascriptInterface
        public void setAutoScreenshotEnabled(String payload) {
            boolean enabled = true;
            try { enabled = new JSONObject(payload).optBoolean("enabled", true); } catch (Exception ignored) {}
            final boolean finalEnabled = enabled;
            runOnUiThread(() -> MainActivity.this.setAutoScreenshotEnabled(finalEnabled));
        }

        @JavascriptInterface
        public void ackNativeAnalysis(String payload) {
            try {
                String captureId = new JSONObject(payload).optString("id", "");
                runOnUiThread(() -> MainActivity.this.acknowledgePendingNativeHand(captureId));
            } catch (Exception ignored) {}
        }
    }

    @Override
    public void onBackPressed() {
        if (webView != null) webView.evaluateJavascript("history.back()", null);
        else super.onBackPressed();
    }

    @Override
    protected void onResume() {
        super.onResume();
        if (webView != null) {
            webView.postDelayed(() -> {
                ensureCapturePermissionsOnOpen();
                dispatchPendingNativeAnalyses();
            }, 250L);
        }
    }

    @Override
    protected void onDestroy() {
        unregisterScreenshotObserver();
        if (webView != null) {
            webView.removeJavascriptInterface("InnerGameNative");
            webView.destroy();
            webView = null;
        }
        super.onDestroy();
    }
}
