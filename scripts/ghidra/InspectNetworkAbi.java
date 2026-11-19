import ghidra.app.cmd.disassemble.DisassembleCommand;
import ghidra.app.decompiler.*;
import ghidra.app.script.GhidraScript;
import ghidra.program.model.address.*;
import ghidra.program.model.data.*;
import ghidra.program.model.listing.*;
import ghidra.program.model.symbol.SourceType;
import java.io.PrintWriter;
import java.nio.charset.StandardCharsets;

/** Checked Darwin network-import types only; wrapper signatures remain inferred. */
public class InspectNetworkAbi extends GhidraScript {
    private static final String SHA = "e214ad76dcc0e846b03be28ed1c2734aacd4e27acb527cb7f8a9e2bed644e837";
    private Function imported(String address, DataType result, DataType... arguments) throws Exception {
        Address start = toAddr(address);
        AddressSet body = new AddressSet(start, start.add(11));
        if (!currentProgram.getMemory().getBlock(start).isExecute()) throw new IllegalStateException("Nonexecutable import");
        if (!new DisassembleCommand(start, body, true).applyTo(currentProgram, monitor)) throw new IllegalStateException("Disassembly failed");
        Function function = getFunctionAt(start);
        if (function == null) function = currentProgram.getFunctionManager().createFunction("network_abi_" + address, start, body, SourceType.USER_DEFINED);
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
        StructureDataType pollfd = new StructureDataType(category, "darwin_pollfd", 8);
        pollfd.replaceAtOffset(0, IntegerDataType.dataType, 4, "fd", null);
        pollfd.replaceAtOffset(4, ShortDataType.dataType, 2, "events", null);
        pollfd.replaceAtOffset(6, ShortDataType.dataType, 2, "revents", null);
        StructureDataType sockaddr = new StructureDataType(category, "darwin_sockaddr", 16);
        sockaddr.replaceAtOffset(0, ByteDataType.dataType, 1, "sa_len", null);
        sockaddr.replaceAtOffset(1, ByteDataType.dataType, 1, "sa_family", null);
        sockaddr.replaceAtOffset(2, new ArrayDataType(CharDataType.dataType, 14, 1), 14, "sa_data", null);
        DataType pf = types.addDataType(pollfd, DataTypeConflictHandler.REPLACE_HANDLER);
        DataType sa = types.addDataType(sockaddr, DataTypeConflictHandler.REPLACE_HANDLER);
        DataType pvoid = new PointerDataType(VoidDataType.dataType, 8, types), psa = new PointerDataType(sa, 8, types);
        Function[] imports = {
            imported("106a970f4", LongLongDataType.dataType, IntegerDataType.dataType, pvoid, QWordDataType.dataType, IntegerDataType.dataType),
            imported("106a96a64", LongLongDataType.dataType, IntegerDataType.dataType, pvoid, QWordDataType.dataType, IntegerDataType.dataType, psa, new PointerDataType(DWordDataType.dataType, 8, types)),
            imported("106a96a4c", IntegerDataType.dataType, new PointerDataType(pf, 8, types), DWordDataType.dataType, IntegerDataType.dataType),
            imported("106a97a54", IntegerDataType.dataType, IntegerDataType.dataType, psa, DWordDataType.dataType),
            imported("106a95d98", new PointerDataType(IntegerDataType.dataType, 8, types)),
            imported("106a95c60", VoidDataType.dataType)
        };
        imports[5].setNoReturn(true);
        DecompInterface decompiler = new DecompInterface();
        try (PrintWriter out = new PrintWriter(args[0], StandardCharsets.UTF_8)) {
            out.println("SHA256 " + SHA);
            out.println("Analyst-supplied network import types from compile-only arm64 SDK checks; no original runtime execution.");
            out.println("No wrapper ABI/application ownership recovery; stack failure import annotated SDK noreturn.");
            out.println("SDK_FACTS sizeof(pollfd)=8 fd=0 events=4 revents=6; sizeof(sockaddr)=16; MSG_PEEK=2 MSG_DONTWAIT=128; EINTR=4 EAGAIN=35 EAFNOSUPPORT=47");
            for (Function f : imports) out.println("IMPORT " + f.getEntryPoint() + " " + f.getSignature());
            decompiler.toggleCCode(true); decompiler.toggleSyntaxTree(false);
            if (!decompiler.openProgram(currentProgram)) throw new IllegalStateException(decompiler.getLastMessage());
            int succeeded = 0;
            for (String address : new String[]{"104e5ed18", "103eca428", "104c2c328", "10426eb28"}) {
                Function f = getFunctionAt(toAddr(address));
                if (f == null) throw new IllegalStateException("Run InspectLauncher first");
                out.println("FUNCTION " + address);
                DecompileResults result = decompiler.decompileFunction(f, 30, monitor);
                if (result.decompileCompleted() && result.getDecompiledFunction() != null) { out.println(result.getDecompiledFunction().getC()); succeeded++; }
                else out.println("DECOMPILE_FAILED " + result.getErrorMessage());
                out.flush();
            }
            out.printf("COMPLETE requested=4 succeeded=%d failed=%d%n", succeeded, 4 - succeeded);
            if (out.checkError()) throw new IllegalStateException("Cannot write report");
        } finally { decompiler.dispose(); }
    }
}
