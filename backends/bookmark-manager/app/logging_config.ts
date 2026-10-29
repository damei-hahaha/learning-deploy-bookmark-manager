// Two loggers.
//
// makeLogger is the console wrapper the rest of the app already calls with a
// sentence. makePinoLogger is the JSON logger: each call takes an object, so a
// field like username stays a field instead of being interpolated into text.
// The login route is the one that uses it, and it also appends those lines to
// logs/login.log. Stdout stays the human-readable copy in development.

import path from "node:path";
import { fileURLToPath } from "node:url";

import pino from "pino";
import type { Logger as PinoLogger } from "pino";
import pretty from "pino-pretty";

import { getSettings } from "./config.js";
import type { LogLevel } from "./config.js";

// Next to this package, not next to the process's cwd, so `npx tsx app/server.ts`
// and a start from the repo root write the same file. Docker's workdir is this
// package, and compose mounts ./logs onto it.
const loginLogPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../logs/login.log");

// Record<LogLevel, number> ties the table to the LogLevel union: add a level to
// one and the other stops compiling until it catches up.
const LEVELS: Record<LogLevel, number> = { DEBUG: 10, INFO: 20, WARNING: 30, ERROR: 40 };

type LogFn = (msg: string, ...args: unknown[]) => void;

interface Logger {
  info: LogFn;
  warning: LogFn;
  error: LogFn;
}

function timestamp(): string {
  return new Date().toISOString().replace("T", " ").slice(0, 19);
}

function makeLogger(name: string): Logger {
  const threshold = LEVELS[getSettings().logLevel];

  function emit(
    level: LogLevel,
    stream: (message: string) => void,
    message: string,
    ...args: unknown[]
  ): void {
    if (LEVELS[level] < threshold) return;
    const line = `${timestamp()} | ${level.padEnd(8)} | ${name} | ${message}`;
    stream(args.length ? `${line} ${args.map(String).join(" ")}` : line);
  }

  return {
    info: (msg, ...a) => emit("INFO", console.log, msg, ...a),
    warning: (msg, ...a) => emit("WARNING", console.warn, msg, ...a),
    error: (msg, ...a) => emit("ERROR", console.error, msg, ...a),
  };
}

// Pino's levels are lowercase and it calls the middle one "warn", not "WARNING".
const PINO_LEVELS: Record<LogLevel, pino.Level> = {
  DEBUG: "debug",
  INFO: "info",
  WARNING: "warn",
  ERROR: "error",
};

interface PinoLoggerOptions {
  // Append-only JSON file in addition to stdout. Ignored under NODE_ENV=test
  // so the suite does not open a handle or write into the repo.
  file?: string;
}

function makePinoLogger(name: string, options: PinoLoggerOptions = {}): PinoLogger {
  const { logLevel, environment } = getSettings();
  // Tests and production both want JSON on stdout: tests so Jest does not
  // start a pretty-printer, production so a collector can index the fields.
  const usePretty =
    environment !== "production" &&
    process.env.NODE_ENV !== "production" &&
    process.env.NODE_ENV !== "test";

  const base = {
    name,
    level: PINO_LEVELS[logLevel],
    // A login handler that later logs the whole body should still not write
    // the password. The censor applies to children of this logger too.
    redact: ["password", "*.password"],
  };

  const file = process.env.NODE_ENV === "test" ? undefined : options.file;
  if (!file) {
    return pino({
      ...base,
      ...(usePretty
        ? {
            transport: {
              target: "pino-pretty",
              options: { translateTime: "HH:MM:SS", ignore: "pid,hostname" },
            },
          }
        : {}),
    });
  }

  // The file is always JSON, including in development, where stdout is the
  // pretty line. sync so a login line is on disk before the response returns.
  // Each stream's level is debug so it accepts whatever the logger itself emits.
  const stdout = usePretty
    ? pretty({ translateTime: "HH:MM:SS", ignore: "pid,hostname" })
    : process.stdout;

  return pino(
    base,
    pino.multistream([
      { level: "debug", stream: stdout },
      {
        level: "debug",
        stream: pino.destination({ dest: file, mkdir: true, append: true, sync: true }),
      },
    ])
  );
}

export { makeLogger, makePinoLogger, loginLogPath };
export type { Logger, LogFn, PinoLogger };
