// Shared logging/error discipline for every command in this extension. JSON-safe
// serialization (cycles, bigints) and a describeError that NEVER throws — an uncaught
// rejection inside a command kills the Extension Host, so command bodies log through this
// and `.catch()` everything.

type ErrorData = {
  type: string;
  message?: string;
  stack?: string;
  value?: unknown;
};

function safeJsonReplacer() {
  const seen = new WeakSet<object>();

  return (_key: string, value: unknown) => {
    if (typeof value === "bigint") {
      return value.toString();
    }

    if (typeof value === "object" && value !== null) {
      if (seen.has(value)) {
        return "[Circular]";
      }

      seen.add(value);
    }

    return value;
  };
}

function cloneJsonSafe(value: unknown): unknown {
  try {
    return JSON.parse(JSON.stringify(value, safeJsonReplacer()));
  } catch {
    return String(value);
  }
}

export function describeError(error: unknown): ErrorData {
  if (error instanceof Error) {
    const errorData: ErrorData = {
      type: error.name || "Error",
      message: error.message,
    };

    if (error.stack) {
      errorData.stack = error.stack;
    }

    return errorData;
  }

  if (error === undefined) {
    return { type: "undefined" };
  }

  if (error === null) {
    return { type: "null" };
  }

  if (typeof error === "object") {
    return {
      type: "object",
      value: cloneJsonSafe(error),
    };
  }

  return {
    type: typeof error,
    value: error,
  };
}

export function serializeLogData(data: unknown): string {
  try {
    return JSON.stringify(data, safeJsonReplacer());
  } catch (error) {
    return JSON.stringify({ serializationError: describeError(error) });
  }
}

export interface Logger {
  info: (event: string, data?: unknown) => void;
  warn: (event: string, data?: unknown) => void;
  error: (event: string, data?: unknown) => void;
}

export function createLogger(scope: string): Logger {
  const emit = (level: "info" | "warn" | "error", event: string, data?: unknown) => {
    const message =
      data === undefined ? `[${scope}] ${event}` : `[${scope}] ${event} ${serializeLogData(data)}`;

    if (level === "info") {
      console.log(message);
      return;
    }

    if (level === "warn") {
      console.warn(message);
      return;
    }

    console.error(message);
  };

  return {
    info: (event: string, data?: unknown) => emit("info", event, data),
    warn: (event: string, data?: unknown) => emit("warn", event, data),
    error: (event: string, data?: unknown) => emit("error", event, data),
  };
}
