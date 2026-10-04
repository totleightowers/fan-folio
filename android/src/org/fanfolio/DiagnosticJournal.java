package org.fanfolio;

import java.io.*;
import java.nio.charset.StandardCharsets;

/** A bounded, process-independent journal, separate from the library database. */
final class DiagnosticJournal {
    private final File current, previous;
    private final long limit;
    DiagnosticJournal(File directory, long limit) throws IOException {
        if (!directory.isDirectory() && !directory.mkdirs()) throw new IOException("journal directory");
        current = new File(directory, "current.jsonl");
        previous = new File(directory, "previous.jsonl");
        this.limit = limit;
        // A process kill can leave a partial final write. Keep complete records
        // and avoid joining the next startup record onto that truncated JSON.
        if (current.exists()) try (RandomAccessFile file = new RandomAccessFile(current, "rw")) {
            long end = file.length();
            while (end > 0) { file.seek(end - 1); if (file.read() == '\n') break; end--; }
            file.setLength(end);
        }
    }
    synchronized void append(String json) throws IOException {
        byte[] bytes = (json + "\n").getBytes(StandardCharsets.UTF_8);
        if (bytes.length > limit) throw new IOException("record too large");
        if (current.length() + bytes.length > limit) {
            if (previous.exists() && !previous.delete()) throw new IOException("rotate old journal");
            if (!current.renameTo(previous)) throw new IOException("rotate journal");
        }
        try (FileOutputStream out = new FileOutputStream(current, true)) { out.write(bytes); }
    }
    synchronized byte[] snapshot() throws IOException {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        for (File file : new File[]{previous, current}) {
            if (!file.exists()) continue;
            try (InputStream in = new FileInputStream(file)) {
                byte[] buffer = new byte[8192];
                int n;
                while ((n = in.read(buffer)) != -1) out.write(buffer, 0, n);
            }
        }
        return out.toByteArray();
    }
}
