import { plainToInstance } from "class-transformer";
import { validate } from "class-validator";
import { Constructor, ParamMetadata } from "../types";

export interface ValidationFailure {
  field: string;
  constraints: Record<string, string>;
}

// The @Body() parameter's declared type, read off design:paramtypes at the same
// index — same mechanism the container uses for DI. Object means no real class.
export const getBodyDtoClass = (
  controller: Constructor,
  property: string,
  paramMap: Map<number, ParamMetadata>,
): Constructor | undefined => {
  const bodyIndex = Array.from(paramMap.entries()).find(([, meta]) => meta.type === "body")?.[0];
  if (bodyIndex === undefined) return undefined;

  const paramTypes: unknown[] =
    Reflect.getOwnMetadata("design:paramtypes", controller.prototype, property) ?? [];
  const dtoClass = paramTypes[bodyIndex];

  return typeof dtoClass === "function" && dtoClass !== Object ? (dtoClass as Constructor) : undefined;
};

// plainToInstance first: class-validator checks metadata on the instance's
// constructor, and a plain parsed-JSON object is never actually one.
export const validateDto = async (
  dtoClass: Constructor,
  plainValue: unknown,
): Promise<{ instance: unknown; errors: ValidationFailure[] }> => {
  const instance = plainToInstance(dtoClass, plainValue ?? {});
  const errors = await validate(instance as object);

  return {
    instance,
    errors: errors.map((error) => ({
      field: error.property,
      constraints: error.constraints ?? {},
    })),
  };
};
