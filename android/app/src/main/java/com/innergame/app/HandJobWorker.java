package com.innergame.app;

import android.content.Context;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.util.Log;
import androidx.annotation.NonNull;
import androidx.work.ForegroundInfo;
import androidx.work.Worker;
import androidx.work.WorkerParameters;
import org.json.JSONObject;
import org.json.JSONArray;
import java.time.Instant;
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
        int id = HandJobNotifications.progressId(job.optString("requestId"));
        android.app.Notification notification = HandJobNotifications.notification(getApplicationContext(), job, false);
        return Build.VERSION.SDK_INT >= 29
                ? new ForegroundInfo(id, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC)
                : new ForegroundInfo(id, notification);
    }
    private static final class Response {
        final int status; final JSONObject body;
        Response(int status, JSONObject body) { this.status=status; this.body=body; }
    }
    HttpURLConnection openConnection(URL url) throws Exception { return (HttpURLConnection) url.openConnection(); }
    private Object debugValue(Object value) throws Exception {
        Object clean = redactDebug(value);
        String text = String.valueOf(clean);
        return text.length() <= 16000 ? clean : new JSONObject().put("truncated",true)
                .put("totalCharacters",text.length()).put("preview",text.substring(0,16000));
    }
    private Object redactDebug(Object value) throws Exception {
        if(value instanceof JSONObject) {
            JSONObject source=(JSONObject)value, clean=new JSONObject();
            java.util.Iterator<String> keys=source.keys();
            while(keys.hasNext()) {
                String key=keys.next();
                clean.put(key,key.matches("(?i)imageDataUrl|authorization|apiKey|token") ? "[omitted]" : redactDebug(source.get(key)));
            }
            return clean;
        }
        if(value instanceof JSONArray) {
            JSONArray source=(JSONArray)value,clean=new JSONArray();
            for(int i=0;i<source.length();i++)clean.put(redactDebug(source.get(i)));
            return clean;
        }
        if(value instanceof String && ((String)value).startsWith("data:image/"))return "[screenshot omitted]";
        return value;
    }
    private void recordHttp(JSONObject job, String url, JSONObject request, int status, Object response, String error, long started) {
        if("analysis".equals(job.optString("kind")))return;
        try {
            JSONArray events=job.optJSONArray("httpTrace");if(events==null)events=new JSONArray();
            JSONObject event=new JSONObject().put("at",Instant.now().toString()).put("method","POST").put("url",url)
                    .put("request",debugValue(request)).put("status",status).put("durationMs",System.currentTimeMillis()-started);
            if(response!=null)event.put("response",debugValue(response));
            if(error!=null)event.put("error",error);
            JSONObject last=events.length()>0?events.optJSONObject(events.length()-1):null;
            if(status==202 && last!=null && last.optInt("status")==status && url.equals(last.optString("url"))
                    && String.valueOf(event.opt("request")).equals(String.valueOf(last.opt("request")))
                    && String.valueOf(event.opt("response")).equals(String.valueOf(last.opt("response")))) {
                event.put("at",last.optString("at"));event.put("repeats",last.optInt("repeats",1)+1);events.put(events.length()-1,event);
            } else events.put(event);
            while(events.length()>20 || events.length()>1 && events.toString().length()>160000)events.remove(0);
            job.put("httpTrace",events);
            HandJobStore.write(getApplicationContext(),job,false);
        } catch(Exception ignored) { /* Diagnostics must not interrupt the solve. */ }
    }
    private Response post(JSONObject job, String base, String route, JSONObject payload) throws Exception {
        long started=System.currentTimeMillis();boolean recorded=false;
        HttpURLConnection connection=null;
        try {
            connection = openConnection(new URL(base + route));
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
                String raw=output.toString(StandardCharsets.UTF_8.name());
                Object body;try {body=new JSONObject(raw);}catch(Exception invalidJson){body=raw;}
                recordHttp(job,base+route,payload,status,body,null,started);recorded=true;
                return new Response(status,new JSONObject(raw));
            }
        } catch(Exception error) {
            if(!recorded)recordHttp(job,base+route,payload,0,null,error.getClass().getSimpleName()+": "+error.getMessage(),started);
            throw error;
        } finally { if(connection!=null)connection.disconnect(); }
    }
    @NonNull @Override public Result doWork() {
        Context context=getApplicationContext();String id=getInputData().getString("requestId");
        String stage="read";
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
            // getForegroundInfo() alone only promotes expedited work below API
            // 31. Explicitly promote on every Android version and await the
            // ongoing service before any network request can outlive the UI.
            stage="foreground";
            setForegroundAsync(getForegroundInfo()).get();
            if(isStopped()||HandJobStore.read(context,id)==null)return Result.success();
            if(job.optString("serverJobId").isEmpty()) {
                stage="submit";
                JSONObject request=new JSONObject();request.put("requestId",id);request.put("kind",job.getString("kind"));request.put("payload",job.getJSONObject("payload"));
                Response response=post(job,base,"/hand-jobs/start",request);
                if(response.status>=500||response.status==429)return Result.retry();
                if(response.status>=400) { job.put("status","failed");job.put("error",new JSONObject().put("message",response.body.optString("message",response.body.optString("error","Could not submit this hand.")))); }
                else { job.put("serverJobId",response.body.getString("jobId"));if(!HandJobStore.write(context,job,false))return Result.success(); }
            }
            long deadline=System.currentTimeMillis()+8*60_000L;
            stage="poll";
            while("pending".equals(job.optString("status"))&&!isStopped()&&System.currentTimeMillis()<deadline) {
                if(HandJobStore.read(context,id)==null)return Result.success();
                Response response=post(job,base,"/hand-jobs/poll",new JSONObject().put("jobId",job.getString("serverJobId")));
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
            Log.w("InnerGameHandJob", "Job " + id + " will retry at " + stage + ": " + error.getClass().getSimpleName());
            try {
                JSONObject pending=HandJobStore.read(context,id);
                if(pending!=null&&"pending".equals(pending.optString("status"))) {
                    pending.put("lastAttemptStage",stage);pending.put("lastAttemptAt",System.currentTimeMillis());
                    HandJobStore.write(context,pending,false);
                }
            } catch (Exception ignored) {}
            // Offline work remains in WorkManager and in its private file. Retry
            // the same request ID rather than scheduling another paid solve.
            return Result.retry();
        }
    }
}

