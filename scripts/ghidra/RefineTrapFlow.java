import ghidra.app.decompiler.*;
import ghidra.app.script.GhidraScript;
import ghidra.program.model.address.Address;
import ghidra.program.model.listing.*;
import java.io.PrintWriter;
import java.nio.charset.StandardCharsets;

/** Derive no-normal-return only from pinned straight-line native flow ending in an undefined instruction. */
public class RefineTrapFlow extends GhidraScript {
    private void straightLine(String first, String last) throws Exception {
        Address begin = toAddr(first), end = toAddr(last);
        for (Address at = begin; at.compareTo(end) < 0; at = at.add(4)) {
            Instruction instruction = getInstructionAt(at);
            if (instruction == null || instruction.getLength() != 4 || instruction.getFlowType().isJump() ||
                instruction.getFallThrough() == null || !instruction.getFallThrough().equals(at.add(4)))
                throw new IllegalStateException("Not straight-line native flow at " + at);
        }
    }
    @Override public void run() throws Exception {
        String[] args = getScriptArgs();
        if (args.length != 1 || !currentProgram.getExecutableSHA256().equals("e214ad76dcc0e846b03be28ed1c2734aacd4e27acb527cb7f8a9e2bed644e837") ||
            !currentProgram.getLanguageID().toString().equals("AARCH64:LE:64:AppleSilicon")) throw new IllegalArgumentException("Expected pinned program and output path");
        straightLine("1069e42e4", "1069e430c");
        Instruction trap = getInstructionAt(toAddr("1069e430c"));
        if (trap == null || !trap.getMnemonicString().equalsIgnoreCase("udf") || trap.getFallThrough() != null) throw new IllegalStateException("Expected UDF terminal instruction");
        straightLine("1069e40e0", "1069e410c");
        Instruction forwarding = getInstructionAt(toAddr("1069e410c"));
        if (forwarding == null || !forwarding.getFlowType().isCall() || forwarding.getFlows().length != 1 || !forwarding.getFlows()[0].equals(toAddr("1069e42e4"))) throw new IllegalStateException("Expected direct forwarding call");
        Function terminal = getFunctionAt(toAddr("1069e42e4")), wrapper = getFunctionAt(toAddr("1069e40e0")), caller = getFunctionAt(toAddr("10668c390"));
        if (terminal == null || wrapper == null || caller == null || caller.hasNoReturn()) throw new IllegalStateException("Missing entries or unexpected caller annotation");
        terminal.setNoReturn(true); wrapper.setNoReturn(true);
        DecompInterface decompiler = new DecompInterface();
        try (PrintWriter out = new PrintWriter(args[0], StandardCharsets.UTF_8)) {
            out.println("SHA256 " + currentProgram.getExecutableSHA256());
            out.println("Derived annotation: straight-line 1069e42e4 reaches UDF; straight-line 1069e40e0 calls it last.");
            out.println("TLS helper10668c390 remains returning; indirect/tail targets and full ABI not recovered.");
            decompiler.toggleCCode(true); decompiler.toggleSyntaxTree(false);
            if (!decompiler.openProgram(currentProgram)) throw new IllegalStateException(decompiler.getLastMessage());
            int success = 0;
            for (Function function : new Function[]{terminal, wrapper, caller}) {
                out.println("FUNCTION " + function.getEntryPoint() + " noreturn=" + function.hasNoReturn());
                DecompileResults result = decompiler.decompileFunction(function, 30, monitor);
                if (result.decompileCompleted() && result.getDecompiledFunction() != null) { out.println(result.getDecompiledFunction().getC()); success++; }
                else out.println("DECOMPILE_FAILED " + result.getErrorMessage());
            }
            out.printf("COMPLETE requested=3 succeeded=%d failed=%d%n", success, 3-success);
            if (out.checkError()) throw new IllegalStateException("Cannot write report");
        } finally { decompiler.dispose(); }
    }
}
