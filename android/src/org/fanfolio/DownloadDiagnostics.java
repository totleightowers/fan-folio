package org.fanfolio;

import android.app.ActivityManager;
import android.content.Context;
import android.os.Build;
import android.os.PowerManager;
import android.os.SystemClock;
import android.net.ConnectivityManager;
import android.net.NetworkCapabilities;
import org.json.JSONObject;
import java.io.*;
import java.util.UUID;
import java.util.concurrent.atomic.AtomicLong;

/** Local-only diagnostics. Never pass URLs, headers, titles, SQL or error messages here. */
final class DownloadDiagnostics {
    private static DiagnosticJournal journal;
    private static Context app;
    private static final String SESSION = UUID.randomUUID().toString();
    private static final AtomicLong requests = new AtomicLong();
    private static final AtomicLong activeRequests = new AtomicLong();


    static void init(Context context) {
        app = context.getApplicationContext();
        try { journal = new DiagnosticJournal(new File(app.getFilesDir(), "download-diagnostics"), 2 * 1024 * 1024); }
        catch (Exception ignored) { return; }
        event("process_start", "sdk", Build.VERSION.SDK_INT);
        environment();
        systemState();
        exits();
        final Thread.UncaughtExceptionHandler previous = Thread.getDefaultUncaughtExceptionHandler();
        Thread.setDefaultUncaughtExceptionHandler(new Thread.UncaughtExceptionHandler() {
            @Override public void uncaughtException(Thread thread, Throwable error) {
                failure("uncaught_exception", error);
                if (previous != null) previous.uncaughtException(thread, error);
                else { android.os.Process.killProcess(android.os.Process.myPid()); System.exit(10); }
            }
        });
    }
    private static void environment() {
        try {
            JSONObject info = new JSONObject();
            info.put("version", app.getPackageManager().getPackageInfo(app.getPackageName(), 0).versionName);
            info.put("manufacturer", Build.MANUFACTURER);
            info.put("model", Build.MODEL);
            if (Build.VERSION.SDK_INT >= 26) {
                android.content.pm.PackageInfo web = android.webkit.WebView.getCurrentWebViewPackage();
                if (web != null) info.put("webviewVersion", web.versionName);
            }
            write("environment", info);
        } catch (Exception ignored) { }
    }
    private static void write(String event, JSONObject data) {
        try {
            DiagnosticJournal target = journal;
            if (target == null) return;
            JSONObject record = new JSONObject();
            record.put("schema", 1).put("timeMs", System.currentTimeMillis())
                .put("elapsedMs", SystemClock.elapsedRealtime()).put("session", SESSION)
                .put("pid", android.os.Process.myPid()).put("event", event).put("data", data);
            target.append(record.toString());
        } catch (Exception ignored) { /* Diagnostics must never stop a download. */ }
    }
    static void event(String event, Object... pairs) {
        try {
            JSONObject data = new JSONObject();
            for (int i = 0; i + 1 < pairs.length; i += 2) {
                Object value = pairs[i + 1];
                if (value instanceof Number || value instanceof Boolean) data.put((String) pairs[i], value);
            }
            write(event, data);
        } catch (Exception ignored) { }
    }
    static void failure(String event, Throwable error) {
        try {
            // Class name only. Exception messages can contain URLs, SQL and personal data.
            JSONObject data = new JSONObject().put("exceptionClass", error.getClass().getName());
            write(event, data);
        } catch (Exception ignored) { }
    }
    static void javascript(String event, String payload) {
        if (payload == null || payload.length() > 2048) return;
        try {
            JSONObject input = new JSONObject(payload);
            java.util.Map<String, Object> fields = new java.util.HashMap<>();
            java.util.Iterator<String> keys = input.keys();
            while (keys.hasNext()) { String key = keys.next(); fields.put(key, input.opt(key)); }
            java.util.Map<String, Object> safe = DiagnosticFields.clean(event, fields);
            if (safe != null) write(event, new JSONObject(safe));
        } catch (Exception ignored) { }
    }
    static void systemState() {
        try {
            PowerManager power = (PowerManager) app.getSystemService(Context.POWER_SERVICE);
            ConnectivityManager net = (ConnectivityManager) app.getSystemService(Context.CONNECTIVITY_SERVICE);
            NetworkCapabilities caps = net.getNetworkCapabilities(net.getActiveNetwork());
            ActivityManager.MemoryInfo memory = new ActivityManager.MemoryInfo();
            ((ActivityManager) app.getSystemService(Context.ACTIVITY_SERVICE)).getMemoryInfo(memory);
            event("system", "interactive", power.isInteractive(), "idle", power.isDeviceIdleMode(),
                "powerSave", power.isPowerSaveMode(), "batteryExempt", power.isIgnoringBatteryOptimizations(app.getPackageName()),
                "connected", caps != null, "validated", caps != null && caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED),
                "wifi", caps != null && caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI),
                "cellular", caps != null && caps.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR),
                "lowMemory", memory.lowMemory, "availableMemoryBytes", memory.availMem,
                "activeRequests", activeRequests.get());
        } catch (Exception ignored) { }
    }
    static void exits() {
        if (Build.VERSION.SDK_INT < 30) return;
        try {
            ActivityManager manager = (ActivityManager) app.getSystemService(Context.ACTIVITY_SERVICE);
            for (android.app.ApplicationExitInfo exit : manager.getHistoricalProcessExitReasons(app.getPackageName(), 0, 8)) {
                event("previous_process_exit", "exitTimeMs", exit.getTimestamp(), "exitPid", exit.getPid(), "reason", exit.getReason(),
                    "status", exit.getStatus(), "importance", exit.getImportance(), "pssKb", exit.getPss(), "rssKb", exit.getRss());
            }
        } catch (Exception ignored) { }
    }
    static byte[] snapshot() throws IOException {
        event("export_requested"); environment(); systemState(); exits();
        if (journal == null) throw new IOException("journal unavailable");
        return journal.snapshot();
    }
    static Request request() { return new Request(); }
    static final class Request {
        final long id = requests.incrementAndGet(), started = SystemClock.elapsedRealtime();
        long bytes;
        boolean ended;
        Request() { activeRequests.incrementAndGet(); event("request_start", "request", id); }
        void headers(int status) { event("request_headers", "request", id, "status", status, "ageMs", SystemClock.elapsedRealtime() - started); }
        synchronized void end(int outcome) {
            if (ended) return;
            ended = true; activeRequests.decrementAndGet();
            event("request_end", "request", id, "outcome", outcome, "bytes", bytes, "ageMs", SystemClock.elapsedRealtime() - started);
        }
        InputStream wrap(final InputStream source) {
            if (source == null) { end(0); return null; }
            return new FilterInputStream(source) {
                @Override public int read() throws IOException {
                    try { int n = in.read(); if (n == -1) end(0); else bytes++; return n; }
                    catch (IOException e) { end(2); throw e; }
                }
                @Override public int read(byte[] b, int off, int len) throws IOException {
                    try { int n = in.read(b, off, len); if (n == -1) end(0); else bytes += n; return n; }
                    catch (IOException e) { end(2); throw e; }
                }
                @Override public void close() throws IOException {
                    try { in.close(); end(1); } catch (IOException e) { end(2); throw e; }
                }
            };
        }
    }
}
