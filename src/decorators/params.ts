import "reflect-metadata";
import { ZodType } from "zod";
import { PARAM_METADATA_KEY } from "../tokens";
import { ParamMetadata } from "../types";

// A Zod schema isn't a class, so it can't be found on design:paramtypes the
// way a DTO class would be — it has to be attached explicitly here instead.
export const Body =
  (schema?: ZodType): ParameterDecorator =>
  (target: Object, propertyKey: string | symbol | undefined, parameterIndex: number) => {
    if (propertyKey === undefined) {
      throw new Error("@Body() cannot be used on a constructor parameter");
    }

    const params: Map<number, ParamMetadata> =
      Reflect.getOwnMetadata(PARAM_METADATA_KEY, target, propertyKey) ?? new Map();
    params.set(parameterIndex, schema ? { type: "body", schema } : { type: "body" });
    Reflect.defineMetadata(PARAM_METADATA_KEY, params, target, propertyKey);
  };

export const Param =
  (name: string): ParameterDecorator =>
  (target: Object, propertyKey: string | symbol | undefined, parameterIndex: number) => {
    if (propertyKey === undefined) {
      throw new Error("@Param() cannot be used on a constructor parameter");
    }

    const params: Map<number, ParamMetadata> =
      Reflect.getOwnMetadata(PARAM_METADATA_KEY, target, propertyKey) ?? new Map();
    params.set(parameterIndex, { type: "param", name });
    Reflect.defineMetadata(PARAM_METADATA_KEY, params, target, propertyKey);
  };

export const Query =
  (name: string): ParameterDecorator =>
  (target: Object, propertyKey: string | symbol | undefined, parameterIndex: number) => {
    if (propertyKey === undefined) {
      throw new Error("@Query() cannot be used on a constructor parameter");
    }

    const params: Map<number, ParamMetadata> =
      Reflect.getOwnMetadata(PARAM_METADATA_KEY, target, propertyKey) ?? new Map();
    params.set(parameterIndex, { type: "query", name });
    Reflect.defineMetadata(PARAM_METADATA_KEY, params, target, propertyKey);
  };
