import { Schema } from "effect"
import { PositiveInt, withStatics } from "@/util/schema"
import { zod } from "@/util/effect-zod"

export const Info = Schema.Struct({
  enabled: Schema.optional(Schema.Boolean).annotate({
    description: "Enable persistent memory across sessions",
  }),
  auto: Schema.optional(Schema.Boolean).annotate({
    description: "Automatically extract durable memories in the background",
  }),
  auto_on_compaction: Schema.optional(Schema.Boolean).annotate({
    description: "Run automatic memory extraction after successful compaction",
  }),
  user_enabled: Schema.optional(Schema.Boolean).annotate({
    description: "Enable the global user memory store",
  }),
  project_enabled: Schema.optional(Schema.Boolean).annotate({
    description: "Enable the project-local memory store",
  }),
  user_limit: Schema.optional(PositiveInt).annotate({
    description: "Maximum number of characters allowed in the global user memory store",
  }),
  project_limit: Schema.optional(PositiveInt).annotate({
    description: "Maximum number of characters allowed in the project memory store",
  }),
}).pipe(withStatics((s) => ({ zod: zod(s) })))

export type Info = Schema.Schema.Type<typeof Info>

export * as ConfigMemory from "./memory"
