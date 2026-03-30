import { STATUS_CODES } from "node:http";

export class HttpError extends Error {
  readonly statusCode: number;
  readonly body?: unknown;

  constructor(statusCode: number, message: string, body?: unknown) {
    super(message);
    this.name = "HttpError";
    this.statusCode = statusCode;
    this.body = body;
  }
}

export function buildOpenAiError(statusCode: number, message: string): Record<string, unknown> {
  const status = statusCode > 0 ? statusCode : 500;
  let type = "invalid_request_error";
  let code: string | undefined;

  switch (status) {
    case 401:
      type = "authentication_error";
      code = "invalid_api_key";
      break;
    case 403:
      type = "permission_error";
      code = "insufficient_quota";
      break;
    case 404:
      type = "invalid_request_error";
      code = "model_not_found";
      break;
    case 429:
      type = "rate_limit_error";
      code = "rate_limit_exceeded";
      break;
    default:
      if (status >= 500) {
        type = "server_error";
        code = "internal_server_error";
      }
      break;
  }

  return {
    error: {
      message: message || STATUS_CODES[status] || "Internal Server Error",
      type,
      ...(code ? { code } : {})
    }
  };
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message) {
    return error.message;
  }
  return String(error);
}
