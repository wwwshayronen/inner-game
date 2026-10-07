package com.innergame.app;

import android.content.Context;
import androidx.annotation.NonNull;
import androidx.work.ForegroundInfo;
import androidx.work.Worker;
import androidx.work.WorkerParameters;
import org.json.JSONObject;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;

public class HandJobWorker extends Worker {
    public HandJobWorker(@NonNull Context context, @NonNull WorkerParameters params) { super(context, params); }
    @NonNull @Override public ForegroundInfo getForegroundInfo() {
        JSONObject job;
        try { job = HandJobStore.read(getApplicationContext(), getInputData().getString("requestId")); }
        catch (Exception error) { job = null; }
        if (job == null) job = new JSONObject();
        return new ForegroundInfo(HandJobNotifications.progressId(job.optString("requestId")), HandJobNotifications.notification(getApplicationContext(), job, false));
    }
    private static final class Response {
        final int status; final JSONObject body;
        Response(int status, JSONObject body) { this.status=status; this.body=body; }
    }
    HttpURLConnection openConnection(URL url) throws Exception { return (HttpURLConnection) url.openConnection(); }
    private Response post(String base, String route, JSONObject payload) throws Exception {
        HttpURLConnection connection = openConnection(new URL(base + route));
        try {
            connection.setRequestMethod("POST");connection.setConnectTimeout(20000);connection.setReadTimeout(30000);
            connection.setDoOutput(true);connection.setRequestProperty("Content-Type", "application/json");
            byte[] bytes = payload.toString().getBytes(StandardCharsets.UTF_8);connection.setFixedLengthStreamingMode(bytes.length);
            try (OutputStream output=connection.getOutputStream()) { output.write(bytes); }
            int status = connection.getResponseCode();
            try (InputStream input = status>=400 ? connection.getErrorStream() : connection.getInputStream();
                 ByteArrayOutputStream output = new ByteArrayOutputStream()) {
                if (input == null) throw new IllegalStateException("No response from hand processing service.");
                byte[] buffer = new byte[8192];int read;
                while ((read=input.read(buffer))!=-1) { output.write(buffer,0,read);if(output.size()>6_000_000)throw new IllegalStateException("Hand result too large."); }
                return new Response(status,new JSONObject(output.toString(StandardCharsets.UTF_8.name())));
            }
        } finally { connection.disconnect(); }
    }
    @NonNull @Override public Result doWork() {
        Context context=getApplicationContext();String id=getInputData().getString("requestId");
        try {
            JSONObject job=HandJobStore.read(context,id);
            if(job==null||!"pending".equals(job.optString("status")))return Result.success();
            if(System.currentTimeMillis()-job.optLong("createdAt",System.currentTimeMillis())>=24*60*60_000L) {
                job.put("status","failed");job.put("completedAt",System.currentTimeMillis());
                job.put("error",new JSONObject().put("message","This background request expired. Your hand is saved; open it to retry."));
                if(HandJobStore.write(context,job,false))HandJobNotifications.show(context,job,true);
                return Result.success();
            }
            String base=job.optString("apiBase", "https://inner-game-production.up.railway.app").replaceAll("/+$", "");
            if(!base.startsWith("https://")) {
                job.put("status","failed");job.put("completedAt",System.currentTimeMillis());
                job.put("error",new JSONObject().put("message","Hand processing requires a secure API address. Check Settings and retry."));
                if(HandJobStore.write(context,job,false))HandJobNotifications.show(context,job,true);
                return Result.success();
            }
            HandJobNotifications.show(context,job,false);
            if(job.optString("serverJobId").isEmpty()) {
                JSONObject request=new JSONObject();request.put("requestId",id);request.put("kind",job.getString("kind"));request.put("payload",job.getJSONObject("payload"));
                Response response=post(base,"/hand-jobs/start",request);
                if(response.status>=500||response.status==429)return Result.retry();
                if(response.status>=400) { job.put("status","failed");job.put("error",new JSONObject().put("message",response.body.optString("message",response.body.optString("error","Could not submit this hand.")))); }
                else { job.put("serverJobId",response.body.getString("jobId"));if(!HandJobStore.write(context,job,false))return Result.success(); }
            }
            long deadline=System.currentTimeMillis()+8*60_000L;
            while("pending".equals(job.optString("status"))&&!isStopped()&&System.currentTimeMillis()<deadline) {
                if(HandJobStore.read(context,id)==null)return Result.success();
                Response response=post(base,"/hand-jobs/poll",new JSONObject().put("jobId",job.getString("serverJobId")));
                if(response.status>=500||response.status==429)return Result.retry();
                if(response.status>=400) { job.put("status","failed");job.put("error",new JSONObject().put("message",response.body.optString("message",response.body.optString("error","Hand processing was interrupted."))));break; }
                String status=response.body.optString("status");
                if(status.equals("complete")||status.equals("failed")) {
                    job.put("status",status);
                    if(response.body.has("result"))job.put("result",response.body.get("result"));
                    if(response.body.has("error"))job.put("error",response.body.get("error"));
                    break;
                }
                Thread.sleep(2500L);
            }
            if(isStopped())return Result.retry();
            if("pending".equals(job.optString("status")))return Result.retry();
            job.put("completedAt",System.currentTimeMillis());
            if(HandJobStore.write(context,job,false))HandJobNotifications.show(context,job,true);
            return Result.success();
        } catch (Exception error) {
            // Offline work remains in WorkManager and in its private file. Retry
            // the same request ID rather than scheduling another paid solve.
            return Result.retry();
        }
    }
}
