import { ZodType } from "zod";
import { ParamMetadata } from "../types";

// A Zod schema isn't a class, so unlike a DTO it can't be found on
// design:paramtypes — @Body(schema) attaches it explicitly instead, and this
// is where it's read back out. Mirrors the old validation.pipe.ts's shape:
// that one owned both finding the DTO class and running class-validator
// against it, not just the validation call — the dispatcher shouldn't need
// to know how a body's schema is attached to validate it.
const getBodySchema = (paramMap: Map<number, ParamMetadata>): ZodType | undefined => {
  for (const meta of paramMap.values()) {
    if (meta.type === "body") return meta.schema;
  }
  return undefined;
};

// Lets ZodError propagate rather than mapping it to an HttpError here — the
// thrower speaks domain language (validation failed), the filter decides
// what HTTP status that means. Returns the value unchanged when no schema is
// attached, same as an untyped @Body() skipping validation before.
export const validateBody = (paramMap: Map<number, ParamMetadata>, value: unknown): unknown => {
  const schema = getBodySchema(paramMap);
  return schema ? schema.parse(value) : value;
};
