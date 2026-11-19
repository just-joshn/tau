import ghidra.app.script.GhidraScript;
import ghidra.program.model.address.*;
import ghidra.program.model.listing.Instruction;
import java.io.PrintWriter;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;

/** Read bounded native instruction/flow facts from an already imported SHA-pinned program. */
public class InspectControlFlow extends GhidraScript {
    @Override public void run() throws Exception {
        String[] args = getScriptArgs();
        if (args.length != 2) throw new IllegalArgumentException("Expected manifest and output path");
        List<String> lines = Files.readAllLines(Path.of(args[0]), StandardCharsets.UTF_8);
        if (lines.isEmpty() || !lines.get(0).equals("sha256\t" + currentProgram.getExecutableSHA256()) || lines.size() > 65) throw new IllegalArgumentException("Invalid SHA/range count");
        try (PrintWriter out = new PrintWriter(args[1], StandardCharsets.UTF_8)) {
            out.println("SHA256 " + currentProgram.getExecutableSHA256());
            out.println("Selected instruction facts only; no target execution, no callee semantics inferred.");
            int count = 0;
            for (String line : lines.subList(1, lines.size())) {
                if (line.isBlank()) continue;
                String[] fields = line.split("\\t");
                Address start = toAddr(fields[0]), end = toAddr(fields[1]);
                if (start.compareTo(end) > 0 || end.subtract(start) > 65535 || !currentProgram.getMemory().getBlock(start).isExecute() || !currentProgram.getMemory().getBlock(start).contains(end)) throw new IllegalArgumentException("Invalid executable range");
                out.println("RANGE " + start + ".." + end);
                for (Instruction instruction : currentProgram.getListing().getInstructions(new AddressSet(start, end), true)) {
                    out.print(instruction.getAddress() + " " + instruction + " flow=" + instruction.getFlowType());
                    for (Address target : instruction.getFlows()) out.print(" to=" + target);
                    out.println(" fallthrough=" + instruction.getFallThrough());
                }
                count++;
            }
            out.println("COMPLETE ranges=" + count);
            if (out.checkError()) throw new IllegalStateException("Cannot write report");
        }
    }
}
