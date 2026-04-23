import z from "zod"
import { generateObject, streamObject, type ModelMessage } from "ai"
import { Context, Effect, Layer } from "effect"
import { Agent } from "@/agent/agent"
import { Auth } from "@/auth"
import { Config } from "@/config"
import { Memory } from "@/memory"
import { Plugin } from "@/plugin"
import { Provider } from "@/provider"
import { ModelID, ProviderID } from "@/provider/schema"
import { ProviderTransform } from "@/provider"
import { Log } from "@/util"

const log = Log.create({ service: "memory.sync" })

const Schema = z.object({
  operations: z
    .array(
      z.object({
        action: z.enum(["add", "replace", "remove"]),
        target: z.enum(["user", "project"]),
        content: z.string().optional(),
        oldText: z.string().optional(),
      }),
    )
    .max(3),
})

function format(snapshot: Pick<Memory.Snapshot, "title" | "used" | "limit" | "entries">) {
  return [
    `${snapshot.title} (${snapshot.used}/${snapshot.limit} chars)`,
    snapshot.entries.length ? snapshot.entries.map((entry) => `- ${entry}`).join("\n") : "- (empty)",
  ].join("\n")
}

export interface Interface {
  readonly captureCompaction: (input: {
    sessionID: string
    model: { providerID: ProviderID; modelID: ModelID }
    summary: string | undefined
  }) => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/MemorySync") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const agent = yield* Agent.Service
    const auth = yield* Auth.Service
    const config = yield* Config.Service
    const memory = yield* Memory.Service
    const plugin = yield* Plugin.Service
    const provider = yield* Provider.Service

    const captureCompaction = Effect.fn("MemorySync.captureCompaction")(function* (input: {
      sessionID: string
      model: { providerID: ProviderID; modelID: ModelID }
      summary: string | undefined
    }) {
      const task = Effect.gen(function* () {
        if (!input.summary?.trim()) return

        const cfg = yield* config.get()
        if (cfg.memory?.enabled === false) return
        if (cfg.memory?.auto === false) return
        if (cfg.memory?.auto_on_compaction === false) return

        const extractor = yield* agent.get("memory")
        if (!extractor) return

        const model = extractor.model
          ? yield* provider.getModel(extractor.model.providerID, extractor.model.modelID)
          : ((yield* provider.getSmallModel(input.model.providerID)) ??
            (yield* provider.getModel(input.model.providerID, input.model.modelID)))
        const language = yield* provider.getLanguage(model)
        const system = [extractor.prompt ?? ""].filter(Boolean)
        yield* plugin.trigger("experimental.chat.system.transform", { model }, { system })

        const [user, project] = yield* Effect.all([memory.snapshot("user"), memory.snapshot("project")], {
          concurrency: "unbounded",
        })
        const authInfo = yield* auth.get(model.providerID).pipe(Effect.orDie)
        const isOpenaiOauth = model.providerID === "openai" && authInfo?.type === "oauth"

        const messages: ModelMessage[] = [
          ...(isOpenaiOauth
            ? []
            : system.map(
                (item): ModelMessage => ({
                  role: "system",
                  content: item,
                }),
              )),
          {
            role: "user",
            content: [
              "Current user memory:",
              format(user),
              "",
              "Current project memory:",
              format(project),
              "",
              "Compaction summary:",
              input.summary.trim(),
              "",
              "Return only the structured memory operations.",
            ].join("\n"),
          },
        ]

        const params = {
          temperature: 0,
          model: language,
          messages,
          schema: Schema,
        } satisfies Parameters<typeof generateObject>[0]

        const result = isOpenaiOauth
          ? yield* Effect.promise(async () => {
              const stream = streamObject({
                ...params,
                providerOptions: ProviderTransform.providerOptions(model, {
                  instructions: system.join("\n"),
                  store: false,
                }),
                onError: () => {},
              })
              for await (const part of stream.fullStream) {
                if (part.type === "error") throw part.error
              }
              return stream.object
            })
          : yield* Effect.promise(() => generateObject(params).then((result) => result.object))

        for (const operation of result.operations) {
          const next = yield* memory.update({
            action: operation.action,
            target: operation.target,
            content: operation.content,
            oldText: operation.oldText,
          })
          log.info("applied memory operation", {
            action: operation.action,
            target: operation.target,
            success: next.success,
            message: next.message,
          })
        }
      })

      yield* task.pipe(
        Effect.catchCause((cause) =>
          Effect.sync(() =>
            log.error("failed to sync memory from compaction", {
              error: cause,
            }),
          ),
        ),
      )
    })

    return Service.of({
      captureCompaction,
    })
  }),
)

export const defaultLayer = layer.pipe(
  Layer.provide(Agent.defaultLayer),
  Layer.provide(Auth.defaultLayer),
  Layer.provide(Config.defaultLayer),
  Layer.provide(Memory.defaultLayer),
  Layer.provide(Plugin.defaultLayer),
  Layer.provide(Provider.defaultLayer),
)

export * as MemorySync from "./sync"
