import ghidra.app.script.GhidraScript;
import ghidra.program.model.address.Address;
import ghidra.program.model.mem.MemoryBlock;
import java.io.PrintWriter;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.util.HexFormat;
import java.util.List;

/** Compare bounded source/data spans to Ghidra's imported nonexecutable Bun image bytes. */
public class InspectEmbeddedSpans extends GhidraScript {
    @Override public void run() throws Exception {
        String[] args = getScriptArgs();
        String sha = "e214ad76dcc0e846b03be28ed1c2734aacd4e27acb527cb7f8a9e2bed644e837";
        if (args.length != 2 || !sha.equals(currentProgram.getExecutableSHA256())) throw new IllegalArgumentException("Expected pinned image, manifest, output");
        List<String> lines = Files.readAllLines(Path.of(args[0]), StandardCharsets.UTF_8);
        if (lines.isEmpty() || !lines.get(0).equals("sha256\t" + sha) || lines.size() > 65) throw new IllegalArgumentException("Invalid manifest hash/count");
        int matched = 0, requested = 0;
        try (PrintWriter out = new PrintWriter(args[1], StandardCharsets.UTF_8)) {
            out.println("SHA256 " + sha);
            out.println("Scope: imported nonexecutable Bun data, preferred image addresses; not native functions or target execution.");
            for (String line : lines.subList(1, lines.size())) {
                if (line.isBlank()) continue;
                String[] fields = line.split("\\t");
                if (fields.length != 4 || !fields[0].matches("[A-Za-z0-9_-]{1,64}") || !fields[3].matches("[a-f0-9]{64}")) throw new IllegalArgumentException("Invalid span fields");
                long offset = Long.parseLong(fields[1]); int length = Integer.parseInt(fields[2]);
                if (offset < 129744896 || length < 1 || length > 8192) throw new IllegalArgumentException("Span bounds");
                Address address = toAddr("107d98000").add(offset - 129744896);
                MemoryBlock block = currentProgram.getMemory().getBlock(address);
                if (block == null || !block.getName().equals("__bun") || block.isExecute() || !block.contains(address.add(length - 1))) throw new IllegalArgumentException("Expected bounded nonexecutable Bun region");
                byte[] bytes = new byte[length];
                if (currentProgram.getMemory().getBytes(address, bytes) != length) throw new IllegalStateException("Short image read");
                String digest = HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(bytes));
                boolean equal = digest.equals(fields[3]); requested++; if (equal) matched++;
                out.println(fields[0] + " file=" + offset + " preferred=" + address + " bytes=" + length + " sha256=" + digest + " equal=" + equal);
            }
            out.printf("COMPLETE requested=%d matched=%d failed=%d%n", requested, matched, requested - matched);
            if (out.checkError()) throw new IllegalStateException("Cannot write report");
        }
        if (matched != requested) throw new IllegalStateException("Embedded span mismatch");
    }
}
