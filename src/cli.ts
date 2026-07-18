#!/usr/bin/env node

import { parseArgs } from "node:util";

const VERSION = "0.0.1";

const HELP = `SafeChange ${VERSION}

Usage:
  safechange plan --task <text> [--plans 1..5] [--repo <path>]
  safechange run --task <text> [--plans 1..5] [--repo <path>]
  safechange resume --run <run-id> [--repo <path>]

Commands:
  plan      Compare plans without changing tracked repository state
  run       Execute the complete test-first change workflow
  resume    Continue a persisted run from a validated phase boundary

Options:
  -h, --help       Show this help
  -v, --version    Show the SafeChange version
`;

export function main(argv: string[] = process.argv.slice(2)): number {
  const parsed = parseArgs({
    args: argv,
    allowPositionals: true,
    strict: false,
    options: {
      help: { type: "boolean", short: "h" },
      version: { type: "boolean", short: "v" },
    },
  });

  if (parsed.values.version) {
    process.stdout.write(`${VERSION}\n`);
    return 0;
  }

  if (parsed.values.help || parsed.positionals.length === 0) {
    process.stdout.write(HELP);
    return 0;
  }

  const command = parsed.positionals[0];
  if (command !== "plan" && command !== "run" && command !== "resume") {
    process.stderr.write(`Unknown command: ${command ?? ""}\n\n${HELP}`);
    return 1;
  }

  process.stderr.write(`The ${command} workflow is not implemented yet.\n`);
  return 1;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exitCode = main();
}
