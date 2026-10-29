// Request-body validation middleware. Runs the body through a Zod schema; on
// failure it raises the same HttpError every other route uses, so the client
// sees one error shape instead of a raw Zod issue list.

import type { RequestHandler } from "express";

import { HttpError } from "./exceptions.js";
import type { FieldError } from "./exceptions.js";
import type { AppRequest } from "./request.js";
import type { ZodType, infer as ZodInfer } from "zod";

function fieldErrors(issues: { path: PropertyKey[]; message: string }[]): FieldError[] {
  return issues.map((issue) => ({
    path: issue.path.map((part) => String(part)).join("."),
    message: issue.message,
  }));
}

// One string for `error.message`, the per-field list for `error.details`.
// A form can fail two fields at once; joining them keeps a client that only
// prints `message` from hiding the second one.
function validationMessage(details: FieldError[]): string {
  if (details.length === 0) return "Request validation failed";
  return details
    .map((detail) => (detail.path ? `${detail.path}: ${detail.message}` : detail.message))
    .join("; ");
}

function validateBody(schema: ZodType): RequestHandler {
  return (req, _res, next) => {
    const result = schema.safeParse(req.body ?? {});
    if (!result.success) {
      const details = fieldErrors(result.error.issues);
      next(
        new HttpError(422, validationMessage(details), null, {
          code: "validation_error",
          details,
        })
      );
      return;
    }
    // Express hands plain Requests to middleware; this is where the extra
    // field gets written, so this is the one place that widens the type.
    (req as AppRequest).validated = result.data;
    next();
  };
}

// Reads back what validateBody stored, typed by the schema.
//
// The link between the schema a route validates with and the schema a handler
// reads back is the one thing the compiler cannot check, so the assertion lives
// here, once, instead of at every handler. Pass the same schema to both.
function validatedBody<T extends ZodType>(req: AppRequest, _schema: T): ZodInfer<T> {
  return req.validated as ZodInfer<T>;
}

export { validateBody, validatedBody };
