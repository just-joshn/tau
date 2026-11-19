import ghidra.app.cmd.disassemble.DisassembleCommand;
import ghidra.app.decompiler.*;
import ghidra.app.script.GhidraScript;
import ghidra.program.model.address.*;
import ghidra.program.model.data.*;
import ghidra.program.model.listing.*;
import ghidra.program.model.symbol.SourceType;
import java.io.PrintWriter;
import java.nio.charset.StandardCharsets;

/** Checked Darwin clock-import types only; wrapper signatures remain inferred. */
public class InspectClockAbi extends GhidraScript {
    private static final String SHA = "e214ad76dcc0e846b03be28ed1c2734aacd4e27acb527cb7f8a9e2bed644e837";
    private Function imported(String address, DataType result, DataType... arguments) throws Exception {
        Address start = toAddr(address);
        AddressSet body = new AddressSet(start, start.add(11));
        if (!currentProgram.getMemory().getBlock(start).isExecute()) throw new IllegalStateException("Nonexecutable import");
        if (!new DisassembleCommand(start, body, true).applyTo(currentProgram, monitor)) throw new IllegalStateException("Disassembly failed");
        Function function = getFunctionAt(start);
        if (function == null) function = currentProgram.getFunctionManager().createFunction("clock_abi_" + address, start, body, SourceType.USER_DEFINED);
        function.setReturnType(result, SourceType.USER_DEFINED);
        Variable[] parameters = new Variable[arguments.length];
        for (int i = 0; i < arguments.length; i++) parameters[i] = new ParameterImpl("arg" + i, arguments[i], currentProgram);
        function.replaceParameters(Function.FunctionUpdateType.DYNAMIC_STORAGE_ALL_PARAMS, true, SourceType.USER_DEFINED, parameters);
        return function;
    }
    @Override public void run() throws Exception {
        String[] args = getScriptArgs();
        if (args.length != 1 || !SHA.equals(currentProgram.getExecutableSHA256())) throw new IllegalArgumentException("Expected output path and pinned SHA");
        if (!currentProgram.getLanguageID().toString().equals("AARCH64:LE:64:AppleSilicon")) throw new IllegalArgumentException("Expected AppleSilicon");
        CategoryPath category = new CategoryPath("/tau/analyst_abi");
        DataTypeManager types = currentProgram.getDataTypeManager();
        StructureDataType timespec = new StructureDataType(category, "clock_timespec64", 16);
        timespec.replaceAtOffset(0, LongLongDataType.dataType, 8, "tv_sec", null);
        timespec.replaceAtOffset(8, LongLongDataType.dataType, 8, "tv_nsec", null);
        StructureDataType timeval = new StructureDataType(category, "clock_timeval64", 16);
        timeval.replaceAtOffset(0, LongLongDataType.dataType, 8, "tv_sec", null);
        timeval.replaceAtOffset(8, IntegerDataType.dataType, 4, "tv_usec", null);
        StructureDataType timebase = new StructureDataType(category, "mach_timebase_info", 8);
        timebase.replaceAtOffset(0, DWordDataType.dataType, 4, "numer", null);
        timebase.replaceAtOffset(4, DWordDataType.dataType, 4, "denom", null);
        EnumDataType clock = new EnumDataType(category, "darwin_clockid", 4);
        clock.add("DARWIN_CLOCK_REALTIME", 0); clock.add("DARWIN_CLOCK_MONOTONIC", 6);
        DataType ts = types.addDataType(timespec, DataTypeConflictHandler.REPLACE_HANDLER);
        DataType tv = types.addDataType(timeval, DataTypeConflictHandler.REPLACE_HANDLER);
        DataType tb = types.addDataType(timebase, DataTypeConflictHandler.REPLACE_HANDLER);
        DataType ci = types.addDataType(clock, DataTypeConflictHandler.REPLACE_HANDLER);
        DataType tsPointer = new PointerDataType(ts, 8, types);
        Function[] imports = {
            imported("106a96560", IntegerDataType.dataType, ci, tsPointer),
            imported("106a9686c", IntegerDataType.dataType, tsPointer, tsPointer),
            imported("106a95c6c", IntegerDataType.dataType, new PointerDataType(tv, 8, types), new PointerDataType(VoidDataType.dataType, 8, types)),
            imported("106a96ca4", QWordDataType.dataType),
            imported("106a96c98", IntegerDataType.dataType, new PointerDataType(tb, 8, types)),
            imported("106a965cc", VoidDataType.dataType)
        };
        imports[5].setNoReturn(true);
        Address constant = toAddr("1073b6450");
        if (getLong(constant) != 1 || getLong(constant.add(8)) != 0) throw new IllegalStateException("Unexpected sleep constant");
        createData(constant, ts);
        DecompInterface decompiler = new DecompInterface();
        try (PrintWriter out = new PrintWriter(args[0], StandardCharsets.UTF_8)) {
            out.println("SHA256 " + SHA);
            out.println("Analyst-supplied Darwin clock import types checked against compile-only arm64 SDK assertions.");
            out.println("No wrapper signature/ownership recovery; decompilation can follow flow outside declared bodies.");
            out.println("SLEEP_CONSTANT 1073b6450 tv_sec=1 tv_nsec=0");
            out.println("ANNOTATION _abort noreturn=true, analyst-supplied from Darwin SDK declaration");
            for (Function f : imports) out.println("IMPORT " + f.getEntryPoint() + " " + f.getSignature());
            decompiler.toggleCCode(true); decompiler.toggleSyntaxTree(false);
            if (!decompiler.openProgram(currentProgram)) throw new IllegalStateException(decompiler.getLastMessage());
            int succeeded = 0;
            for (String address : new String[]{"106685b00", "10668a9a4", "104d5f438", "104de2180", "1063b8628"}) {
                Function f = getFunctionAt(toAddr(address));
                if (f == null) throw new IllegalStateException("Run InspectLauncher first");
                out.println("FUNCTION " + address);
                DecompileResults result = decompiler.decompileFunction(f, 30, monitor);
                if (result.decompileCompleted() && result.getDecompiledFunction() != null) { out.println(result.getDecompiledFunction().getC()); succeeded++; }
                else out.println("DECOMPILE_FAILED " + result.getErrorMessage());
                out.flush();
            }
            out.printf("COMPLETE requested=5 succeeded=%d failed=%d%n", succeeded, 5 - succeeded);
            if (out.checkError()) throw new IllegalStateException("Cannot write report");
        } finally { decompiler.dispose(); }
    }
}
