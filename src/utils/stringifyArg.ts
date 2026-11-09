/** Renders a console argument the way the file logger and the Activity Log both need it. */
export function stringifyArg(arg: unknown): string {
  if (typeof arg === "string") {
    return arg;
  }
  if (arg instanceof Error) {
    return `${arg.name}: ${arg.message}${arg.stack ? `\n${arg.stack}` : ""}`;
  }
  try {
    return JSON.stringify(arg);
  } catch {
    return String(arg);
  }
}
