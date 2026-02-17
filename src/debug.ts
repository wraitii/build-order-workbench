function envValue(name: string): string | undefined {
  const g = globalThis as { process?: { env?: Record<string, string | undefined> } };
  return g.process?.env?.[name];
}

export function isSimDebugEnabled(): boolean {
  return envValue("SIM_DEBUG") === "1";
}

export function shouldDebugAction(actionId: string): boolean {
  if (!isSimDebugEnabled()) return false;
  const filter = envValue("SIM_DEBUG_ACTION");
  return !filter || filter === actionId;
}

export function simDebug(...parts: unknown[]): void {
  if (!isSimDebugEnabled()) return;
  console.error("[sim-debug]", ...parts);
}
