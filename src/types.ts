export type DecoratorScope = 'singleton' | 'transient'

export type Constructor<T = unknown> = new (...args: any[]) => T

export type Token = string | symbol

export type ParamMetadata =
  | { type: 'body' }
  | { type: 'param'; name: string }
  | { type: 'query'; name: string }
