export * as ServerAuth from "./auth"

import { Config as EffectConfig, Context, Effect, Layer, Option, Redacted } from "effect"

export type Credentials = {
  password?: string
  username?: string
}

export type DecodedCredentials = {
  readonly username: string
  readonly password: Redacted.Redacted
}

export type Info = {
  readonly password: Option.Option<string>
  readonly username: string
}

export class Config extends Context.Service<Config, Info>()("@opencode/ServerAuthConfig") {
  static configLayer(input: Info) {
    return Layer.succeed(this, this.of(input))
  }

  static get layer() {
    return Layer.effect(
      this,
      Effect.gen(function* () {
        return Config.of(
          yield* EffectConfig.all({
            password: EffectConfig.string("GHOSTCODE_SERVER_PASSWORD").pipe(
              EffectConfig.orElse(() => EffectConfig.string("OPENCODE_SERVER_PASSWORD")),
              EffectConfig.option,
            ),
            username: EffectConfig.string("GHOSTCODE_SERVER_USERNAME").pipe(
              EffectConfig.orElse(() => EffectConfig.string("OPENCODE_SERVER_USERNAME")),
              EffectConfig.withDefault("ghostcode"),
            ),
          }),
        )
      }),
    )
  }
}

export function required(config: Info) {
  return Option.isSome(config.password) && config.password.value !== ""
}

export function authorized(credentials: DecodedCredentials, config: Info) {
  return (
    Option.isSome(config.password) &&
    credentials.username === config.username &&
    Redacted.value(credentials.password) === config.password.value
  )
}

export function header(credentials?: Credentials) {
  const password = credentials?.password ?? process.env.GHOSTCODE_SERVER_PASSWORD ?? process.env.OPENCODE_SERVER_PASSWORD
  if (!password) return undefined

  return `Basic ${Buffer.from(`${credentials?.username ?? process.env.GHOSTCODE_SERVER_USERNAME ?? process.env.OPENCODE_SERVER_USERNAME ?? "ghostcode"}:${password}`).toString("base64")}`
}

export function headers(credentials?: Credentials) {
  const authorization = header(credentials)
  if (!authorization) return undefined
  return { Authorization: authorization }
}
