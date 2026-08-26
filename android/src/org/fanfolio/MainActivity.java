package org.fanfolio;

import android.app.Activity;
import android.content.Intent;
import android.database.Cursor;
import android.database.sqlite.SQLiteDatabase;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.JavascriptInterface;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;

import java.io.ByteArrayInputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.net.URLDecoder;
import java.util.HashMap;
import java.util.Locale;
import java.util.Map;

/**
 * The whole app.
 *
 * The page is served from the APK's own assets over a virtual https origin, so
 * it runs in a secure context with ordinary relative URLs. Three things the
 * page cannot do for itself happen here:
 *
 *   Archive.query(...)   read the archive with Android's own SQLite
 *   /img/<sha256>        serve a captured image straight out of that database
 *   /__net/?url=…        fetch AO3 and Google Fonts, which send no CORS headers
 *
 * The archive is a 600MB+ SQLite file holding forty million words. It is opened
 * natively rather than shipped into the WebView as WASM: Android already has
 * SQLite, and copying the file into browser storage would double the space for
 * no gain.
 */
public class MainActivity extends Activity {

    private static final String HOST = "appassets.androidplatform.net";
    private static final String ORIGIN = "https://" + HOST;
    private static final int PICK_DATABASE = 1;
    private static final int MAX_ROWS = 2000;

    private WebView web;
    private SQLiteDatabase db;

    @Override protected void onCreate(Bundle state) {
        super.onCreate(state);

        FrameLayout root = new FrameLayout(this);
        root.setBackgroundColor(0xFF000000);

        web = new WebView(this);
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(false);
        s.setSupportZoom(false);
        s.setBuiltInZoomControls(false);
        if (Build.VERSION.SDK_INT >= 26)
            web.setRendererPriorityPolicy(WebView.RENDERER_PRIORITY_IMPORTANT, false);
        web.setOverScrollMode(View.OVER_SCROLL_NEVER);
        web.setBackgroundColor(0xFF000000);
        web.addJavascriptInterface(new Bridge(), "ArchiveNative");

        web.setWebViewClient(new WebViewClient() {
            @Override public WebResourceResponse shouldInterceptRequest(WebView v, WebResourceRequest r) {
                return route(r.getUrl());
            }
            @Override public void onPageStarted(WebView v, String url, android.graphics.Bitmap f) {
                pageTrusted = HOST.equals(Uri.parse(url).getHost());
            }
            @Override public boolean shouldOverrideUrlLoading(WebView v, WebResourceRequest r) {
                Uri u = r.getUrl();
                if (HOST.equals(u.getHost())) return false;
                try { startActivity(new Intent(Intent.ACTION_VIEW, u)); } catch (Exception ignored) {}
                return true;
            }
        });

        root.addView(web, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        setContentView(root);

        registerBackGesture();
        openDatabase();
        web.loadUrl(ORIGIN + "/index.html");
    }

    /**
     * The modern back gesture, on Android 13 and later.
     *
     * Opting into OnBackInvokedCallback is what makes the edge swipe feel like
     * the system's own: it animates, it previews, and it is the gesture people
     * actually use. Without it Android falls back to the legacy path, which
     * arrives as a plain onBackPressed with no animation — the difference
     * between an app and a web page in a box.
     */
    private void registerBackGesture() {
        if (Build.VERSION.SDK_INT < 33) return;      // onBackPressed still serves
        getOnBackInvokedDispatcher().registerOnBackInvokedCallback(
            android.window.OnBackInvokedDispatcher.PRIORITY_DEFAULT,
            new android.window.OnBackInvokedCallback() {
                @Override public void onBackInvoked() { handleBack(); }
            });
    }

    /** Ask the page to go back; close the app only when it has nowhere left. */
    private void handleBack() {
        if (web == null) { finish(); return; }
        web.evaluateJavascript("(window.__onBack && window.__onBack()) ? 'held' : 'exit'",
            new android.webkit.ValueCallback<String>() {
                @Override public void onReceiveValue(String value) {
                    if (value == null || !value.contains("held")) finish();
                }
            });
    }

    /**
     * Android's back gesture belongs to the reader, not to the activity.
     *
     * The app navigates with its own view stack rather than browser history,
     * so WebView.canGoBack() knows nothing about it and every back gesture
     * closed the app — including from inside a work, which is exactly where a
     * reader reaches for back most often. The page is asked first and only
     * gets out of the way when it has nothing left to go back to.
     */
    @Override public void onBackPressed() {
        if (Build.VERSION.SDK_INT >= 33) return;     // the dispatcher owns it there
        handleBack();
    }

    /* ------------------------------------------------------------ database */

    private File databaseFile() { return new File(getFilesDir(), "archive.db"); }

    private void openDatabase() {
        File f = databaseFile();
        if (!f.exists()) return;                 // the page offers an import instead
        try {
            db = SQLiteDatabase.openDatabase(f.getPath(), null,
                    SQLiteDatabase.OPEN_READWRITE | SQLiteDatabase.NO_LOCALIZED_COLLATORS);
        } catch (Exception e) {
            db = null;
        }
    }

    /**
     * Can this device search at all?
     *
     * The index is FTS4, which Android has shipped for years — this probe used
     * to test for FTS5 and kept reporting search as unavailable long after the
     * index had moved. Ask about the thing actually being used.
     */
    private boolean hasSearch() {
        if (db == null) return false;
        try {
            db.execSQL("CREATE VIRTUAL TABLE IF NOT EXISTS temp.fts_probe USING fts4(x)");
            db.execSQL("DROP TABLE IF EXISTS temp.fts_probe");
            return true;
        } catch (Exception e) {
            return false;
        }
    }

    /* ------------------------------------------------------------- routing */

    private WebResourceResponse route(Uri uri) {
        if (uri == null || !HOST.equals(uri.getHost())) return null;
        String path = uri.getPath() == null ? "/" : uri.getPath();
        try {
            if (path.startsWith("/__net/")) return proxy(uri.getQueryParameter("url"));
            if (path.startsWith("/img/")) return image(path.substring(5));
            return asset(path);
        } catch (Exception e) {
            return new WebResourceResponse("text/plain", "utf-8", 500, "Error",
                    headers(), new ByteArrayInputStream(String.valueOf(e.getMessage()).getBytes()));
        }
    }

    private WebResourceResponse asset(String path) throws IOException {
        String name = path.equals("/") ? "index.html" : path.substring(1);
        InputStream in;
        try { in = getAssets().open("web/" + name); }
        catch (IOException miss) { in = getAssets().open("web/index.html"); name = "index.html"; }
        return new WebResourceResponse(mimeOf(name), "utf-8", 200, "OK", headers(), in);
    }

    /** Images live in the archive as blobs, addressed by content hash. */
    private WebResourceResponse image(String sha) {
        if (db == null || !sha.matches("[0-9a-f]{64}")) return notFound();
        try (Cursor c = db.rawQuery(
                "SELECT mime, bytes FROM images WHERE sha256 = ? AND status = 'stored' LIMIT 1",
                new String[]{ sha })) {
            if (!c.moveToFirst()) return notFound();
            String mime = c.isNull(0) ? "application/octet-stream" : c.getString(0);
            byte[] bytes = c.getBlob(1);
            Map<String, String> h = headers();
            // content-addressed, so it can never go stale
            h.put("Cache-Control", "public, max-age=31536000, immutable");
            return new WebResourceResponse(mime, null, 200, "OK", h, new ByteArrayInputStream(bytes));
        } catch (Exception e) {
            return notFound();
        }
    }

    private WebResourceResponse notFound() {
        return new WebResourceResponse("text/plain", "utf-8", 404, "Not found",
                headers(), new ByteArrayInputStream(new byte[0]));
    }

    /**
     * AO3 sends no CORS headers, and Google Fonts is the one thing fetched that
     * is not AO3. Only https, only GET, and every redirect hop is re-checked so
     * an allowed host cannot bounce the request somewhere else.
     */
    private WebResourceResponse proxy(String raw) throws IOException {
        if (raw == null) throw new IOException("no url");
        URL u = new URL(URLDecoder.decode(raw, "UTF-8"));
        HttpURLConnection c;
        for (int hop = 0; ; hop++) {
            if (!"https".equalsIgnoreCase(u.getProtocol())) throw new IOException("https only");
            if (!allowedHost(u.getHost())) throw new IOException("host not allowed: " + u.getHost());
            if (hop > 5) throw new IOException("too many redirects");
            c = open(u);
            int status = c.getResponseCode();
            if (status != 301 && status != 302 && status != 303 && status != 307 && status != 308) break;
            String next = c.getHeaderField("Location");
            c.disconnect();
            if (next == null) throw new IOException("redirect without a location");
            u = new URL(u, next);
        }
        return respond(c);
    }

    private static final String[] ALLOWED = {
        "archiveofourown.org", "fonts.googleapis.com", "fonts.gstatic.com",
    };

    private static boolean allowedHost(String host) {
        if (host == null) return false;
        String h = host.toLowerCase(Locale.ROOT);
        for (String ok : ALLOWED) if (h.equals(ok) || h.endsWith("." + ok)) return true;
        return false;
    }

    private HttpURLConnection open(URL u) throws IOException {
        HttpURLConnection c = (HttpURLConnection) u.openConnection();
        c.setInstanceFollowRedirects(false);
        c.setConnectTimeout(20000);
        c.setReadTimeout(30000);
        c.setRequestProperty("User-Agent", WebSettings.getDefaultUserAgent(this));
        return c;
    }

    private WebResourceResponse respond(HttpURLConnection c) throws IOException {
        int code = c.getResponseCode();
        InputStream in = code >= 400 ? c.getErrorStream() : c.getInputStream();
        if (in == null) in = new ByteArrayInputStream(new byte[0]);
        String type = c.getContentType();
        if (type == null) type = "application/octet-stream";
        return new WebResourceResponse(type.split(";")[0].trim(), "utf-8", code,
                code >= 400 ? "Error" : "OK", headers(), in);
    }

    private Map<String, String> headers() {
        Map<String, String> h = new HashMap<>();
        h.put("Access-Control-Allow-Origin", ORIGIN);
        return h;
    }

    private static String mimeOf(String name) {
        String n = name.toLowerCase(Locale.ROOT);
        if (n.endsWith(".html")) return "text/html";
        if (n.endsWith(".js") || n.endsWith(".mjs")) return "text/javascript";
        if (n.endsWith(".css")) return "text/css";
        if (n.endsWith(".json")) return "application/json";
        if (n.endsWith(".svg")) return "image/svg+xml";
        if (n.endsWith(".png")) return "image/png";
        if (n.endsWith(".woff2")) return "font/woff2";
        return "text/plain";
    }

    /* -------------------------------------------------------------- bridge */

    private volatile boolean pageTrusted = true;

    public class Bridge {
        private void mustBeOurPage() {
            if (!pageTrusted) throw new SecurityException("not available to this page");
        }

        /** Is there an archive to read, and can it do full-text search? */
        @JavascriptInterface
        public String status() {
            mustBeOurPage();
            StringBuilder b = new StringBuilder("{");
            b.append("\"hasDatabase\":").append(db != null);
            b.append(",\"search\":").append(hasSearch());
            b.append(",\"path\":").append(quote(databaseFile().getPath()));
            b.append("}");
            return b.toString();
        }

        /**
         * Run a read-only query and return rows as JSON.
         *
         * Writes are refused outright. The page composes SQL, but it is the
         * app's own page and its statements are parameterised; refusing
         * anything that is not a SELECT keeps a future bug in the page from
         * being able to damage the archive.
         */
        @JavascriptInterface
        public String query(String sql, String argsJson) {
            mustBeOurPage();
            if (db == null) return "{\"error\":\"no database\"}";
            String trimmed = sql == null ? "" : sql.trim();
            if (!trimmed.regionMatches(true, 0, "SELECT", 0, 6)
                    && !trimmed.regionMatches(true, 0, "WITH", 0, 4)) {
                return "{\"error\":\"read-only\"}";
            }
            String[] args = parseArgs(argsJson);
            StringBuilder out = new StringBuilder("{\"rows\":[");
            try (Cursor c = db.rawQuery(trimmed, args)) {
                int n = 0;
                while (c.moveToNext() && n < MAX_ROWS) {
                    if (n++ > 0) out.append(',');
                    out.append('{');
                    for (int i = 0; i < c.getColumnCount(); i++) {
                        if (i > 0) out.append(',');
                        out.append(quote(c.getColumnName(i))).append(':');
                        switch (c.getType(i)) {
                            case Cursor.FIELD_TYPE_NULL: out.append("null"); break;
                            case Cursor.FIELD_TYPE_INTEGER: out.append(c.getLong(i)); break;
                            case Cursor.FIELD_TYPE_FLOAT: out.append(c.getDouble(i)); break;
                            case Cursor.FIELD_TYPE_BLOB:
                                // matchinfo() is a blob of 32-bit counters and the
                                // page needs the bytes to rank results; base64 is
                                // the only shape that survives JSON intact
                                out.append('"')
                                   .append(android.util.Base64.encodeToString(
                                       c.getBlob(i), android.util.Base64.NO_WRAP))
                                   .append('"');
                                break;
                            default: out.append(quote(c.getString(i)));
                        }
                    }
                    out.append('}');
                }
                out.append("],\"truncated\":").append(n >= MAX_ROWS).append('}');
                return out.toString();
            } catch (Exception e) {
                return "{\"error\":" + quote(String.valueOf(e.getMessage())) + "}";
            }
        }

        /**
         * Hold the screen awake while a chapter is open.
         *
         * Nothing is more obviously not-an-app than the display timing out
         * mid-page because the reader has not touched it for a minute.
         */
        @JavascriptInterface
        public void keepAwake(final boolean on) {
            mustBeOurPage();
            runOnUiThread(new Runnable() {
                @Override public void run() {
                    if (on) getWindow().addFlags(
                        android.view.WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
                    else getWindow().clearFlags(
                        android.view.WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
                }
            });
        }

        /** Let the reader hand over an archive.db built elsewhere. */
        @JavascriptInterface
        public void importDatabase() {
            mustBeOurPage();
            Intent pick = new Intent(Intent.ACTION_OPEN_DOCUMENT);
            pick.addCategory(Intent.CATEGORY_OPENABLE);
            pick.setType("*/*");
            try { startActivityForResult(pick, PICK_DATABASE); } catch (Exception ignored) {}
        }
    }

    @Override protected void onActivityResult(int request, int result, Intent data) {
        super.onActivityResult(request, result, data);
        if (request != PICK_DATABASE || result != RESULT_OK || data == null || data.getData() == null) return;
        try (InputStream in = getContentResolver().openInputStream(data.getData());
             OutputStream out = new FileOutputStream(databaseFile())) {
            byte[] buf = new byte[1 << 16];
            int read;
            while ((read = in.read(buf)) > 0) out.write(buf, 0, read);
        } catch (Exception ignored) {
            return;
        }
        openDatabase();
        web.reload();
    }

    /* --------------------------------------------------------------- json */

    private static String[] parseArgs(String json) {
        if (json == null || json.isEmpty()) return new String[0];
        String body = json.trim();
        if (body.startsWith("[")) body = body.substring(1);
        if (body.endsWith("]")) body = body.substring(0, body.length() - 1);
        if (body.trim().isEmpty()) return new String[0];
        // values arrive already JSON-encoded by the page; split on top-level commas
        java.util.List<String> parts = new java.util.ArrayList<>();
        boolean inString = false;
        boolean escaped = false;
        StringBuilder cur = new StringBuilder();
        for (char ch : body.toCharArray()) {
            if (escaped) { cur.append(ch); escaped = false; continue; }
            if (ch == '\\') { escaped = true; cur.append(ch); continue; }
            if (ch == '"') { inString = !inString; continue; }
            if (ch == ',' && !inString) { parts.add(cur.toString()); cur.setLength(0); continue; }
            cur.append(ch);
        }
        parts.add(cur.toString());
        String[] args = new String[parts.size()];
        for (int i = 0; i < args.length; i++) args[i] = unescape(parts.get(i).trim());
        return args;
    }

    private static String unescape(String s) {
        return s.replace("\\\"", "\"").replace("\\\\", "\\").replace("\\n", "\n").replace("\\t", "\t");
    }

    private static String quote(String s) {
        if (s == null) return "null";
        StringBuilder b = new StringBuilder("\"");
        for (char ch : s.toCharArray()) {
            switch (ch) {
                case '"': b.append("\\\""); break;
                case '\\': b.append("\\\\"); break;
                case '\n': b.append("\\n"); break;
                case '\r': b.append("\\r"); break;
                case '\t': b.append("\\t"); break;
                default:
                    if (ch < 0x20) b.append(String.format("\\u%04x", (int) ch));
                    else b.append(ch);
            }
        }
        return b.append('"').toString();
    }

    @Override protected void onDestroy() {
        if (db != null) db.close();
        super.onDestroy();
    }
}
