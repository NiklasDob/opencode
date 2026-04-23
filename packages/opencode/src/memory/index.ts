import path from "path"
import { Context, Effect, Layer } from "effect"
import { AppFileSystem } from "@opencode-ai/shared/filesystem"
import { Config } from "@/config"
import { InstanceState } from "@/effect"
import { Global } from "@/global"

export type Target = "user" | "project"

export type Snapshot = {
  target: Target
  title: string
  path: string
  enabled: boolean
  limit: number
  used: number
  entries: string[]
}

export type MutationResult = Snapshot & {
  success: boolean
  message: string
}

const HEADER = {
  user: "User Memory",
  project: "Project Memory",
} as const

const LIMIT = {
  user: 1375,
  project: 2200,
} as const

const SECTION = "## Entries"
const SEPARATOR = "\n§\n"
const SECRET = /(api[_-]?key|access[_-]?token|password|private key|ssh-rsa|gh[pousr]_|sk-[a-z0-9]|bearer\s+[a-z0-9._-]+)/i

function normalize(input: string) {
  return input.trim().replaceAll("\r\n", "\n")
}

function usage(entries: string[]) {
  return entries.reduce((sum, entry) => sum + entry.length, 0)
}

function body(text: string) {
  const idx = text.indexOf(SECTION)
  if (idx === -1) return text.trim()
  return text.slice(idx + SECTION.length).trim()
}

function parse(text: string) {
  const parsed = body(text)
  if (!parsed || parsed === "(empty)") return []
  return parsed
    .split(SEPARATOR)
    .map((entry) => entry.replace(/^§\n?/, "").trim())
    .filter(Boolean)
}

function render(snapshot: Snapshot) {
  return [
    `# ${snapshot.title}`,
    "",
    "Managed by opencode persistent memory. Keep entries concise, durable, and secret-free.",
    "",
    SECTION,
    snapshot.entries.length ? snapshot.entries.map((entry) => `§\n${entry}`).join("\n") : "(empty)",
    "",
  ].join("\n")
}

function format(snapshot: Snapshot) {
  return [
    `${snapshot.title.toUpperCase()} [${Math.round((snapshot.used / snapshot.limit) * 100) || 0}% — ${snapshot.used}/${snapshot.limit} chars]`,
    snapshot.entries.length ? snapshot.entries.map((entry) => `§ ${entry}`).join("\n") : "(empty)",
  ].join("\n")
}

function ensureUnique(entries: string[], needle: string) {
  const matches = entries.filter((entry) => entry.includes(needle))
  if (matches.length === 1) return matches[0]
  if (matches.length > 1) return "multiple"
  return
}

export interface Interface {
  readonly snapshot: (target: Target) => Effect.Effect<Snapshot>
  readonly system: () => Effect.Effect<string | undefined>
  readonly update: (input: {
    action: "add" | "replace" | "remove" | "show"
    target: Target
    content?: string
    oldText?: string
  }) => Effect.Effect<MutationResult>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Memory") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const fs = yield* AppFileSystem.Service
    const config = yield* Config.Service

    const resolve = Effect.fn("Memory.resolve")(function* (target: Target) {
      const ctx = yield* InstanceState.context
      const info = (yield* config.get()).memory
      return {
        target,
        title: HEADER[target],
        enabled:
          info?.enabled !== false && (target === "user" ? info?.user_enabled !== false : info?.project_enabled !== false),
        limit: target === "user" ? (info?.user_limit ?? LIMIT.user) : (info?.project_limit ?? LIMIT.project),
        path:
          target === "user"
            ? path.join(Global.Path.data, "memory", "USER.md")
            : path.join(ctx.worktree, ".opencode", "memory", "PROJECT.md"),
      }
    })

    const snapshot = Effect.fn("Memory.snapshot")(function* (target: Target) {
      const base = yield* resolve(target)
      if (!base.enabled) return { ...base, used: 0, entries: [] }
      const text = yield* fs.readFileString(base.path).pipe(Effect.catch(() => Effect.succeed("")))
      const entries = parse(text)
      return {
        ...base,
        entries,
        used: usage(entries),
      }
    })

    const reject = (current: Snapshot, message: string): MutationResult => ({
      ...current,
      success: false,
      message,
    })

    const update = Effect.fn("Memory.update")(function* (input: {
      action: "add" | "replace" | "remove" | "show"
      target: Target
      content?: string
      oldText?: string
    }) {
      const current = yield* snapshot(input.target)
      if (!current.enabled) return reject(current, `${current.title} is disabled in config.`)
      if (input.action === "show") return { ...current, success: true, message: `Loaded ${current.title}.` }

      const content = input.content ? normalize(input.content) : ""
      const oldText = input.oldText ? normalize(input.oldText) : ""

      if ((input.action === "add" || input.action === "replace") && !content) {
        return reject(current, "content is required for add and replace.")
      }
      if ((input.action === "replace" || input.action === "remove") && !oldText) {
        return reject(current, "old_text is required for replace and remove.")
      }
      if (content && SECRET.test(content)) {
        return reject(current, "Refusing to store secrets or credentials in persistent memory.")
      }
      if (content.length > current.limit) {
        return reject(current, `Entry is too large for ${current.title}. Limit is ${current.limit} characters.`)
      }
      if (input.action === "add" && current.entries.includes(content)) {
        return { ...current, success: true, message: "Exact entry already exists. No duplicate added." }
      }

      const matched = oldText ? ensureUnique(current.entries, oldText) : undefined
      if (matched === "multiple") {
        return reject(current, "old_text matched multiple entries. Use a more specific substring.")
      }
      if ((input.action === "replace" || input.action === "remove") && !matched) {
        return reject(current, "old_text did not match any entry.")
      }

      const entries =
        input.action === "add"
          ? [...current.entries, content]
          : input.action === "replace"
            ? current.entries.map((entry) => (entry === matched ? content : entry))
            : current.entries.filter((entry) => entry !== matched)
      const next = {
        ...current,
        entries,
        used: usage(entries),
      }
      if (next.used > next.limit) {
        return reject(
          current,
          `${current.title} is at ${current.used}/${current.limit} characters. This change would exceed the limit.`,
        )
      }

      yield* fs.writeWithDirs(next.path, render(next)).pipe(Effect.orDie)
      return {
        ...next,
        success: true,
        message:
          input.action === "add"
            ? `Added entry to ${next.title}.`
            : input.action === "replace"
              ? `Updated entry in ${next.title}.`
              : `Removed entry from ${next.title}.`,
      }
    })

    const system = Effect.fn("Memory.system")(function* () {
      const visible = (yield* Effect.all([snapshot("user"), snapshot("project")], { concurrency: "unbounded" })).filter(
        (item) => item.enabled,
      )
      if (visible.length === 0) return
      return [
        "Persistent memory is available across sessions.",
        "Use the memory tool proactively to save durable user preferences, project conventions, repeated workflows, and lessons learned.",
        "Do not store secrets, credentials, or one-off task chatter.",
        "",
        ...visible.map(format),
      ].join("\n\n")
    })

    return Service.of({
      snapshot,
      system,
      update,
    })
  }),
)

export const defaultLayer = layer.pipe(Layer.provide(Config.defaultLayer), Layer.provide(AppFileSystem.defaultLayer))

export * as Memory from "./index"
