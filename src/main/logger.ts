import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import type { LogEntry, LogLevel } from '../common/types';

export class AppLogger extends EventEmitter {
  private readonly entries: LogEntry[] = [];

  constructor(readonly logFilePath: string) {
    super();
    fs.mkdirSync(path.dirname(logFilePath), { recursive: true });
  }

  debug(message: string, scope = 'app', data?: unknown): void {
    this.write('debug', message, scope, data);
  }

  info(message: string, scope = 'app', data?: unknown): void {
    this.write('info', message, scope, data);
  }

  warn(message: string, scope = 'app', data?: unknown): void {
    this.write('warn', message, scope, data);
  }

  error(message: string, scope = 'app', data?: unknown): void {
    this.write('error', message, scope, data);
  }

  getEntries(): LogEntry[] {
    return [...this.entries];
  }

  private write(level: LogLevel, message: string, scope: string, data?: unknown): void {
    const entry: LogEntry = {
      id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
      at: new Date().toISOString(),
      level,
      scope,
      message: redactMessage(message),
      data: redactSensitiveData(data)
    };

    this.entries.push(entry);
    if (this.entries.length > 1000) {
      this.entries.shift();
    }

    const line = JSON.stringify(entry);
    fs.appendFile(this.logFilePath, `${line}\n`, (error) => {
      if (error) {
        // Avoid recursive logging if file writing itself fails.
        console.error(error);
      }
    });

    this.emit('entry', entry);
  }
}

const SENSITIVE_KEY = /^(?:actionToken|wdtoken|token|ct|cookie|authorization|qrCodeStatusKey|session|sessionId|accessToken|refreshToken)$/i;

export function redactSensitiveData(value: unknown, depth = 0): unknown {
  if (value === undefined || value === null || depth > 10) return value;
  if (Array.isArray(value)) return value.slice(0, 200).map((item) => redactSensitiveData(item, depth + 1));
  if (typeof value !== 'object') return typeof value === 'string' ? redactMessage(value) : value;
  const result: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    result[key] = SENSITIVE_KEY.test(key) ? '[REDACTED]' : redactSensitiveData(child, depth + 1);
  }
  return result;
}

export function redactMessage(value: string): string {
  return String(value).replace(
    /\b(actionToken|wdtoken|accessToken|refreshToken|qrCodeStatusKey|authorization|cookie|sessionId|session|token|ct)\b\s*[:=]\s*([^\s,;]+)/gi,
    '$1=[REDACTED]'
  );
}
