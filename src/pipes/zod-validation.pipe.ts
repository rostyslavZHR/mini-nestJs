import { ZodType } from "zod";
import { ParamMetadata } from "../types";

// A Zod schema isn't a class, so it can't be found on design:paramtypes the
// way a DTO would be — @Body(schema) attaches it explicitly instead.
const getBodySchema = (paramMap: Map<number, ParamMetadata>): ZodType | undefined => {
  for (const meta of paramMap.values()) {
    if (meta.type === "body") return meta.schema;
  }
  return undefined;
};

// Lets ZodError propagate — the filter maps it to a status code, not this pipe.
export const validateBody = (paramMap: Map<number, ParamMetadata>, value: unknown): unknown => {
  const schema = getBodySchema(paramMap);
  return schema ? schema.parse(value) : value;
};
