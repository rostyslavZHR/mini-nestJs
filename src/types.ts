export type DecoratorScope = 'singleton' | 'transient'

export type Constructor<T = unknown> = new (...args: any[]) => T

export type Token = string | symbol
