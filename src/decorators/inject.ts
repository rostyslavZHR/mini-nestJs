import "reflect-metadata";
import { INJECT_TOKENS_KEY } from "../tokens";
import { Token } from "../types";


export const Inject =
  (token: Token): ParameterDecorator =>
  (target: Object, _propertyKey: string | symbol | undefined, parameterIndex: number) => {
    const tokens: Map<number, Token> =
      Reflect.getMetadata(INJECT_TOKENS_KEY, target) ?? new Map();
    tokens.set(parameterIndex, token);
    Reflect.defineMetadata(INJECT_TOKENS_KEY, tokens, target);
  };
