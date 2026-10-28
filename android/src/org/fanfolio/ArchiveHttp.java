package org.fanfolio;

import java.io.*;
import java.util.*;
import java.util.concurrent.TimeUnit;
import java.util.zip.GZIPInputStream;
import java.util.zip.InflaterInputStream;
import okhttp3.*;
import org.brotli.dec.BrotliInputStream;

/** Archive HTTP runs on the native worker, including while the screen is closed. */
final class ArchiveHttp {
    static final String USER_AGENT = "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.6099.144 Mobile Safari/537.36";
    static final String ACCEPT = "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3";
    static final int MAX_BODY = 64 * 1024 * 1024;

    interface Cookies {
        String get(String url);
        void save(String url, List<String> values);
    }

    static final class Page {
        final int status;
        final String location, type;
        final Map<String, String> headers = new HashMap<>();
        final byte[] body;
        Page(Response response, byte[] bytes) {
            status = response.code();
            location = response.header("Location");
            type = response.header("Content-Type", "text/html").split(";")[0].trim();
            for (String name : new String[]{"Retry-After", "CF-Mitigated"}) {
                String value = response.header(name);
                if (value != null) headers.put(name, value);
            }
            body = bytes;
        }
        String text() throws UnsupportedEncodingException { return new String(body, "UTF-8"); }
    }

    private final OkHttpClient client;
    private final Cookies cookies;

    static OkHttpClient client() {
        // The reference Android handler uses a persistent OkHttp client, with
        // 20-second connect/read timeouts and no HTTPS-to-HTTP redirects.
        // Follow redirects here so every destination is checked and gets its
        // own scoped cookies. Keep OkHttp's default connection recovery for
        // reads (for example, a stale pooled connection), as the reference does.
        return new OkHttpClient.Builder()
            .connectTimeout(20, TimeUnit.SECONDS).readTimeout(20, TimeUnit.SECONDS)
            .callTimeout(60, TimeUnit.SECONDS)
            .followRedirects(false).followSslRedirects(false)
            .build();
    }

    ArchiveHttp(Cookies cookies) { this(client(), cookies); }
    ArchiveHttp(OkHttpClient client, Cookies cookies) { this.client = client; this.cookies = cookies; }

    static HttpUrl checked(String url) throws IOException {
        HttpUrl parsed = HttpUrl.parse(url);
        if (parsed == null || !parsed.isHttps() || parsed.port() != 443
                || !parsed.username().isEmpty() || !parsed.password().isEmpty()
                || !(parsed.host().equals("archiveofourown.org") || parsed.host().endsWith(".archiveofourown.org")))
            throw new IOException("Not an archive URL");
        return parsed;
    }

    Page get(String url) throws IOException { return request(url, null, null); }
    Page post(String url, String form, String referer) throws IOException { return request(url, form, referer); }

    private Page request(String raw, String form, String referer) throws IOException {
        HttpUrl url = checked(raw);
        for (int hop = 0; hop <= 5; hop++) {
            Request.Builder request = new Request.Builder().url(url)
                .header("User-Agent", USER_AGENT).header("Accept", ACCEPT)
                .header("Accept-Language", "en-US,en;q=0.9")
                .header("Accept-Encoding", "gzip, deflate, br")
                .header("Upgrade-Insecure-Requests", "1");
            // Host/:authority comes from the actual URL, including redirects.
            // No invented Sec-Fetch fields or unrelated previous-page Referer.
            String cookie = cookies.get(url.toString());
            if (cookie != null && !cookie.isEmpty()) request.header("Cookie", cookie);
            if (form != null) {
                request.post(RequestBody.create(form, MediaType.get("application/x-www-form-urlencoded; charset=UTF-8")));
                request.header("Origin", "https://archiveofourown.org");
                if (referer != null && !referer.isEmpty()) request.header("Referer", checked(referer).toString());
            }
            // Writes must not be replayed when the connection fails after the
            // archive may already have accepted the form.
            OkHttpClient sender = form == null ? client : client.newBuilder().retryOnConnectionFailure(false).build();
            try (Response response = sender.newCall(request.build()).execute()) {
                cookies.save(url.toString(), response.headers("Set-Cookie"));
                int status = response.code();
                if (form == null && (status == 301 || status == 302 || status == 303 || status == 307 || status == 308)) {
                    String location = response.header("Location");
                    HttpUrl next = location == null ? null : url.resolve(location);
                    if (next == null) throw new IOException("Redirect without a valid location");
                    url = checked(next.toString());
                    continue;
                }
                return new Page(response, read(response));
            }
        }
        throw new IOException("Too many archive redirects");
    }

    private static byte[] read(Response response) throws IOException {
        if (response.body() == null) return new byte[0];
        InputStream in = response.body().byteStream();
        String coding = response.header("Content-Encoding", "").trim().toLowerCase(Locale.ROOT);
        if (coding.equals("gzip")) in = new GZIPInputStream(in);
        else if (coding.equals("deflate")) in = new InflaterInputStream(in);
        else if (coding.equals("br")) in = new BrotliInputStream(in);
        else if (!coding.isEmpty() && !coding.equals("identity")) throw new IOException("Unsupported archive response encoding");
        try (InputStream decoded = in; ByteArrayOutputStream bytes = new ByteArrayOutputStream()) {
            byte[] buffer = new byte[16384];
            int n;
            while ((n = decoded.read(buffer)) != -1) {
                if (bytes.size() + n > MAX_BODY) throw new IOException("Archive response is too large");
                bytes.write(buffer, 0, n);
            }
            return bytes.toByteArray();
        }
    }
}
