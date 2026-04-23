import { describe, expect } from "bun:test"
import path from "path"
import { Effect, Layer } from "effect"
import * as CrossSpawnSpawner from "../../src/effect/cross-spawn-spawner"
import { Global } from "../../src/global"
import { Memory } from "../../src/memory"
import { provideTmpdirInstance, tmpdirScoped } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const it = testEffect(Layer.mergeAll(Memory.defaultLayer, CrossSpawnSpawner.defaultLayer))

describe("memory.service", () => {
  it.live("writes project and user memory to separate stores", () =>
    Effect.gen(function* () {
      const home = yield* tmpdirScoped()
      const previous = Global.Path.data
      ;(Global.Path as { data: string }).data = path.join(home, "global-data")
      try {
        return yield* provideTmpdirInstance(
          () =>
            Effect.gen(function* () {
              const memory = yield* Memory.Service

              const user = yield* memory.update({
                action: "add",
                target: "user",
                content: "User prefers short progress updates.",
              })
              const project = yield* memory.update({
                action: "add",
                target: "project",
                content: "Run type checks from packages/opencode with bun typecheck.",
              })
              const prompt = yield* memory.system()

              expect(user.success).toBe(true)
              expect(project.success).toBe(true)
              expect(user.path.endsWith(path.join("memory", "USER.md"))).toBe(true)
              expect(project.path.endsWith(path.join(".opencode", "memory", "PROJECT.md"))).toBe(true)
              expect(prompt).toContain("Persistent memory is available across sessions.")
              expect(prompt).toContain("USER MEMORY")
              expect(prompt).toContain("PROJECT MEMORY")
            }),
          { git: true },
        )
      } finally {
        ;(Global.Path as { data: string }).data = previous
      }
    }),
  )

  it.live("rejects updates that exceed the configured limit", () =>
    provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          const memory = yield* Memory.Service
          const result = yield* memory.update({
            action: "add",
            target: "project",
            content: "x".repeat(20),
          })
          expect(result.success).toBe(false)
          expect(result.message).toContain("Limit is 10 characters")
        }),
      {
        git: true,
        config: {
          memory: {
            project_limit: 10,
          },
        },
      },
    ),
  )
})
