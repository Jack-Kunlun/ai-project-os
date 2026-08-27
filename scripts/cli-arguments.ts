/**
 * pnpm may preserve the conventional separator as a literal argument. Keep
 * direct `tsx script.ts ...` and `pnpm script -- ...` invocation equivalent.
 */
export function readCliArguments(
  argv: readonly string[] = process.argv,
): readonly string[] {
  const args = argv.slice(2);
  return Object.freeze(args[0] === "--" ? args.slice(1) : args);
}
