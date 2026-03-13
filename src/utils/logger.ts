const levels = ['debug', 'info', 'warn', 'error'] as const;

export type LogLevel = (typeof levels)[number];

export type LogContext = Record<string, unknown> | undefined;

function shouldLog(currentLevel: LogLevel, requestedLevel: LogLevel): boolean {
  return levels.indexOf(requestedLevel) >= levels.indexOf(currentLevel);
}

export class Logger {
  public constructor(
    private readonly scope: string,
    private readonly level: LogLevel
  ) {}

  public child(scope: string): Logger {
    return new Logger(`${this.scope}:${scope}`, this.level);
  }

  public debug(message: string, context?: LogContext): void {
    this.write('debug', message, context);
  }

  public info(message: string, context?: LogContext): void {
    this.write('info', message, context);
  }

  public warn(message: string, context?: LogContext): void {
    this.write('warn', message, context);
  }

  public error(message: string, context?: LogContext): void {
    this.write('error', message, context);
  }

  private write(level: LogLevel, message: string, context?: LogContext): void {
    if (!shouldLog(this.level, level)) {
      return;
    }

    const payload = {
      timestamp: new Date().toISOString(),
      level,
      scope: this.scope,
      message,
      context,
    };

    process.stderr.write(`${JSON.stringify(payload)}\n`);
  }
}

export function parseLogLevel(value: string | undefined): LogLevel {
  if (value && levels.includes(value as LogLevel)) {
    return value as LogLevel;
  }

  return 'info';
}
