package com.innergame.app;

import android.content.Context;
import android.util.AtomicFile;
import androidx.work.BackoffPolicy;
import androidx.work.Constraints;
import androidx.work.Data;
import androidx.work.ExistingWorkPolicy;
import androidx.work.NetworkType;
import androidx.work.OneTimeWorkRequest;
import androidx.work.OutOfQuotaPolicy;
import androidx.work.WorkManager;
import org.json.JSONObject;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.ByteArrayOutputStream;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.TimeUnit;

final class HandJobStore {
    private HandJobStore() {}
    static File directory(Context context) {
        File directory = new File(context.getFilesDir(), "hand_jobs");
        if (!directory.isDirectory()) directory.mkdirs();
        return directory;
    }
    private static File file(Context context, String id) {
        if (id == null || !id.matches("[a-zA-Z0-9_-]{1,128}")) throw new IllegalArgumentException("Invalid hand job ID");
        return new File(directory(context), id + ".json");
    }
    static synchronized JSONObject read(Context context, String id) throws Exception {
        AtomicFile file = new AtomicFile(file(context, id));
        if (!file.getBaseFile().exists()) return null;
        try (FileInputStream input = file.openRead(); ByteArrayOutputStream output = new ByteArrayOutputStream()) {
            byte[] buffer = new byte[8192]; int read;
            while ((read = input.read(buffer)) != -1) output.write(buffer, 0, read);
            return new JSONObject(new String(output.toByteArray(), StandardCharsets.UTF_8));
        }
    }
    static synchronized boolean write(Context context, JSONObject job, boolean create) throws Exception {
        AtomicFile file = new AtomicFile(file(context, job.getString("requestId")));
        if (!create && !file.getBaseFile().exists()) return false; // deleted/edited hand
        FileOutputStream output = file.startWrite();
        try {
            output.write(job.toString().getBytes(StandardCharsets.UTF_8));
            file.finishWrite(output);
            return true;
        } catch (Exception error) { file.failWrite(output); throw error; }
    }
    static synchronized void enqueue(Context context, JSONObject input) throws Exception {
        String id = input.getString("requestId"), kind = input.getString("kind");
        if (!kind.equals("analysis") && !kind.equals("reconstruction") && !kind.equals("solve")) throw new IllegalArgumentException("Invalid hand job type");
        if (read(context, id) == null) {
            JSONObject job = new JSONObject(input.toString());
            job.put("status", "pending");
            job.put("createdAt", System.currentTimeMillis());
            write(context, job, true);
        }
        schedule(context, id);
    }
    private static void schedule(Context context, String id) {
        // WorkManager's 10 KB Data limit applies only to this ID; the image and
        // request live in an atomic private file and survive process death.
        OneTimeWorkRequest request = new OneTimeWorkRequest.Builder(HandJobWorker.class)
                .setInputData(new Data.Builder().putString("requestId", id).build())
                .setConstraints(new Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build())
                .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 10, TimeUnit.SECONDS)
                .setExpedited(OutOfQuotaPolicy.RUN_AS_NON_EXPEDITED_WORK_REQUEST)
                .addTag("innergame-hand-jobs")
                .build();
        WorkManager.getInstance(context).enqueueUniqueWork("innergame-hand-job-" + id, ExistingWorkPolicy.KEEP, request);
    }
    static void restore(Context context) {
        for (File file : files(context)) {
            try {
                JSONObject job = read(context, file.getName().replace(".json", ""));
                if (job != null && "pending".equals(job.optString("status"))) schedule(context, job.getString("requestId"));
            } catch (Exception ignored) {}
        }
    }
    static File[] files(Context context) {
        File[] files = directory(context).listFiles((dir, name) -> name.endsWith(".json"));
        return files == null ? new File[0] : files;
    }
    static synchronized void remove(Context context, String id) {
        try {
            new AtomicFile(file(context, id)).delete();
            HandJobNotifications.cancelProgress(context, id);
        } catch (Exception ignored) {}
        try { WorkManager.getInstance(context).cancelUniqueWork("innergame-hand-job-" + id); }
        catch (Exception ignored) {}
    }
    static void removeAll(Context context) {
        try { WorkManager.getInstance(context).cancelAllWorkByTag("innergame-hand-jobs"); }
        catch (Exception ignored) {}
        for (File file : files(context)) remove(context, file.getName().replace(".json", ""));
    }
}
