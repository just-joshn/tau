/** Native readonly classification and observation support; concrete facts remain required. */
export {
  createNativeBashReadonlyControl,
  type NativeBashReadonlyHost,
  type NativeBashReadonlyVerdict,
  type NativeBashReadonlyCheckoutProbe,
  type NativeBashReadonlyBareRepo,
} from "./native-bash-security/readonly-control.js";
export {
  createNativeBashReadonlyProfiles,
  type NativeBashReadonlyProfile,
  type NativeBashReadonlyProfileHost,
  type NativeBashReadonlyFlagValue,
} from "./native-bash-security/readonly-profiles.js";
