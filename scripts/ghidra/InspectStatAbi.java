import ghidra.app.cmd.disassemble.DisassembleCommand;
import ghidra.app.decompiler.DecompInterface;
import ghidra.app.decompiler.DecompileResults;
import ghidra.app.script.GhidraScript;
import ghidra.program.model.address.Address;
import ghidra.program.model.address.AddressSet;
import ghidra.program.model.data.*;
import ghidra.program.model.listing.*;
import ghidra.program.model.symbol.SourceType;
import java.io.PrintWriter;
import java.nio.charset.StandardCharsets;

/** Analyst-supplied Darwin import types; run after InspectLauncher with the stat manifest. */
public class InspectStatAbi extends GhidraScript {
    private static final String SHA = "e214ad76dcc0e846b03be28ed1c2734aacd4e27acb527cb7f8a9e2bed644e837";

    private Function imported(String address, String name, DataType returnType, DataType... arguments) throws Exception {
        Address start = toAddr(address);
        AddressSet body = new AddressSet(start, start.add(11));
        if (!currentProgram.getMemory().getBlock(start).isExecute()) throw new IllegalStateException("Nonexecutable stub");
        if (!new DisassembleCommand(start, body, true).applyTo(currentProgram, monitor)) throw new IllegalStateException("Cannot disassemble stub");
        Function function = getFunctionAt(start);
        if (function == null) function = currentProgram.getFunctionManager().createFunction(name, start, body, SourceType.USER_DEFINED);
        function.setReturnType(returnType, SourceType.USER_DEFINED);
        Variable[] parameters = new Variable[arguments.length];
        for (int i = 0; i < arguments.length; i++) parameters[i] = new ParameterImpl("arg" + i, arguments[i], currentProgram);
        function.replaceParameters(Function.FunctionUpdateType.DYNAMIC_STORAGE_ALL_PARAMS, true, SourceType.USER_DEFINED, parameters);
        return function;
    }

    @Override public void run() throws Exception {
        String[] args = getScriptArgs();
        if (args.length != 1 || !SHA.equals(currentProgram.getExecutableSHA256())) throw new IllegalArgumentException("Expected output path and pinned target SHA");
        if (!currentProgram.getLanguageID().toString().equals("AARCH64:LE:64:AppleSilicon")) throw new IllegalArgumentException("Expected AppleSilicon arm64");
        CategoryPath category = new CategoryPath("/tau/analyst_abi");
        StructureDataType timespec = new StructureDataType(category, "darwin_timespec64", 16);
        timespec.replaceAtOffset(0, LongLongDataType.dataType, 8, "tv_sec", null);
        timespec.replaceAtOffset(8, LongLongDataType.dataType, 8, "tv_nsec", null);
        StructureDataType stat = new StructureDataType(category, "darwin_stat64", 144);
        stat.replaceAtOffset(0, IntegerDataType.dataType, 4, "st_dev", null);
        stat.replaceAtOffset(4, WordDataType.dataType, 2, "st_mode", null);
        stat.replaceAtOffset(6, WordDataType.dataType, 2, "st_nlink", null);
        stat.replaceAtOffset(8, QWordDataType.dataType, 8, "st_ino", null);
        stat.replaceAtOffset(16, DWordDataType.dataType, 4, "st_uid", null);
        stat.replaceAtOffset(20, DWordDataType.dataType, 4, "st_gid", null);
        stat.replaceAtOffset(24, IntegerDataType.dataType, 4, "st_rdev", null);
        stat.replaceAtOffset(32, timespec, 16, "st_atimespec", null);
        stat.replaceAtOffset(48, timespec, 16, "st_mtimespec", null);
        stat.replaceAtOffset(64, timespec, 16, "st_ctimespec", null);
        stat.replaceAtOffset(80, timespec, 16, "st_birthtimespec", null);
        stat.replaceAtOffset(96, LongLongDataType.dataType, 8, "st_size", null);
        stat.replaceAtOffset(104, LongLongDataType.dataType, 8, "st_blocks", null);
        stat.replaceAtOffset(112, IntegerDataType.dataType, 4, "st_blksize", null);
        stat.replaceAtOffset(116, DWordDataType.dataType, 4, "st_flags", null);
        stat.replaceAtOffset(120, DWordDataType.dataType, 4, "st_gen", null);
        stat.replaceAtOffset(124, IntegerDataType.dataType, 4, "st_lspare", null);
        stat.replaceAtOffset(128, new ArrayDataType(LongLongDataType.dataType, 2, 8), 16, "st_qspare", null);
        DataTypeManager types = currentProgram.getDataTypeManager();
        DataType resolved = types.addDataType(stat, DataTypeConflictHandler.REPLACE_HANDLER);
        DataType statPointer = new PointerDataType(resolved, 8, types);
        DataType charPointer = new PointerDataType(CharDataType.dataType, 8, types);
        Function[] imports = {
            imported("106a96110", "tau_fstat_abi", IntegerDataType.dataType, IntegerDataType.dataType, statPointer),
            imported("106a96044", "tau_stat_abi", IntegerDataType.dataType, charPointer, statPointer),
            imported("106a96050", "tau_lstat_abi", IntegerDataType.dataType, charPointer, statPointer),
            imported("106a95d98", "tau_errno_abi", new PointerDataType(IntegerDataType.dataType, 8, types))
        };
        DecompInterface decompiler = new DecompInterface();
        try (PrintWriter out = new PrintWriter(args[0], StandardCharsets.UTF_8)) {
            out.println("SHA256 " + SHA);
            out.println("Analyst-supplied Darwin arm64 syscall ABI annotations, checked against local SDK compile-time offsets.");
            out.println("Wrapper parameter/return signatures are still inferred; target code is never executed.");
            out.println("STAT_LAYOUT size=144 st_atimespec=32 st_mtimespec=48 st_ctimespec=64 st_birthtimespec=80 st_size=96 st_blocks=104 st_blksize=112");
            for (Function f : imports) out.println("IMPORT " + f.getEntryPoint() + " " + f.getSignature());
            decompiler.toggleCCode(true);
            decompiler.toggleSyntaxTree(false);
            if (!decompiler.openProgram(currentProgram)) throw new IllegalStateException(decompiler.getLastMessage());
            int succeeded = 0;
            for (String address : new String[] {"100e2961c", "1065b9ab0", "1065b9b88"}) {
                Function f = getFunctionAt(toAddr(address));
                if (f == null) throw new IllegalStateException("Run InspectLauncher first: " + address);
                out.println("FUNCTION " + address);
                DecompileResults result = decompiler.decompileFunction(f, 30, monitor);
                if (result.decompileCompleted() && result.getDecompiledFunction() != null) {
                    out.println(result.getDecompiledFunction().getC()); succeeded++;
                } else out.println("DECOMPILE_FAILED " + result.getErrorMessage());
                out.flush();
            }
            out.printf("COMPLETE requested=3 succeeded=%d failed=%d%n", succeeded, 3 - succeeded);
            if (out.checkError()) throw new IllegalStateException("Cannot write report");
        } finally { decompiler.dispose(); }
    }
}
