/**
 * Complete source-backed Bash permission control graph.
 * Concrete factual providers are required; this module does not install a grant
 * path, run a shell, or supply production filesystem/sandbox capabilities.
 */
export {
  createNativeBashSecurityProcess,
  type NativeBashSecurityProcessHosts,
  type NativeBashSecurityProcessResult,
} from "./native-bash-security/security-process.js";
export { NativeBashSecurityUnsupported } from "./native-bash-security/security-types.js";
export type * from "./native-bash-security/security-types.js";
export type * from "./native-bash-security/security-recursion-types.js";
