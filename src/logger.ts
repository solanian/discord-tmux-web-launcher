export function createLogger(scope: string) {
  const prefix = `[${scope}]`;

  return {
    log: (...args: unknown[]) => console.log(new Date().toISOString(), prefix, ...args),
    error: (...args: unknown[]) => console.error(new Date().toISOString(), prefix, ...args),
    warn: (...args: unknown[]) => console.warn(new Date().toISOString(), prefix, ...args),
  };
}
