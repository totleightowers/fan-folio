package org.fanfolio;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.security.MessageDigest;
import java.util.Locale;

/** Image-only transport. Archive cookies and reading-page referrers never enter it. */
final class ImageFetcher {
    static final int MAX_BYTES = 12 * 1024 * 1024;
    static final String PROXY_HOST = "rimgo.nohost.network";
    // Imgur's UK block and deleted-image PNGs, observed 2026-09-22.
    static final String REGION_IMAGE = "faa24ec881e6040655c187a681d6dc496eb8aa41e1bd0652a180b3a40b457187";
    static final String REMOVED_IMAGE = "9b5936f4006146e4e1e9025b474c02863c0b5614132ad40db4b925a10e8bfbb9";
    interface Connections { HttpURLConnection open(URL url) throws IOException; }
    private final Connections connections;
    private final String userAgent;

    ImageFetcher(Connections connections, String userAgent) {
        this.connections = connections;
        this.userAgent = userAgent;
    }

    static final class Picture {
        final byte[] bytes;
        final String mime, sha256;
        final boolean proxied;
        Picture(byte[] bytes, String mime, String sha256, boolean proxied) {
            this.bytes = bytes; this.mime = mime; this.sha256 = sha256; this.proxied = proxied;
        }
    }

    static boolean isImgur(URL url) {
        String host = url.getHost().toLowerCase(Locale.ROOT);
        return host.equals("i.imgur.com") || host.equals("imgur.com") || host.equals("www.imgur.com");
    }

    static URL imgurImage(URL url) throws IOException {
        if (!isImgur(url) || url.getUserInfo() != null || (url.getPort() != -1 && url.getPort() != 443)
                || !(url.getProtocol().equalsIgnoreCase("https") || url.getProtocol().equalsIgnoreCase("http"))) return null;
        // Only a single image ID is shared. Never proxy galleries, credentials or query parameters.
        if (!url.getPath().matches("/[A-Za-z0-9]{5,12}\\.(?i:png|jpe?g|gif|webp|avif)")) return null;
        return new URL("https://i.imgur.com" + url.getPath());
    }

    static boolean placeholder(String sha) {
        return REGION_IMAGE.equals(sha) || REMOVED_IMAGE.equals(sha);
    }

    Picture fetch(String source, boolean allowProxy) throws IOException {
        URL original = new URL(source);
        URL imgur = imgurImage(original);
        URL target = imgur == null ? original : imgur;
        try {
            return request(target, false);
        } catch (IOException direct) {
            if (!allowProxy || imgur == null) throw direct;
            try { return request(new URL("https://" + PROXY_HOST + imgur.getPath()), true); }
            catch (IOException proxy) {
                throw new IOException("Imgur image unavailable; proxy: " + proxy.getMessage(), proxy);
            }
        }
    }

    private Picture request(URL target, boolean proxied) throws IOException {
        long started = System.nanoTime();
        for (int hop = 0; hop < 5; hop++) {
            if (System.nanoTime() - started > 30000000000L) throw new IOException("Image download timed out");
            if (!target.getProtocol().equalsIgnoreCase("https") || target.getUserInfo() != null
                    || (target.getPort() != -1 && target.getPort() != 443)) throw new IOException("HTTPS image required");
            if (proxied && !target.getHost().equalsIgnoreCase(PROXY_HOST)) throw new IOException("Proxy redirected outside its host");
            if (isImgur(target) && target.getPath().equalsIgnoreCase("/removed.png")) throw new IOException("Image removed from Imgur");
            HttpURLConnection c = connections.open(target);
            try {
                c.setInstanceFollowRedirects(false);
                c.setConnectTimeout(10000); c.setReadTimeout(15000);
                c.setRequestProperty("User-Agent", userAgent);
                c.setRequestProperty("Accept", "image/avif,image/webp,image/*;q=0.8");
                int status = c.getResponseCode();
                if (status == 301 || status == 302 || status == 303 || status == 307 || status == 308) {
                    String location = c.getHeaderField("Location");
                    if (location == null) throw new IOException("Image redirect had no destination");
                    target = new URL(target, location);
                    continue;
                }
                if (status != 200) throw new IOException("Image host answered " + status);
                String mime = c.getContentType();
                mime = mime == null ? "" : mime.split(";")[0].trim().toLowerCase(Locale.ROOT);
                if (!mime.startsWith("image/")) throw new IOException("Host did not return a supported image");
                if (c.getContentLengthLong() > MAX_BYTES) throw new IOException("Image exceeds 12 MB");
                ByteArrayOutputStream out = new ByteArrayOutputStream();
                byte[] chunk = new byte[32768];
                try (InputStream in = c.getInputStream()) {
                    int count;
                    while ((count = in.read(chunk)) != -1) {
                        if (System.nanoTime() - started > 30000000000L) throw new IOException("Image download timed out");
                        if (out.size() + count > MAX_BYTES) throw new IOException("Image exceeds 12 MB");
                        out.write(chunk, 0, count);
                    }
                }
                byte[] bytes = out.toByteArray();
                if (bytes.length == 0) throw new IOException("Empty image");
                String sha = sha256(bytes);
                if (placeholder(sha)) throw new IOException("Imgur returned an unavailable-image placeholder");
                return new Picture(bytes, mime, sha, proxied);
            } finally { c.disconnect(); }
        }
        throw new IOException("Too many image redirects");
    }

    static String sha256(byte[] bytes) throws IOException {
        try {
            byte[] digest = MessageDigest.getInstance("SHA-256").digest(bytes);
            StringBuilder hex = new StringBuilder();
            for (byte b : digest) hex.append(String.format(Locale.ROOT, "%02x", b));
            return hex.toString();
        } catch (java.security.NoSuchAlgorithmException e) { throw new IOException(e); }
    }
}
