import { IncomingMessage } from 'node:http'
import { ZodType } from 'zod'

export type DecoratorScope = 'singleton' | 'transient'

export type Constructor<T = unknown> = new (...args: any[]) => T

export type Token = string | symbol

export type ParamMetadata =
  | { type: 'body'; schema?: ZodType }
  | { type: 'param'; name: string }
  | { type: 'query'; name: string }


export type LifecycleStage = "middleware" | "guard" | "interceptor:before" | "pipe" | "handler" | "interceptor:after" | "exception-filter"

export interface ExecutionContext {
  req: IncomingMessage
  controller: Constructor
  property: string
  params: Record<string, string>
}

export interface CanActivate {
  canActivate(context: ExecutionContext): boolean | Promise<boolean>
}

export type NextFn = () => Promise<unknown>

export interface Interceptor {
  intercept(context: ExecutionContext, next: NextFn): unknown | Promise<unknown>
}