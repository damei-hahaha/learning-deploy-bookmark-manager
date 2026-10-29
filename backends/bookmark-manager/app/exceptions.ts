// HTTP error type + centralized error handling.
//
// Every error response this process writes uses the same JSON shape, whether
// it came from a thrown HttpError, a Zod failure, a rate limit, a missing
// route, or a crash:
//
//   { "error": { "status": 401, "code": "invalid_credentials", "message": "..." } }
//
// `details` is added only when a field-level list exists (validation).

import type { ErrorRequestHandler, NextFunction, RequestHandler, Response } from "express";

import type { AppRequest } from "./request.js";

import { makeLogger } from "./logging_config.js";

const logger = makeLogger("app.exceptions");

type ErrorHeaders = Record<string, string>;

interface FieldError {
  path: string;
  message: string;
}

interface HttpErrorOptions {
  code?: string;
  details?: FieldError[];
}

interface ApiErrorBody {
  error: {
    status: number;
    code: string;
    message: string;
    details?: FieldError[];
  };
}

const CODE_FOR_STATUS: Record<number, string> = {
  400: "bad_request",
  401: "unauthorized",
  403: "forbidden",
  404: "not_found",
  409: "conflict",
  422: "validation_error",
  429: "too_many_requests",
  500: "internal_error",
};

function codeForStatus(status: number): string {
  return CODE_FOR_STATUS[status] ?? "error";
}

function apiErrorBody(status: number, message: string, options: HttpErrorOptions = {}): ApiErrorBody {
  const body: ApiErrorBody = {
    error: {
      status,
      code: options.code ?? codeForStatus(status),
      message,
    },
  };
  if (options.details && options.details.length > 0) body.error.details = options.details;
  return body;
}

function sendError(res: Response, status: number, message: string, options: HttpErrorOptions = {}): void {
  res.status(status).json(apiErrorBody(status, message, options));
}

// Raised inside handlers to short-circuit with a status code and detail.
// `headers` lets auth routes set WWW-Authenticate. `options.code` overrides the
// status-derived code when the status alone is ambiguous (401 is both a bad
// password and a missing token).
class HttpError extends Error {
  statusCode: number;
  detail: string;
  headers: ErrorHeaders | null;
  code: string;
  details: FieldError[] | null;

  constructor(
    statusCode: number,
    detail: string,
    headers: ErrorHeaders | null = null,
    options: HttpErrorOptions = {}
  ) {
    super(detail);
    this.statusCode = statusCode;
    this.detail = detail;
    this.headers = headers;
    this.code = options.code ?? codeForStatus(statusCode);
    this.details = options.details ?? null;
  }
}

// Prisma reports a unique-constraint violation as code "P2002". A caught value
// is `unknown` in TypeScript, so the shape is checked rather than assumed.
function isPrismaErrorWithCode(err: unknown, code: string): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code?: unknown }).code === code
  );
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.stack ?? err.message;
  return String(err);
}

// Wrap an async handler so thrown errors reach the error middleware (Express 4
// doesn't forward rejected promises automatically).
// The callback receives an AppRequest rather than a bare Request, which is what
// lets handlers reach for req.user, req.tokenPayload and req.validated.
// AppRequest only adds optional fields to Request, so widening here is sound.
function asyncHandler(
  fn: (req: AppRequest, res: Response, next: NextFunction) => unknown
): RequestHandler {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

// body-parser rejects invalid JSON as a SyntaxError and stamps status 400 on it.
// The message quotes the offending text, so the client gets a fixed sentence
// and the raw error stays in the log.
function isMalformedJson(err: unknown): err is SyntaxError {
  if (!(err instanceof SyntaxError)) return false;
  const status = (err as { status?: unknown; statusCode?: unknown }).status;
  const statusCode = (err as { statusCode?: unknown }).statusCode;
  return status === 400 || statusCode === 400;
}

// No route matched. Registered after the routers and before the error handler,
// so a missing path is JSON like every other failure instead of Express's HTML.
const notFoundHandler: RequestHandler = (_req, res) => {
  sendError(res, 404, "Not found");
};

// Express error middleware — must be registered last. Maps HttpError, malformed
// JSON, Prisma unique-constraint violations (P2002 → 409), and everything else
// (500). All of them leave through sendError.
const errorHandler: ErrorRequestHandler = (err, req, res, _next) => {
  if (err instanceof HttpError) {
    if (err.headers) res.set(err.headers);
    sendError(res, err.statusCode, err.detail, {
      code: err.code,
      details: err.details ?? undefined,
    });
    return;
  }

  if (isMalformedJson(err)) {
    logger.warning(`Malformed JSON on ${req.path}: ${err.message}`);
    sendError(res, 400, "Malformed JSON body");
    return;
  }

  if (isPrismaErrorWithCode(err, "P2002")) {
    logger.warning(`DB integrity error on ${req.path}: ${errorMessage(err)}`);
    sendError(res, 409, "Database integrity error (likely a uniqueness conflict)");
    return;
  }

  logger.error(`Unhandled exception on ${req.path}: ${errorMessage(err)}`);
  sendError(res, 500, "Internal server error");
};

export { HttpError, asyncHandler, errorHandler, notFoundHandler, sendError, isPrismaErrorWithCode };
export type { ErrorHeaders, FieldError, HttpErrorOptions, ApiErrorBody };
