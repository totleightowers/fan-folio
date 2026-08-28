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
    private static final int SAVE_DATABASE = 2;
    private static final int MAX_ROWS = 2000;

    /* Statements that read nothing useful and reach outside this archive. */
    private static final java.util.regex.Pattern PRAGMA_OR_ATTACH =
        java.util.regex.Pattern.compile("\\b(pragma|attach|detach|vacuum|load_extension)\\b",
            java.util.regex.Pattern.CASE_INSENSITIVE);

    private WebView web;
    private WebView signInView;
    private FrameLayout root;
    private SQLiteDatabase db;

    @Override protected void onCreate(Bundle state) {
        super.onCreate(state);

        root = new FrameLayout(this);
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
        android.webkit.CookieManager.getInstance().setAcceptCookie(true);

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
        pendingLink = linkFrom(getIntent());
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

        /* From Android 14 the gesture reports itself as it happens, so the page
           can move with the finger and show where back is going. Below that it
           can only be told the gesture finished, which is the difference
           between previewing a destination and being dropped at it. */
        if (Build.VERSION.SDK_INT >= 34) {
            getOnBackInvokedDispatcher().registerOnBackInvokedCallback(
                android.window.OnBackInvokedDispatcher.PRIORITY_DEFAULT,
                new android.window.OnBackAnimationCallback() {
                    @Override public void onBackStarted(android.window.BackEvent e) {
                        toPage("window.__onBackStart && window.__onBackStart()");
                    }
                    @Override public void onBackProgressed(android.window.BackEvent e) {
                        toPage("window.__onBackProgress && window.__onBackProgress("
                            + e.getProgress() + ")");
                    }
                    @Override public void onBackCancelled() {
                        toPage("window.__onBackCancel && window.__onBackCancel()");
                    }
                    @Override public void onBackInvoked() { handleBack(); }
                });
            return;
        }

        getOnBackInvokedDispatcher().registerOnBackInvokedCallback(
            android.window.OnBackInvokedDispatcher.PRIORITY_DEFAULT,
            new android.window.OnBackInvokedCallback() {
                @Override public void onBackInvoked() { handleBack(); }
            });
    }

    /**
     * Fire and forget, for the gesture frames.
     *
     * Back progress arrives at the refresh rate and nothing is returned, so
     * these must not wait for a result the way handleBack does.
     */
    private void toPage(String js) {
        if (web != null) web.evaluateJavascript(js, null);
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

    /* --------------------------------------------------------- opening links */

    /**
     * A link the reader opened or shared into the app.
     *
     * Held until the page says it is ready. An intent can arrive before the
     * WebView has loaded — that is the usual case on a cold start — and
     * calling into a page that does not exist yet silently does nothing.
     */
    private String pendingLink;

    /** The work link out of an intent, whether opened or shared. */
    private String linkFrom(Intent intent) {
        if (intent == null) return null;
        String action = intent.getAction();
        if (Intent.ACTION_VIEW.equals(action)) {
            Uri data = intent.getData();
            return data == null ? null : data.toString();
        }
        if (Intent.ACTION_SEND.equals(action)) {
            /*
             * Shared text is usually "Title https://…" rather than a bare link,
             * so the link has to be picked out of it.
             *
             * Done by splitting on whitespace rather than with a pattern.
             * A pattern of the obvious shape — scheme, then any run of
             * non-space, then the works path, then more non-space — reads
             * naturally and backtracks polynomially on text made of repeated
             * scheme prefixes. Shared text is precisely the kind of input
             * somebody else chooses, so this looks at each word once instead.
             */
            String text = intent.getStringExtra(Intent.EXTRA_TEXT);
            if (text == null) return null;
            for (String word : text.split("\\s+")) {
                if (word.length() > 2000) continue;
                String lower = word.toLowerCase(Locale.ROOT);
                if ((lower.startsWith("http://") || lower.startsWith("https://"))
                        && lower.contains("/works/")) {
                    return word;
                }
            }
            return text.trim();
        }
        return null;
    }

    @Override protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        String link = linkFrom(intent);
        if (link != null) deliverLink(link);
    }

    private void deliverLink(final String link) {
        if (web == null) { pendingLink = link; return; }
        runOnUiThread(new Runnable() {
            @Override public void run() {
                web.evaluateJavascript(
                    "window.__openLink && window.__openLink(" + quote(link) + ")", null);
            }
        });
    }

    /* ------------------------------------------------------------ database */

    private File databaseFile() { return new File(getFilesDir(), "archive.db"); }

    private void openDatabase() {
        File f = databaseFile();
        if (!f.exists()) return;                 // the page offers an import instead
        try {
            db = SQLiteDatabase.openDatabase(f.getPath(), null,
                    SQLiteDatabase.OPEN_READWRITE | SQLiteDatabase.NO_LOCALIZED_COLLATORS);
            migrate();
        } catch (Exception e) {
            db = null;
        }
    }

    /**
     * Every column the app queries, and the type it is created with.
     *
     * A database on a phone was written by whichever version exported it, and
     * it stays that shape forever: the schema is applied with CREATE TABLE IF
     * NOT EXISTS, which does nothing at all to a table that already exists. So
     * adding `rec` to the schema added it for new databases and for nobody
     * else, and the library stopped loading entirely with `no such column:
     * w.rec` — one missing column takes out the query that lists every work.
     *
     * This must list every column in the works table of app/core/store/schema.js.
     * A test fails if the two ever disagree, because the failure mode here is
     * not a missing feature, it is a blank screen with SQL on it.
     */
    private static final String[][] WORKS_COLUMNS = {
        {"title", "TEXT"}, {"authors", "TEXT"}, {"summary", "TEXT"},
        {"rating", "TEXT"}, {"language", "TEXT"}, {"published", "TEXT"},
        {"updated", "TEXT"}, {"downloaded_at", "TEXT"}, {"complete", "INTEGER"},
        {"words", "INTEGER"}, {"chapter_count", "INTEGER"},
        {"chapters_planned", "INTEGER"}, {"updated_at", "INTEGER"},
        {"skin_css", "TEXT"}, {"skin_hash", "TEXT"}, {"end_notes_html", "TEXT"},
        {"source", "TEXT"}, {"source_file", "TEXT"}, {"fetched_at", "TEXT"},
        {"in_bookmarks", "INTEGER DEFAULT 0"}, {"rec", "INTEGER DEFAULT 0"},
        {"in_history", "INTEGER DEFAULT 0"}, {"bookmarked_at", "TEXT"},
        {"last_visited", "TEXT"}, {"visits", "INTEGER"},
        {"kudos_given", "INTEGER DEFAULT 0"},
        {"kudos", "INTEGER"}, {"bookmark_count", "INTEGER"}, {"hits", "INTEGER"},
        {"has_text", "INTEGER DEFAULT 0"},
    };

    /**
     * Bring an older database up to the shape the app queries.
     *
     * Adding a column is the only migration attempted, and it is the only one
     * needed so far: SQLite writes it into the table definition without
     * touching a row, so it is quick even on a large library and safe to run
     * on every open. Anything that ever needs more than this should be a
     * versioned migration rather than an addition here.
     */
    private void migrate() { migrate(db); }

    private void migrate(SQLiteDatabase db) {
        java.util.Set<String> have = new java.util.HashSet<>();
        android.database.Cursor c = null;
        try {
            c = db.rawQuery("PRAGMA table_info(works)", null);
            int name = c.getColumnIndex("name");
            while (c.moveToNext()) have.add(c.getString(name));
        } catch (Exception e) {
            return;                              // not our shape; leave it alone
        } finally {
            if (c != null) c.close();
        }
        if (have.isEmpty()) return;              // no works table: an import will make one

        for (String[] col : WORKS_COLUMNS) {
            if (have.contains(col[0])) continue;
            try {
                db.execSQL("ALTER TABLE works ADD COLUMN " + col[0] + " " + col[1]);
            } catch (Exception e) {
                // a column that cannot be added must not stop the ones that can
            }
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

    /* ------------------------------------------------------------- signing in */

    private static final String LOGIN_URL = "https://archiveofourown.org/users/login";

    /**
     * Sign in on the archive's own page.
     *
     * A second WebView is opened on the real login form over HTTPS. It is
     * given no JavascriptInterface and no way to talk to this app: the reader
     * types their password into the archive, and nothing here can see it. What
     * we keep afterwards is the session cookie the archive sets, which expires
     * on its own and dies when they sign out.
     *
     * The app's own page is never navigated away from, so the bridge it uses
     * stays available and stays refused to everything else.
     */
    private void openSignIn() {
        if (signInView != null) return;

        signInView = new WebView(this);
        WebSettings s = signInView.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(false);
        signInView.setWebViewClient(new WebViewClient() {
            @Override public void onPageFinished(WebView v, String url) {
                // the archive redirects away from /users/login once it accepts
                if (url != null && !url.contains("/users/login") && isSignedIn()) {
                    closeSignIn(true);
                }
            }
        });

        FrameLayout panel = new FrameLayout(this);
        panel.setBackgroundColor(0xFF101010);

        android.widget.Button close = new android.widget.Button(this);
        close.setText("Close");
        close.setOnClickListener(new View.OnClickListener() {
            @Override public void onClick(View v) { closeSignIn(isSignedIn()); }
        });

        FrameLayout.LayoutParams full = new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT);
        full.topMargin = 140;
        panel.addView(signInView, full);
        FrameLayout.LayoutParams top = new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        panel.addView(close, top);

        root.addView(panel, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        signInPanel = panel;
        signInView.loadUrl(LOGIN_URL);
    }

    private FrameLayout signInPanel;

    private void closeSignIn(boolean signedIn) {
        if (signInPanel != null) { root.removeView(signInPanel); signInPanel = null; }
        if (signInView != null) { signInView.destroy(); signInView = null; }
        android.webkit.CookieManager.getInstance().flush();
        web.evaluateJavascript("window.__signedIn && window.__signedIn(" + signedIn + ")", null);
    }

    /** The archive's session cookies, as the browser holds them. */
    private String archiveCookies() {
        String cookies = android.webkit.CookieManager.getInstance().getCookie(LOGIN_URL);
        return cookies == null ? "" : cookies;
    }

    private boolean isSignedIn() {
        String c = archiveCookies();
        return c.contains("remember_user_token") || c.contains("user_credentials");
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
            // the page shows this to the reader, so it has to say what happened
            String reason = e.getClass().getSimpleName() + ": " + e.getMessage();
            return new WebResourceResponse("text/plain", "utf-8", 500, "Error",
                    headers(), new ByteArrayInputStream(reason.getBytes()));
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
    /**
     * Fetch, with a few attempts.
     *
     * The tooling paces itself and retries; this had neither, so a single
     * transient failure surfaced to the reader as "the archive answered 500".
     * Cloudflare sits in front of the archive and produces TLS handshake
     * failures and 52x responses that clear on their own — one attempt is not
     * enough to tell a blip from a refusal.
     *
     * Kept deliberately small: three attempts over a few seconds. This runs
     * while somebody is waiting for a dialog, not on a background walk, so
     * long backoffs belong in the tooling rather than here.
     */
    private WebResourceResponse proxy(String raw) throws IOException {
        IOException last = null;
        for (int attempt = 0; attempt < 3; attempt++) {
            if (attempt > 0) {
                try { Thread.sleep(700L * attempt); } catch (InterruptedException ignored) {
                    Thread.currentThread().interrupt();
                }
            }
            try {
                WebResourceResponse res = proxyOnce(raw);
                int code = res.getStatusCode();
                // 520-527 are Cloudflare's own, and always transient
                if (code < 500 || (code > 527 && code != 502 && code != 503 && code != 504)) return res;
                if (attempt == 2) return res;
            } catch (IOException e) {
                last = e;
            }
        }
        throw last == null ? new IOException("could not reach the archive") : last;
    }

    private WebResourceResponse proxyOnce(String raw) throws IOException {
        if (raw == null) throw new IOException("no url");
        /* getQueryParameter has already decoded this. Decoding a second time
           turns a literal + into a space and eats any %xx the URL legitimately
           contains, which is how a perfectly good link becomes an unreachable
           one. */
        URL u = new URL(raw);
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

    /**
     * Is this the archive itself, and not merely a name ending in it?
     *
     * endsWith("archiveofourown.org") is true of evilarchiveofourown.org, which
     * is somebody else's domain entirely. Anywhere that decision gates a
     * session cookie, the dot is the whole security boundary.
     */
    private static final String ARCHIVE = "https://archiveofourown.org";

    /**
     * A path on the archive, and nothing else.
     *
     * Anything that could name somewhere else is refused rather than repaired:
     * a scheme, a protocol-relative //host, or a path that does not begin at
     * the root. What survives is concatenated onto a constant host, so the
     * destination of a write is not something any caller can influence.
     */
    private static String safePath(String path) {
        if (path == null || path.isEmpty()) return null;
        if (!path.startsWith("/") || path.startsWith("//")) return null;
        if (path.contains("://") || path.contains("\\")) return null;
        return path;
    }

    /**
     * The host is a separate argument, not part of a string.
     *
     * Concatenating a path onto a host produces one URL string in which the
     * host is no longer distinguishable from the part that came from the page.
     * This constructor takes the protocol and host as their own literals, so
     * the only thing a caller supplies is the file — which is the whole claim
     * being made, expressed in a way that reads as true rather than argued for
     * in a comment.
     */
    private static URL archiveUrl(String path) {
        String p = safePath(path);
        if (p == null) return null;
        try {
            return new URL("https", "archiveofourown.org", p);
        } catch (java.net.MalformedURLException e) {
            return null;
        }
    }

    private static boolean isArchiveHost(String host) {
        if (host == null) return false;
        String h = host.toLowerCase(Locale.ROOT);
        return h.equals("archiveofourown.org") || h.endsWith(".archiveofourown.org");
    }

    private static boolean allowedHost(String host) {
        if (host == null) return false;
        String h = host.toLowerCase(Locale.ROOT);
        for (String ok : ALLOWED) if (h.equals(ok) || h.endsWith("." + ok)) return true;
        return false;
    }

    /**
     * Open a page in a browser, and never in here.
     *
     * Handing ACTION_VIEW to a chooser and asking it to exclude this app did
     * not work: the chooser came back empty and said no app could perform the
     * action, on a phone with browsers on it. Whatever the chooser was doing,
     * relying on it to do the filtering was the mistake.
     *
     * Browsers are found instead by asking who handles an ordinary web address
     * — an app that has merely registered an archive link does not answer that
     * — and the real link is then handed to one of them explicitly. Nothing is
     * left to a chooser's judgement about what belongs in the list.
     */
    private void toBrowser(URL u) {
        Uri target = Uri.parse(u.toString());
        Intent probe = new Intent(Intent.ACTION_VIEW, Uri.parse("https://example.com"));
        probe.addCategory(Intent.CATEGORY_BROWSABLE);

        java.util.List<Intent> options = new java.util.ArrayList<>();
        java.util.Set<String> seen = new java.util.HashSet<>();
        for (android.content.pm.ResolveInfo r
                : getPackageManager().queryIntentActivities(probe, 0)) {
            if (r.activityInfo == null) continue;
            String pkg = r.activityInfo.packageName;
            if (getPackageName().equals(pkg) || !seen.add(pkg)) continue;
            Intent open = new Intent(Intent.ACTION_VIEW, target);
            open.addCategory(Intent.CATEGORY_BROWSABLE);
            open.setPackage(pkg);
            options.add(open);
        }

        if (options.isEmpty()) {
            toPage("window.__noBrowser && window.__noBrowser()");
            return;
        }

        try {
            if (options.size() == 1) {
                startActivity(options.get(0));
                return;
            }
            /* Several browsers: a chooser built from intents that already name
               their target, rather than one asked to work out the list itself. */
            Intent chooser = Intent.createChooser(options.remove(0), "Open on the archive");
            chooser.putExtra(Intent.EXTRA_INITIAL_INTENTS,
                options.toArray(new android.os.Parcelable[0]));
            startActivity(chooser);
        } catch (Exception e) {
            toPage("window.__noBrowser && window.__noBrowser()");
        }
    }

    /** The version stamped into this package at build time. */
    private String versionName() {
        try {
            return getPackageManager().getPackageInfo(getPackageName(), 0).versionName;
        } catch (Exception e) {
            return "unknown";
        }
    }

    /** Whitespace is not a change. Compared the way the other path compares. */
    private static String settled(String html) {
        return html == null ? "" : html.replaceAll("\\s+", " ").trim();
    }

    /**
     * Copy any chapter about to be replaced into chapter_versions.
     *
     * Only what actually differs: refetching an unchanged work should leave no
     * trace, or every refetch would bury the real changes under copies of
     * chapters nobody touched.
     */
    private int archiveChapters(String workId, org.json.JSONArray incoming) {
        java.util.Map<Integer, String> replacement = new java.util.HashMap<>();
        for (int i = 0; incoming != null && i < incoming.length(); i++) {
            replacement.put(i + 1, settled(incoming.optJSONObject(i) == null
                ? "" : incoming.optJSONObject(i).optString("html")));
        }

        java.util.List<android.content.ContentValues> keep = new java.util.ArrayList<>();
        String now = nowIso();
        try (Cursor c = db.rawQuery(
                "SELECT number, title, html, text, words FROM chapters WHERE work_id = ?",
                new String[]{ workId })) {
            while (c.moveToNext()) {
                int number = c.getInt(0);
                String html = c.getString(2);
                String now_ = replacement.get(number);
                boolean gone = !replacement.containsKey(number);
                if (!gone && settled(html).equals(now_)) continue;   // unchanged

                android.content.ContentValues v = new android.content.ContentValues();
                v.put("work_id", workId);
                v.put("number", number);
                v.put("title", c.getString(1));
                v.put("html", html);
                v.put("text", c.getString(3));
                v.put("words", c.getInt(4));
                v.put("reason", gone ? "removed" : "content");
                v.put("archived_at", now);
                keep.add(v);
            }
        } catch (Exception e) {
            return 0;   // a library without the table is not worth failing over
        }

        int archived = 0;
        for (android.content.ContentValues v : keep) {
            try { db.insert("chapter_versions", null, v); archived++; } catch (Exception ignored) {}
        }
        return archived;
    }

    private static String errorJson(String message) {
        return "{\"error\":" + org.json.JSONObject.quote(String.valueOf(message)) + "}";
    }

    /**
     * One form submission, following the archive's redirect far enough to know
     * whether it worked.
     *
     * Rails answers a successful form with a 302 to the thing it created and a
     * failed one with a 200 that redisplays the form with errors, so the status
     * alone says almost nothing. Both the code and the landing page are handed
     * back for the page to judge.
     */
    private String postOnce(URL u, String body, String referer) throws IOException {
        HttpURLConnection c = open(u);
        c.setRequestMethod("POST");
        c.setDoOutput(true);
        c.setRequestProperty("Content-Type", "application/x-www-form-urlencoded; charset=UTF-8");
        c.setRequestProperty("Accept", "text/html, application/xhtml+xml");
        // Rails checks this on non-GET requests; without it the token is rejected
        if (referer != null && !referer.isEmpty()) c.setRequestProperty("Referer", referer);
        c.setRequestProperty("Origin", "https://archiveofourown.org");

        byte[] out = body.getBytes("UTF-8");
        c.setFixedLengthStreamingMode(out.length);
        try (OutputStream os = c.getOutputStream()) { os.write(out); }

        int status = c.getResponseCode();
        String location = c.getHeaderField("Location");
        String text = readBody(c);
        c.disconnect();

        /* A redirect is the usual answer to a form that worked, and where it
           points is often the only confirmation there is. It is followed once,
           with a GET, so the page can see what was made. */
        if ((status == 302 || status == 303 || status == 301) && location != null) {
            try {
                /* Where a redirect points is chosen by the response, not by
                   us. It is resolved, checked, and then rebuilt from its path
                   onto the constant host — so even a redirect cannot move a
                   signed-in request to another server. */
                URL resolved = new URL(u, location);
                if (!isArchiveHost(resolved.getHost())) throw new IOException("redirected off the archive");
                URL next = archiveUrl(resolved.getFile());
                if (next == null) throw new IOException("redirected somewhere unusable");
                HttpURLConnection follow = open(next);
                status = follow.getResponseCode();
                text = readBody(follow);
                follow.disconnect();
            } catch (Exception ignored) {
                // the write may well have succeeded; the page judges on location
            }
        }

        org.json.JSONObject res = new org.json.JSONObject();
        try {
            res.put("status", status);
            res.put("location", location == null ? org.json.JSONObject.NULL : location);
            res.put("body", text);
        } catch (org.json.JSONException e) {
            return errorJson("could not describe the response");
        }
        return res.toString();
    }

    private static String readBody(HttpURLConnection c) throws IOException {
        int code = c.getResponseCode();
        InputStream in = code >= 400 ? c.getErrorStream() : c.getInputStream();
        if (in == null) return "";
        java.io.ByteArrayOutputStream buf = new java.io.ByteArrayOutputStream();
        byte[] chunk = new byte[1 << 14];
        int read;
        while ((read = in.read(chunk)) > 0) buf.write(chunk, 0, read);
        return buf.toString("UTF-8");
    }

    /* The last archive page asked for, used as the referer for the next.
       Somebody on page seven got there from page six; arriving with no referer
       at all, page after page, is not what browsing looks like. */
    private String lastArchiveUrl = null;

    /**
     * Ask the way a browser asks.
     *
     * This sent a Chrome user agent and nothing else — no Accept, no
     * Accept-Language, none of the Sec-Fetch headers every browser sends on a
     * navigation. Claiming to be a browser and then not behaving like one is a
     * plain bot signature, and the archive sits behind Cloudflare. The same
     * account walking the same pages from a laptop, sending the full set, ran
     * hundreds of requests without being throttled once; the app was getting
     * 5xx almost immediately.
     *
     * Accept-Encoding is deliberately absent. Java adds gzip itself and
     * decompresses transparently — but only while nothing has set the header
     * by hand, and setting it means getting raw compressed bytes back.
     */
    private void browserHeaders(HttpURLConnection c, boolean sameOrigin) {
        c.setRequestProperty("User-Agent", WebSettings.getDefaultUserAgent(this));
        c.setRequestProperty("Accept",
            "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8");
        c.setRequestProperty("Accept-Language", "en-GB,en;q=0.9");
        c.setRequestProperty("Upgrade-Insecure-Requests", "1");
        c.setRequestProperty("Sec-Fetch-Dest", "document");
        c.setRequestProperty("Sec-Fetch-Mode", "navigate");
        c.setRequestProperty("Sec-Fetch-Site", sameOrigin ? "same-origin" : "none");
        c.setRequestProperty("Sec-Fetch-User", "?1");
    }

    private HttpURLConnection open(URL u) throws IOException {
        HttpURLConnection c = (HttpURLConnection) u.openConnection();
        c.setInstanceFollowRedirects(false);
        c.setConnectTimeout(20000);
        c.setReadTimeout(30000);
        boolean archive = isArchiveHost(u.getHost());
        browserHeaders(c, archive && lastArchiveUrl != null);
        if (archive && lastArchiveUrl != null) c.setRequestProperty("Referer", lastArchiveUrl);
        // the session travels only to the archive, never to the font host —
        // and never to a domain that merely ends with the archive's name
        if (archive) {
            String cookies = archiveCookies();
            if (!cookies.isEmpty()) c.setRequestProperty("Cookie", cookies);
            lastArchiveUrl = u.toString();
        }
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
            b.append(",\"signedIn\":").append(isSignedIn());
            b.append(",\"path\":").append(quote(databaseFile().getPath()));
            /* What this APK actually is, rather than what some constant in the
               page last remembered. The page displayed v0.15.0 while running
               v0.19.0, because the number was written down in a third place
               and only sometimes updated. */
            b.append(",\"version\":").append(quote(versionName()));
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

            /*
             * The page composes its own queries, so this is the boundary that
             * decides what it may ask for. Reading only is the point; these
             * checks make "reading only" hard to talk your way around.
             *
             * A statement separator would allow a second statement to ride
             * along behind the SELECT, and a comment marker can hide the rest
             * of a line from a reader while SQLite still executes it. Neither
             * appears in any query this app makes.
             */
            if (!trimmed.regionMatches(true, 0, "SELECT", 0, 6)
                    && !trimmed.regionMatches(true, 0, "WITH", 0, 4)) {
                return "{\"error\":\"read-only\"}";
            }
            if (trimmed.length() > 8000) return "{\"error\":\"query too long\"}";
            if (trimmed.indexOf(';') >= 0) return "{\"error\":\"one statement only\"}";
            if (trimmed.contains("--") || trimmed.contains("/*")) {
                return "{\"error\":\"comments are not allowed in a query\"}";
            }
            if (PRAGMA_OR_ATTACH.matcher(trimmed).find()) {
                return "{\"error\":\"not a read of this archive\"}";
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
        /**
         * A tick at the moment something commits.
         *
         * performHapticFeedback rather than the vibrator: it goes through the
         * system's own haptic setting, so someone who has turned haptics off
         * on their phone gets nothing without the app having to ask, and it
         * uses whatever the device's actuator does well rather than a
         * duration we guessed at.
         *
         * Haptics reinforce a commitment that is already visible. They are not
         * the feedback — a buzz over a screen that did not move still feels
         * wrong.
         */
        @JavascriptInterface
        public void haptic(final String kind) {
            mustBeOurPage();
            if (web == null) return;
            runOnUiThread(new Runnable() { @Override public void run() {
                int effect = android.view.HapticFeedbackConstants.CONTEXT_CLICK;
                if ("commit".equals(kind)) {
                    effect = Build.VERSION.SDK_INT >= 30
                        ? android.view.HapticFeedbackConstants.CONFIRM
                        : android.view.HapticFeedbackConstants.KEYBOARD_TAP;
                } else if ("reject".equals(kind)) {
                    effect = Build.VERSION.SDK_INT >= 30
                        ? android.view.HapticFeedbackConstants.REJECT
                        : android.view.HapticFeedbackConstants.LONG_PRESS;
                }
                try { web.performHapticFeedback(effect); } catch (Exception ignored) {}
            }});
        }

        /**
         * Send a form to the archive.
         *
         * Leaving kudos, bookmarking and commenting are writes, and a write
         * cannot go through /__net/ at all: shouldInterceptRequest is never
         * given a request body, so the proxy the rest of the app uses can only
         * ever perform a GET. This is the narrowest thing that does the job —
         * one host, one method, a body the page has already built from a form
         * the archive itself served.
         *
         * The session cookie goes with it, which is the entire point: these
         * act as the signed-in reader. Nothing else may call it, and nothing
         * but the archive may receive it.
         */
        @JavascriptInterface
        public String archivePost(String path, String body, String refererPath) {
            mustBeOurPage();
            try {
                /* The page supplies a path, never a URL. There is deliberately
                   no way for it to name a host: the host is a constant here, so
                   no value crossing the bridge can decide where a signed-in
                   write is sent. Checking a caller-supplied URL and hoping the
                   check is airtight is the weaker arrangement, and it is the
                   one CodeQL objected to. */
                URL u = archiveUrl(path);
                if (u == null) return errorJson("that is not a path on the archive");
                String referer = ARCHIVE + (refererPath == null ? "/" : safePath(refererPath));
                return postOnce(u, body == null ? "" : body, referer);
            } catch (Exception e) {
                return errorJson(String.valueOf(e.getMessage()));
            }
        }

        /**
         * Record something the reader did on the archive.
         *
         * Narrow on purpose. The read bridge refuses anything that is not a
         * SELECT, and this is the write counterpart: a fixed set of columns, a
         * value coerced to 0 or 1, and the work id bound rather than pasted.
         * There is no general-purpose write here and there should not be.
         */
        @JavascriptInterface
        public String markWork(String workId, String field, boolean on) {
            mustBeOurPage();
            if (db == null) return errorJson("no library open");
            if (!"in_bookmarks".equals(field) && !"rec".equals(field)
                    && !"kudos_given".equals(field)) {
                return errorJson("that is not a field this can set");
            }
            try {
                android.content.ContentValues v = new android.content.ContentValues();
                v.put(field, on ? 1 : 0);
                int rows = db.update("works", v, "work_id = ?", new String[]{ workId });
                return "{\"updated\":" + rows + "}";
            } catch (Exception e) {
                return errorJson(String.valueOf(e.getMessage()));
            }
        }

        /**
         * Open a page on the archive in a real browser.
         *
         * The app now claims archive links, so an ordinary ACTION_VIEW would
         * be offered straight back to this app — the reader would tap "open on
         * the archive" and arrive exactly where they already were. The chooser
         * is told to exclude us, so what opens is a browser.
         *
         * The host is a constant here for the same reason it is on the write
         * path: nothing crossing the bridge decides where the reader is sent.
         */
        @JavascriptInterface
        public void openInBrowser(String path) {
            mustBeOurPage();
            final URL u = archiveUrl(path);
            if (u == null) return;
            runOnUiThread(new Runnable() { @Override public void run() { toBrowser(u); } });
        }


        /**
         * Store a work the page has just fetched and parsed.
         *
         * The read bridge refuses anything that is not a SELECT, deliberately —
         * the page composing arbitrary SQL against a 600MB archive is a
         * capability worth not having. So writing is not opened up; instead the
         * page hands over a described work and this method writes it, in one
         * transaction, through statements it controls.
         *
         * The search index is updated for this work alone. Rebuilding it means
         * reindexing forty million words, which is not something to do because
         * somebody pasted a link.
         */
        /**
         * Hold the screen on while a chapter is open.
         *
         * Deleted once by an edit that replaced the span of code it sat in —
         * the same way markWork was — and unnoticed because the test that
         * catches this only read api.js, while this one is called from app.js.
         */
        @JavascriptInterface
        public void keepAwake(final boolean on) {
            mustBeOurPage();
            runOnUiThread(new Runnable() { @Override public void run() {
                if (web == null) return;
                web.setKeepScreenOn(on);
            }});
        }

        /**
         * Record works a listing described, without their text.
         *
         * Cannot damage anything by construction: a work already held is left
         * exactly as it is, because a blurb knows less than the work page a
         * held copy came from. Only rows that do not exist are written, with
         * has_text at 0, so the app knows the chapters are still to come.
         */
        @JavascriptInterface
        public String saveStubs(String json) {
            mustBeOurPage();
            if (db == null) return errorJson("no library open");
            int added = 0;
            try {
                org.json.JSONArray works = new org.json.JSONArray(json);
                db.beginTransaction();
                try {
                    for (int i = 0; i < works.length(); i++) {
                        org.json.JSONObject b = works.getJSONObject(i);
                        String id = b.optString("workId", "");
                        if (id.isEmpty()) continue;

                        android.content.ContentValues v = new android.content.ContentValues();
                        v.put("work_id", id);
                        v.put("title", b.optString("title", null));
                        v.put("authors", b.optString("authors", "[]"));
                        v.put("summary", b.optString("summary", null));
                        v.put("rating", b.optString("rating", null));
                        v.put("language", b.optString("language", null));
                        v.put("complete", b.optBoolean("complete") ? 1 : 0);
                        v.put("words", b.optInt("words"));
                        v.put("chapter_count", b.optInt("chapters"));
                        /* How many the author says there will be. Without it a
                           finished one-chapter work reads "1/?", which says
                           the archive does not know — when the listing had
                           just told us. */
                        if (b.isNull("chaptersPlanned")) v.putNull("chapters_planned");
                        else v.put("chapters_planned", b.optInt("chaptersPlanned"));
                        v.put("kudos", b.optInt("kudos"));
                        v.put("bookmark_count", b.optInt("bookmarkCount"));
                        v.put("hits", b.optInt("hits"));
                        v.put("source", "listing");
                        v.put("has_text", 0);

                        long row = db.insertWithOnConflict("works", null, v,
                                SQLiteDatabase.CONFLICT_IGNORE);
                        if (row == -1) continue;      // already held, and left alone
                        added++;

                        org.json.JSONObject tags = b.optJSONObject("tags");
                        java.util.Iterator<String> kinds = tags == null ? null : tags.keys();
                        while (kinds != null && kinds.hasNext()) {
                            String kind = kinds.next();
                            org.json.JSONArray names = tags.optJSONArray(kind);
                            for (int t = 0; names != null && t < names.length(); t++) {
                                android.content.ContentValues tag = new android.content.ContentValues();
                                tag.put("work_id", id);
                                tag.put("kind", kind);
                                tag.put("name", names.getString(t));
                                db.insertWithOnConflict("tags", null, tag, SQLiteDatabase.CONFLICT_IGNORE);
                            }
                        }
                    }
                    db.setTransactionSuccessful();
                } finally {
                    db.endTransaction();
                }
            } catch (Exception e) {
                return errorJson(String.valueOf(e.getMessage()));
            }
            return "{\"added\":" + added + "}";
        }

        @JavascriptInterface
        public String saveWork(String json) {
            mustBeOurPage();
            if (db == null) return "{\"error\":\"no database\"}";
            try {
                org.json.JSONObject w = new org.json.JSONObject(json);
                String id = w.getString("workId");
                db.beginTransaction();
                try {
                    writeWork(w, id);
                    db.setTransactionSuccessful();
                } finally {
                    db.endTransaction();
                }
                return "{\"ok\":true,\"workId\":" + quote(id) + "}";
            } catch (Exception e) {
                return "{\"error\":" + quote(String.valueOf(e.getMessage())) + "}";
            }
        }

        /**
         * Where the reader has got to in a work.
         *
         * Reading position used to live in the page's localStorage while every
         * other view — Home, Continue reading, the finished count, the
         * progress filters — read the database. They disagreed the moment
         * anything was read: the work knew you were on chapter eight, and Home
         * still called it unopened. One place owns this now.
         *
         * Chapters before the current one count as read, which is monotonic
         * and cannot go backwards if somebody flicks to an earlier chapter.
         */
        @JavascriptInterface
        public String saveProgress(String workId, int chapter, double offset) {
            mustBeOurPage();
            if (db == null) return "{\"error\":\"no database\"}";
            try {
                db.execSQL(
                    "INSERT INTO reading (work_id, chapter, offset, chapters_read, updated_at) "
                  + "VALUES (?,?,?,?,datetime('now')) "
                  + "ON CONFLICT(work_id) DO UPDATE SET "
                  + "  chapter = excluded.chapter, "
                  + "  offset = excluded.offset, "
                  + "  chapters_read = max(COALESCE(reading.chapters_read, 0), excluded.chapters_read), "
                  + "  updated_at = excluded.updated_at",
                    new Object[]{ workId, chapter, offset, Math.max(0, chapter - 1) });
                return "{\"ok\":true}";
            } catch (Exception e) {
                return "{\"error\":" + quote(String.valueOf(e.getMessage())) + "}";
            }
        }

        /** Store one image the page fetched, addressed by its own content hash. */
        @JavascriptInterface
        public String saveImage(String workId, String url, String base64, String mime) {
            mustBeOurPage();
            if (db == null) return "{\"error\":\"no database\"}";
            try {
                byte[] bytes = android.util.Base64.decode(base64, android.util.Base64.DEFAULT);
                java.security.MessageDigest md = java.security.MessageDigest.getInstance("SHA-256");
                StringBuilder hex = new StringBuilder();
                for (byte b : md.digest(bytes)) hex.append(String.format("%02x", b));
                android.content.ContentValues v = new android.content.ContentValues();
                v.put("work_id", workId);
                v.put("url", url);
                v.put("sha256", hex.toString());
                v.put("mime", mime);
                v.put("bytes", bytes);
                v.put("status", "stored");
                db.insertWithOnConflict("images", null, v, SQLiteDatabase.CONFLICT_REPLACE);
                return "{\"ok\":true,\"sha256\":" + quote(hex.toString()) + "}";
            } catch (Exception e) {
                return "{\"error\":" + quote(String.valueOf(e.getMessage())) + "}";
            }
        }

        /**
         * The page is ready. Hand over anything that arrived before it was.
         */
        @JavascriptInterface
        public String takePendingLink() {
            mustBeOurPage();
            String link = pendingLink;
            pendingLink = null;
            return link == null ? "" : link;
        }

        /** Open the archive's login page. */
        @JavascriptInterface
        public void signIn() {
            mustBeOurPage();
            runOnUiThread(new Runnable() {
                @Override public void run() { openSignIn(); }
            });
        }

        /** Forget the session. The archive still has it until it expires there. */
        @JavascriptInterface
        public void signOut() {
            mustBeOurPage();
            runOnUiThread(new Runnable() {
                @Override public void run() {
                    android.webkit.CookieManager.getInstance().removeAllCookies(null);
                    android.webkit.CookieManager.getInstance().flush();
                }
            });
        }

        @JavascriptInterface
        public boolean signedIn() {
            mustBeOurPage();
            return isSignedIn();
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

        /**
         * Write the whole library somewhere the reader chooses.
         *
         * Everything the app holds — the works, the chapters, the reading
         * positions, the search index — is that one file, and until now there
         * was no way to get a copy of it off the phone. A library assembled
         * over months with no way to back it up is a library waiting to be
         * lost.
         */
        @JavascriptInterface
        public void exportDatabase() {
            mustBeOurPage();
            Intent save = new Intent(Intent.ACTION_CREATE_DOCUMENT);
            save.addCategory(Intent.CATEGORY_OPENABLE);
            save.setType("application/octet-stream");
            save.putExtra(Intent.EXTRA_TITLE, "fanfolio-" + today() + ".db");
            try { startActivityForResult(save, SAVE_DATABASE); } catch (Exception ignored) {}
        }

        /** Bytes on disk, so the page can say what a backup will cost. */
        @JavascriptInterface
        public long databaseSize() {
            mustBeOurPage();
            File f = databaseFile();
            return f.exists() ? f.length() : 0L;
        }
    }

    /** The work row, its tags, its chapters and their index entries. */
    private void writeWork(org.json.JSONObject w, String id) throws org.json.JSONException {
        android.content.ContentValues work = new android.content.ContentValues();
        work.put("work_id", id);
        for (String key : new String[]{ "title", "authors", "summary", "rating", "language",
                "published", "updated", "skin_css" }) {
            if (w.isNull(key)) work.putNull(key); else work.put(key, w.getString(key));
        }
        work.put("complete", w.optBoolean("complete") ? 1 : 0);
        work.put("words", w.optInt("words"));
        work.put("chapter_count", w.optJSONArray("chapters") == null ? 0 : w.getJSONArray("chapters").length());
        if (w.isNull("chaptersPlanned")) work.putNull("chapters_planned");
        else work.put("chapters_planned", w.optInt("chaptersPlanned"));
        /* What the archive says about a work's reception. Absent on an older
           page, so each is stored only when it is there rather than as a zero
           that would rank a work below every work we have never counted. */
        for (String[] pair : new String[][]{
                { "kudos", "kudos" }, { "bookmarkCount", "bookmark_count" }, { "hits", "hits" } }) {
            if (w.isNull(pair[0])) work.putNull(pair[1]);
            else work.put(pair[1], w.optInt(pair[0]));
        }
        work.put("source", "ao3");
        work.put("fetched_at", nowIso());
        /* When this copy was taken. Without it the sync planner has no idea
           how current our copy is, and "recently added" cannot see the work
           at all. */
        work.put("downloaded_at", nowIso().substring(0, 10));
        work.put("has_text", 1);   // chapters follow, below
        db.insertWithOnConflict("works", null, work, SQLiteDatabase.CONFLICT_REPLACE);

        db.delete("tags", "work_id = ?", new String[]{ id });
        org.json.JSONObject tags = w.optJSONObject("tags");
        StringBuilder allTags = new StringBuilder();
        if (tags != null) {
            java.util.Iterator<String> kinds = tags.keys();
            while (kinds.hasNext()) {
                String kind = kinds.next();
                org.json.JSONArray names = tags.getJSONArray(kind);
                for (int i = 0; i < names.length(); i++) {
                    android.content.ContentValues t = new android.content.ContentValues();
                    t.put("work_id", id);
                    t.put("kind", kind);
                    t.put("name", names.getString(i));
                    db.insertWithOnConflict("tags", null, t, SQLiteDatabase.CONFLICT_IGNORE);
                    if (allTags.length() > 0) allTags.append(", ");
                    allTags.append(names.getString(i));
                }
            }
        }

        org.json.JSONArray chapters = w.optJSONArray("chapters");

        /* Keep what is about to be replaced.
         *
         * The development server has archived replaced chapters since
         * versioning went in; this path never did, and deleted them outright.
         * A work fetched again on the phone therefore lost whatever the author
         * had changed — silently, and with the app claiming the opposite.
         *
         * An author who consolidates forty-four chapters into one is not
         * deleting the work, but the chaptering is gone either way, and the
         * copy that is on the device is the only record of what it used to be.
         */
        archiveChapters(id, chapters);

        /* Index entries are keyed on the chapter's rowid, so the old ones have
           to go before the rows they point at do. */
        try (Cursor c = db.rawQuery("SELECT id FROM chapters WHERE work_id = ?", new String[]{ id })) {
            while (c.moveToNext()) {
                db.delete("chapter_fts", "rowid = ?", new String[]{ String.valueOf(c.getLong(0)) });
            }
        }
        db.delete("chapters", "work_id = ?", new String[]{ id });

        for (int i = 0; chapters != null && i < chapters.length(); i++) {
            org.json.JSONObject ch = chapters.getJSONObject(i);
            android.content.ContentValues row = new android.content.ContentValues();
            row.put("work_id", id);
            row.put("number", i + 1);
            if (ch.isNull("title")) row.putNull("title"); else row.put("title", ch.getString("title"));
            row.put("html", ch.optString("html"));
            row.put("text", ch.optString("text"));
            row.put("words", ch.optInt("words"));
            long rowid = db.insertWithOnConflict("chapters", null, row, SQLiteDatabase.CONFLICT_REPLACE);

            // external-content FTS4 takes rowid, not docid, on a direct insert
            android.content.ContentValues indexed = new android.content.ContentValues();
            indexed.put("rowid", rowid);
            indexed.put("text", ch.optString("text"));
            db.insertWithOnConflict("chapter_fts", null, indexed, SQLiteDatabase.CONFLICT_REPLACE);
        }

        db.delete("work_fts", "work_id = ?", new String[]{ id });
        android.content.ContentValues meta = new android.content.ContentValues();
        meta.put("work_id", id);
        meta.put("title", w.optString("title"));
        meta.put("authors", w.optString("authors"));
        meta.put("summary", w.optString("summary"));
        meta.put("tags", allTags.toString());
        db.insertWithOnConflict("work_fts", null, meta, SQLiteDatabase.CONFLICT_REPLACE);
    }

    private static String nowIso() {
        return new java.text.SimpleDateFormat("yyyy-MM-dd HH:mm:ss", java.util.Locale.UK)
            .format(new java.util.Date());
    }

    private static String today() {
        return new java.text.SimpleDateFormat("yyyy-MM-dd", java.util.Locale.US)
            .format(new java.util.Date());
    }

    /**
     * Copy the library out to the document the reader picked.
     *
     * The database runs in WAL mode, so it is really several files: copying
     * archive.db alone silently drops whatever the write-ahead log still
     * holds, which is the most recent reading of all. Checkpointing first
     * folds the log back into the file being copied.
     */
    private void saveDatabaseTo(Uri target) {
        try {
            if (db != null) db.execSQL("PRAGMA wal_checkpoint(TRUNCATE)");
        } catch (Exception ignored) {
            // an un-checkpointable database still copies; it just may lag
        }
        boolean ok = true;
        try (InputStream in = new java.io.FileInputStream(databaseFile());
             OutputStream out = getContentResolver().openOutputStream(target)) {
            byte[] buf = new byte[1 << 16];
            int read;
            while ((read = in.read(buf)) > 0) out.write(buf, 0, read);
        } catch (Exception e) {
            ok = false;
        }
        final String js = ok ? "window.__backupDone && window.__backupDone()"
                             : "window.__backupFailed && window.__backupFailed()";
        runOnUiThread(new Runnable() { @Override public void run() { toPage(js); } });
    }

    @Override protected void onActivityResult(int request, int result, Intent data) {
        super.onActivityResult(request, result, data);
        if (result != RESULT_OK || data == null || data.getData() == null) return;
        if (request == SAVE_DATABASE) { saveDatabaseTo(data.getData()); return; }
        if (request != PICK_DATABASE) return;
        importFrom(data.getData());
    }

    /**
     * Fold a chosen library into this one.
     *
     * This used to be a file copy: the chosen database was written straight
     * over ours. Nothing was read, so nothing could be versioned by it, and
     * everything that existed only here went with it — reading positions,
     * kudos left from the app, works added by pasting a link.
     *
     * With no library yet there is nothing to merge and the file simply becomes
     * the library. Otherwise it is attached and folded in by the same
     * statements the tests exercise, inside a transaction: a merge that cannot
     * finish leaves the library exactly as it was.
     */
    private void importFrom(Uri source) {
        File staged = new File(getFilesDir(), "incoming.db");
        try (InputStream in = getContentResolver().openInputStream(source);
             OutputStream out = new FileOutputStream(staged)) {
            byte[] buf = new byte[1 << 16];
            int read;
            while ((read = in.read(buf)) > 0) out.write(buf, 0, read);
        } catch (Exception e) {
            staged.delete();
            toPage("window.__importFailed && window.__importFailed('could not read that file')");
            return;
        }

        boolean first = db == null || !databaseFile().exists();
        if (first) {
            staged.renameTo(databaseFile());
            openDatabase();
            web.reload();
            return;
        }

        try {
            /* An older export may predate columns this one has, and the merge
               names them. Bringing the incoming copy up to the same shape first
               is cheaper than discovering it halfway through. */
            SQLiteDatabase incoming = SQLiteDatabase.openDatabase(staged.getPath(), null,
                    SQLiteDatabase.OPEN_READWRITE | SQLiteDatabase.NO_LOCALIZED_COLLATORS);
            migrate(incoming);
            incoming.close();

            String[] steps = readAsset("web/merge.sql").split("\n;;\n");
            db.execSQL("ATTACH DATABASE '" + staged.getPath().replace("'", "''") + "' AS incoming");
            db.beginTransaction();
            try {
                for (String step : steps) {
                    String sql = step.trim();
                    if (!sql.isEmpty()) db.execSQL(sql);
                }
                db.setTransactionSuccessful();
            } finally {
                db.endTransaction();
                try { db.execSQL("DETACH DATABASE incoming"); } catch (Exception ignored) {}
            }
        } catch (Exception e) {
            staged.delete();
            toPage("window.__importFailed && window.__importFailed("
                + org.json.JSONObject.quote(String.valueOf(e.getMessage())) + ")");
            return;
        }

        staged.delete();
        web.reload();
    }

    private String readAsset(String path) throws IOException {
        try (InputStream in = getAssets().open(path)) {
            java.io.ByteArrayOutputStream buf = new java.io.ByteArrayOutputStream();
            byte[] chunk = new byte[1 << 14];
            int read;
            while ((read = in.read(chunk)) > 0) buf.write(chunk, 0, read);
            return buf.toString("UTF-8");
        }
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
