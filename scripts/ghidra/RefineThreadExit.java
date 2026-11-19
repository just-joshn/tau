import ghidra.app.cmd.disassemble.DisassembleCommand;
import ghidra.app.decompiler.*;
import ghidra.app.script.GhidraScript;
import ghidra.program.model.address.*;
import ghidra.program.model.data.*;
import ghidra.program.model.listing.*;
import ghidra.program.model.symbol.SourceType;
import java.io.PrintWriter;
import java.nio.charset.StandardCharsets;

/** Standard pthread_exit ABI and a verified straight-line forwarding wrapper. */
public class RefineThreadExit extends GhidraScript {
    @Override public void run() throws Exception {
        String[] args = getScriptArgs();
        if (args.length != 1 || !currentProgram.getExecutableSHA256().equals("e214ad76dcc0e846b03be28ed1c2734aacd4e27acb527cb7f8a9e2bed644e837")) throw new IllegalArgumentException("Expected output path and pinned SHA");
        Address entry = toAddr("106689e80"), stub = toAddr("106a97d90");
        Function wrapper = getFunctionAt(entry);
        Instruction last = getInstructionAt(entry.add(12));
        int count = 0;
        for (Instruction i : currentProgram.getListing().getInstructions(new AddressSet(entry, entry.add(15)), true)) count++;
        if (wrapper == null || count != 4 || last == null || !last.getFlowType().isCall() || last.getFlows().length != 1 || !last.getFlows()[0].equals(stub)) throw new IllegalStateException("Expected four-instruction pthread_exit wrapper");
        AddressSet body = new AddressSet(stub, stub.add(11));
        if (!new DisassembleCommand(stub, body, true).applyTo(currentProgram, monitor)) throw new IllegalStateException("Cannot disassemble import");
        Function imported = getFunctionAt(stub);
        if (imported == null) imported = currentProgram.getFunctionManager().createFunction("thread_exit_abi", stub, body, SourceType.USER_DEFINED);
        imported.setReturnType(VoidDataType.dataType, SourceType.USER_DEFINED);
        imported.replaceParameters(Function.FunctionUpdateType.DYNAMIC_STORAGE_ALL_PARAMS, true, SourceType.USER_DEFINED,
            new ParameterImpl("value", new PointerDataType(VoidDataType.dataType, 8, currentProgram.getDataTypeManager()), currentProgram));
        imported.setNoReturn(true);
        wrapper.setNoReturn(true);
        DecompInterface decompiler = new DecompInterface();
        try (PrintWriter out = new PrintWriter(args[0], StandardCharsets.UTF_8)) {
            out.println("SHA256 " + currentProgram.getExecutableSHA256());
            out.println("Analyst annotation: SDK pthread_exit(void*) noreturn; direct forwarding wrapper noreturn from bounded native flow.");
            out.println("Other helper10668c390 remains unannotated; wrapper/application ABI remains inferred.");
            decompiler.toggleCCode(true); decompiler.toggleSyntaxTree(false);
            if (!decompiler.openProgram(currentProgram)) throw new IllegalStateException(decompiler.getLastMessage());
            int succeeded = 0;
            for (String address : new String[]{"106689e80", "10668a9a4"}) {
                Function f = getFunctionAt(toAddr(address));
                if (f == null) throw new IllegalStateException("Missing selected function");
                out.println("FUNCTION " + address + " noreturn=" + f.hasNoReturn());
                DecompileResults result = decompiler.decompileFunction(f, 30, monitor);
                if (result.decompileCompleted() && result.getDecompiledFunction() != null) { out.println(result.getDecompiledFunction().getC()); succeeded++; }
                else out.println("DECOMPILE_FAILED " + result.getErrorMessage());
            }
            out.printf("COMPLETE requested=2 succeeded=%d failed=%d%n", succeeded, 2 - succeeded);
            if (out.checkError()) throw new IllegalStateException("Cannot write report");
        } finally { decompiler.dispose(); }
    }
}
