package org.fanfolio;

import java.io.*;
import java.util.*;
import java.util.zip.*;
import okhttp3.*;

public class ArchiveHttpCheck {
    static final String URL = "https://archiveofourown.org/works/1?view_full_work=true";
    static final String HTML = "<html>saved chapter</html>";
    static void check(boolean value, String message) { if (!value) throw new AssertionError(message); }
    static Response response(Request request, int code, String encoding, byte[] bytes) {
        Response.Builder builder = new Response.Builder().request(request).protocol(Protocol.HTTP_2)
            .code(code).message("test").header("Content-Type", "text/html; charset=UTF-8")
            .body(ResponseBody.create(bytes, MediaType.get("text/html")));
        if (encoding != null) builder.header("Content-Encoding", encoding);
        return builder.build();
    }
    static class Jar implements ArchiveHttp.Cookies {
        final Map<String, String> values = new HashMap<>(); int updates;
        public String get(String url) { return values.get(url); }
        public void save(String url, List<String> cookies) {
            if (!cookies.isEmpty()) { updates++; values.put(url, cookies.get(0).split(";")[0]); }
        }
    }
    static ArchiveHttp transport(Interceptor exchange, Jar cookies) {
        return new ArchiveHttp(ArchiveHttp.client().newBuilder().addInterceptor(exchange).build(), cookies);
    }
    static byte[] compressed(boolean gzip) throws Exception {
        ByteArrayOutputStream bytes = new ByteArrayOutputStream();
        try (OutputStream stream = gzip ? new GZIPOutputStream(bytes) : new DeflaterOutputStream(bytes)) {
            stream.write(HTML.getBytes("UTF-8"));
        }
        return bytes.toByteArray();
    }
    public static void main(String[] args) throws Exception {
        OkHttpClient client = ArchiveHttp.client();
        check(client.protocols().contains(Protocol.HTTP_2), "HTTP/2 negotiated by the native client");
        check(client.connectTimeoutMillis() == 20000 && client.readTimeoutMillis() == 20000, "reference timeouts");
        check(!client.followRedirects() && !client.followSslRedirects() && client.retryOnConnectionFailure(), "checked redirects and reference connection recovery");
        Jar jar = new Jar(); jar.values.put(URL, "session=existing");
        int[] calls = {0};
        ArchiveHttp http = transport(chain -> {
            calls[0]++;
            Request r = chain.request();
            check(r.header("User-Agent").equals(ArchiveHttp.USER_AGENT), "Chrome Android UA");
            check(r.header("Accept").equals(ArchiveHttp.ACCEPT), "reference Accept");
            check(r.header("Accept-Language").equals("en-US,en;q=0.9"), "reference language");
            check(r.header("Accept-Encoding").equals("gzip, deflate, br"), "reference compression");
            check(r.header("Sec-Fetch-Mode") == null && r.header("Referer") == null, "no invented navigation metadata");
            check(r.header("Cookie").equals(calls[0] == 1 ? "session=existing" : "session=renewed"), "response cookies used on next request");
            return response(r, 200, null, HTML.getBytes("UTF-8")).newBuilder()
                .addHeader("Set-Cookie", "session=renewed; Path=/; Secure").build();
        }, jar);
        check(http.get(URL).text().equals(HTML), "normal page"); http.get(URL);
        check(jar.updates == 2 && calls[0] == 2, "one request per fetch with cookie rotation");
        String[] encodings = {"gzip", "deflate", "br"};
        byte[][] bodies = {compressed(true), compressed(false), Base64.getDecoder().decode(args[0])};
        for (int i = 0; i < encodings.length; i++) {
            final String encoding = encodings[i]; final byte[] bytes = bodies[i];
            ArchiveHttp decoder = transport(c -> response(c.request(), 200, encoding, bytes), new Jar());
            check(decoder.get(URL).text().equals(HTML), encoding + " decoded before parsing");
        }
        calls[0] = 0;
        ArchiveHttp failed = transport(c -> {
            calls[0]++;
            return response(c.request(), 525, null, "origin handshake failed".getBytes("UTF-8"));
        }, new Jar());
        check(failed.get(URL).status == 525 && calls[0] == 1, "525 is preserved without rapid retry");
        calls[0] = 0;
        ArchiveHttp limited = transport(c -> {
            calls[0]++;
            return response(c.request(), 429, null, new byte[0]).newBuilder()
                .header("Retry-After", "1800").header("Set-Cookie", "session=private").build();
        }, new Jar());
        ArchiveHttp.Page limit = limited.get(URL);
        check(limit.status == 429 && "1800".equals(limit.headers.get("Retry-After")) && calls[0] == 1, "rate limit metadata survives");
        check(!limit.headers.containsKey("Set-Cookie"), "cookies never cross the page bridge");
        calls[0] = 0;
        Jar redirects = new Jar();
        ArchiveHttp redirect = transport(c -> {
            calls[0]++;
            if (calls[0] == 1) return response(c.request(), 302, null, new byte[0]).newBuilder()
                .header("Location", URL).header("Set-Cookie", "session=redirected").build();
            check("session=redirected".equals(c.request().header("Cookie")), "redirect sets cookie before follow");
            return response(c.request(), 200, null, HTML.getBytes("UTF-8"));
        }, redirects);
        check(redirect.get(URL).status == 200 && calls[0] == 2, "redirect followed");
        for (String target : new String[]{"https://evilarchiveofourown.org/", "http://archiveofourown.org/", "https://archiveofourown.org:444/", "https://user:pass@archiveofourown.org/"}) {
            calls[0] = 0;
            ArchiveHttp unsafe = transport(c -> {
                calls[0]++;
                return response(c.request(), 302, null, new byte[0]).newBuilder().header("Location", target).build();
            }, new Jar());
            try { unsafe.get(URL); throw new AssertionError("accepted unsafe redirect"); } catch (IOException expected) {}
            check(calls[0] == 1, "unsafe redirect never requested");
        }
        calls[0] = 0;
        ArchiveHttp loop = transport(c -> {
            calls[0]++; return response(c.request(), 302, null, new byte[0]).newBuilder().header("Location", URL).build();
        }, new Jar());
        try { loop.get(URL); throw new AssertionError("unbounded redirects"); } catch (IOException expected) {}
        check(calls[0] == 6, "redirect limit");
        calls[0] = 0;
        ArchiveHttp write = transport(c -> {
            calls[0]++; check(c.request().method().equals("POST"), "form method");
            check(URL.equals(c.request().header("Referer")), "form referer preserved");
            check("https://archiveofourown.org".equals(c.request().header("Origin")), "CSRF origin");
            return response(c.request(), 302, null, new byte[0]).newBuilder().header("Location", "/bookmarks/1").build();
        }, new Jar());
        check(write.post(URL, "notes=synthetic", URL).status == 302 && calls[0] == 1, "POST never replayed on redirect");
        calls[0] = 0;
        ArchiveHttp network = transport(c -> { calls[0]++; throw new IOException("synthetic offline"); }, new Jar());
        try { network.get(URL); throw new AssertionError("missing network error"); } catch (IOException expected) {}
        check(calls[0] == 1, "network errors return to paced caller");
        System.out.println("Archive HTTP checks passed");
    }
}
