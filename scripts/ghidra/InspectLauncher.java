import ghidra.app.cmd.disassemble.DisassembleCommand;
import ghidra.app.decompiler.DecompInterface;
import ghidra.app.decompiler.DecompileResults;
import ghidra.app.script.GhidraScript;
import ghidra.framework.Application;
import ghidra.program.model.address.Address;
import ghidra.program.model.address.AddressSet;
import ghidra.program.model.listing.Function;
import ghidra.program.model.listing.Instruction;
import ghidra.program.model.mem.MemoryBlock;
import ghidra.program.model.symbol.Reference;
import ghidra.program.model.symbol.SourceType;
import ghidra.program.model.symbol.Symbol;
import java.io.PrintWriter;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;

/** Static, bounded inspection. Arguments: ranges.tsv output.txt. No target execution. */
public class InspectLauncher extends GhidraScript {
    @Override
    public void run() throws Exception {
        String[] args = getScriptArgs();
        if (args.length != 2) throw new IllegalArgumentException("Expected ranges.tsv output.txt");
        List<String> lines = Files.readAllLines(Path.of(args[0]), StandardCharsets.UTF_8);
        if (lines.isEmpty() || !lines.get(0).equals("sha256\t" + currentProgram.getExecutableSHA256())) {
            throw new IllegalArgumentException("Range manifest does not match the imported executable SHA256");
        }
        if (lines.size() > 65) throw new IllegalArgumentException("At most 64 function ranges are supported");
        List<Function> functions = new ArrayList<>();
        for (String line : lines.subList(1, lines.size())) {
            if (line.isBlank()) continue;
            String[] bounds = line.split("\\t");
            if (bounds.length < 2 || bounds.length > 3 || (bounds.length == 3 && !bounds[2].equals("noreturn"))) {
                throw new IllegalArgumentException("Expected start/end hex addresses and optional noreturn");
            }
            Address start = toAddr(bounds[0]);
            Address end = toAddr(bounds[1]);
            if (start == null || end == null || start.compareTo(end) > 0 || end.subtract(start) > 65535) {
                throw new IllegalArgumentException("Invalid or oversized function range: " + line);
            }
            MemoryBlock block = currentProgram.getMemory().getBlock(start);
            if (block == null || !block.isExecute() || !block.contains(end)) {
                throw new IllegalArgumentException("Range must lie within one executable block: " + line);
            }
            AddressSet body = new AddressSet(start, end);
            if (!new DisassembleCommand(start, body, true).applyTo(currentProgram, monitor)) {
                throw new IllegalStateException("Cannot disassemble " + start);
            }
            Function function = getFunctionAt(start);
            if (function == null) {
                function = currentProgram.getFunctionManager().createFunction(
                    "inspect_" + start, start, body, SourceType.USER_DEFINED);
            }
            function.setBody(body);
            if (bounds.length == 3) function.setNoReturn(true);
            Address boundary = end.next();
            if (getFunctionAt(boundary) == null) {
                currentProgram.getFunctionManager().createFunction(
                    "boundary_" + boundary, boundary, new AddressSet(boundary), SourceType.USER_DEFINED);
            }
            functions.add(function);
        }
        DecompInterface decompiler = new DecompInterface();
        try (PrintWriter output = new PrintWriter(args[1], StandardCharsets.UTF_8)) {
            output.println("Ghidra " + Application.getApplicationVersion());
            output.println("Program: " + currentProgram.getName());
            output.println("Executable SHA256: " + currentProgram.getExecutableSHA256());
            output.println("Language: " + currentProgram.getLanguageID());
            output.println("Compiler: " + currentProgram.getCompilerSpec().getCompilerSpecID());
            output.println("Scope: selected function entries; bounded disassembly; pseudocode may follow shared/tail flow outside bodies.");
            output.println("Automatic analysis disabled; no target execution. noreturn flags include manifest annotations.");
            for (MemoryBlock block : currentProgram.getMemory().getBlocks()) {
                output.printf("BLOCK %s %s..%s initialized=%s execute=%s%n",
                    block.getName(), block.getStart(), block.getEnd(), block.isInitialized(), block.isExecute());
            }
            decompiler.toggleCCode(true);
            decompiler.toggleSyntaxTree(false);
            if (!decompiler.openProgram(currentProgram)) {
                throw new IllegalStateException(decompiler.getLastMessage());
            }
            int succeeded = 0;
            for (Function function : functions) {
                monitor.checkCancelled();
                output.printf("%nFUNCTION %s %s body=%s noreturn=%s%n", function.getName(),
                    function.getEntryPoint(), function.getBody(), function.hasNoReturn());
                for (Instruction instruction : currentProgram.getListing().getInstructions(function.getBody(), true)) {
                    if (!instruction.getFlowType().isCall()) continue;
                    for (Reference reference : instruction.getReferencesFrom()) {
                        if (!reference.getReferenceType().isCall()) continue;
                        Address destination = reference.getToAddress();
                        Symbol symbol = currentProgram.getSymbolTable().getPrimarySymbol(destination);
                        output.printf("CALL %s -> %s %s%n", instruction.getAddress(), destination,
                            symbol == null ? "" : symbol.getName(true));
                    }
                }
                DecompileResults result = decompiler.decompileFunction(function, 30, monitor);
                if (result.decompileCompleted() && result.getDecompiledFunction() != null) {
                    output.println(result.getDecompiledFunction().getC());
                    succeeded++;
                } else {
                    output.println("DECOMPILE_FAILED " + result.getErrorMessage());
                }
                output.flush();
            }
            output.printf("COMPLETE requested=%d succeeded=%d failed=%d%n",
                functions.size(), succeeded, functions.size() - succeeded);
            if (output.checkError()) throw new IllegalStateException("Failed to write inspection report");
        } finally {
            decompiler.dispose();
        }
    }
}
