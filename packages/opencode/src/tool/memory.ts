import z from "zod"
import { Effect } from "effect"
import * as Tool from "./tool"
import DESCRIPTION from "./memory.txt"
import { Memory } from "@/memory"

const parameters = z.object({
  action: z.enum(["show", "add", "replace", "remove"]).describe("Memory action to perform"),
  target: z.enum(["user", "project"]).describe("Which memory store to update"),
  content: z.string().optional().describe("New entry content for add or replace"),
  old_text: z.string().optional().describe("Unique substring used to find an existing entry for replace or remove"),
})

type Metadata = {
  success: boolean
  target: Memory.Target
  path: string
  limit: number
  used: number
  entries: string[]
}

export const MemoryTool = Tool.define<typeof parameters, Metadata, Memory.Service>(
  "memory",
  Effect.gen(function* () {
    const memory = yield* Memory.Service

    return {
      description: DESCRIPTION,
      parameters,
      execute: (params) =>
        Effect.gen(function* () {
          const result = yield* memory.update({
            action: params.action,
            target: params.target,
            content: params.content,
            oldText: params.old_text,
          })

          return {
            title: result.title,
            output: [
              result.message,
              `Path: ${result.path}`,
              `Usage: ${result.used}/${result.limit} chars`,
              result.entries.length ? result.entries.map((entry) => `- ${entry}`).join("\n") : "- (empty)",
            ].join("\n"),
            metadata: {
              success: result.success,
              target: result.target,
              path: result.path,
              limit: result.limit,
              used: result.used,
              entries: result.entries,
            },
          }
        }),
    } satisfies Tool.DefWithoutID<typeof parameters, Metadata>
  }),
)
