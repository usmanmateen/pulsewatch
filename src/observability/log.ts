/**
 * Structured JSON logging. Workers Logs indexes JSON fields, so each line is
 * a single object with an `event` name plus flat, primitive fields.
 *
 * Privacy rule for callers: log identifiers, states, counts and error codes —
 * never health values, notification text, tokens or the ntfy topic. As a
 * backstop, keys that look sensitive are redacted and long strings truncated.
 */

export type LogValue = string | number | boolean | null | undefined;
export type LogFields = Record<string, LogValue>;
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogSink {
  (level: LogLevel, line: string): void;
}

export interface Logger {
  debug(event: string, fields?: LogFields): void;
  info(event: string, fields?: LogFields): void;
  warn(event: string, fields?: LogFields): void;
  error(event: string, fields?: LogFields): void;
  child(fields: LogFields): Logger;
}

const SENSITIVE_KEY = /token|secret|password|authori[sz]ation|cookie|credential|topic|verifier|^code$/i;
const MAX_STRING = 200;

export function sanitiseFields(fields: LogFields): LogFields {
  const clean: LogFields = {};
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined) continue;
    if (SENSITIVE_KEY.test(key)) {
      clean[key] = '[redacted]';
    } else if (typeof value === 'string' && value.length > MAX_STRING) {
      clean[key] = `${value.slice(0, MAX_STRING)}…`;
    } else {
      clean[key] = value;
    }
  }
  return clean;
}

const consoleSink: LogSink = (level, line) => {
  // Separate console methods let Workers Logs record the right level.
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else if (level === 'debug') console.debug(line);
  else console.log(line);
};

export function createLogger(base: LogFields = {}, sink: LogSink = consoleSink): Logger {
  const emit = (level: LogLevel, event: string, fields: LogFields = {}): void => {
    sink(level, JSON.stringify({ level, event, ...sanitiseFields({ ...base, ...fields }) }));
  };
  return {
    debug: (event, fields) => {
      emit('debug', event, fields);
    },
    info: (event, fields) => {
      emit('info', event, fields);
    },
    warn: (event, fields) => {
      emit('warn', event, fields);
    },
    error: (event, fields) => {
      emit('error', event, fields);
    },
    child: (fields) => createLogger({ ...base, ...fields }, sink),
  };
}

export const silentLogger: Logger = createLogger({}, () => undefined);

/** A short, non-sensitive description of an unknown thrown value. */
export function errorCode(error: unknown): string {
  if (error && typeof error === 'object' && 'code' in error && typeof error.code === 'string') {
    return error.code;
  }
  if (error instanceof Error) return error.name;
  return 'unknown_error';
}
