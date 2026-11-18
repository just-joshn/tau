export interface NativeTypedRuleEnvironment {
  evalConfined: boolean;
  projectsSession: boolean;
  configProbe: boolean;
  useCoworkPlugins: boolean;
  hostCredentialsFile: string | undefined;
}

/** Required keys record actual observed absence as undefined; missing owners are not inputs. */
export interface NativeRawRuleEnvironmentInputs {
  evalConfined: string | undefined;
  projectsSession: string | undefined;
  configProbe: string | undefined;
  useCoworkPlugins: string | undefined;
  hostCredentialsFile: string | undefined;
}
/** N.bool/r/f/Ae, without a process/default environment reader. */
export function nativeTypedEnvironmentBoolean(
  value: string | undefined,
): boolean {
  if (value === undefined) return false;
  return ["1", "true", "yes", "on"].includes(value.toLowerCase().trim());
}
/** N.str/r/f/o; raw process.env M/u5/Ye consumers do not use this projection. */
export function nativeTypedEnvironmentString(
  value: string | undefined,
): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}
export function projectNativeTypedRuleEnvironment(
  raw: NativeRawRuleEnvironmentInputs,
): NativeTypedRuleEnvironment {
  return {
    evalConfined: nativeTypedEnvironmentBoolean(raw.evalConfined),
    projectsSession: nativeTypedEnvironmentBoolean(raw.projectsSession),
    configProbe: nativeTypedEnvironmentBoolean(raw.configProbe),
    useCoworkPlugins: nativeTypedEnvironmentBoolean(raw.useCoworkPlugins),
    hostCredentialsFile: nativeTypedEnvironmentString(raw.hostCredentialsFile),
  };
}
