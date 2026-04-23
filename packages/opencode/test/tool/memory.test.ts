import { describe, expect } from "bun:test"
import path from "path"
import { Effect, Layer } from "effect"
import { Agent } from "../../src/agent/agent"
import * as CrossSpawnSpawner from "../../src/effect/cross-spawn-spawner"
import { Global } from "../../src/global"
import { Memory } from "../../src/memory"
import { MessageID, SessionID } from "../../src/session/schema"
import { Truncate } from "../../src/tool"
import { MemoryTool } from "../../src/tool/memory"
import { provideTmpdirInstance, tmpdirScoped } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const ctx = {
  sessionID: SessionID.make("ses_test-session"),
  messageID: MessageID.make("msg_test-message"),
  callID: "test-call",
  agent: "build",
  abort: AbortSignal.any([]),
  messages: [],
  metadata: () => Effect.void,
  ask: () => Effect.void,
}

const layer = Layer.mergeAll(Memory.defaultLayer, CrossSpawnSpawner.defaultLayer, Truncate.defaultLayer, Agent.defaultLayer)
const it = testEffect(layer)

describe("tool.memory", () => {
  it.live("adds and replaces project memory entries", () =>
    Effect.gen(function* () {
      const home = yield* tmpdirScoped()
      const previous = Global.Path.data
      ;(Global.Path as { data: string }).data = path.join(home, "global-data")
      try {
        return yield* provideTmpdirInstance(
          () =>
            Effect.gen(function* () {
              const info = yield* MemoryTool
              const tool = yield* info.init()

              const added = yield* tool.execute(
                {
                  action: "add",
                  target: "project",
                  content: "Project uses Bun workspaces.",
                },
                ctx,
              )
              const replaced = yield* tool.execute(
                {
                  action: "replace",
                  target: "project",
                  old_text: "Bun workspaces",
                  content: "Project uses Bun workspaces and packages/opencode is the core package.",
                },
                ctx,
              )

              expect(added.metadata.success).toBe(true)
              expect(replaced.metadata.success).toBe(true)
              expect(replaced.output).toContain("packages/opencode is the core package")
            }),
          { git: true },
        )
      } finally {
        ;(Global.Path as { data: string }).data = previous
      }
    }),
  )
})
