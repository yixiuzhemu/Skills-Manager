/**
 * Plugin entry for the Skills-Manager host half. Declares the config schema,
 * the `skills` service dependency, and the `apply` body that instantiates the
 * {@link SkillsManager} service, registers its `ctx.skills` provider, and drives
 * the store lifecycle through a Cordis effect. Augments the Cordis `Context` so
 * consumers read `ctx.skillsManager`, and re-exports the public vocabulary.
 *
 * @module @dsh-skills-manager/dsh-skills-manager
 */

import Schema from '@deepseek-ai/schemastery'
import type { Context } from '@deepseek-ai/cordis'
import { SkillsManager, type SkillsManagerConfig } from './service.ts'
import { registerHttpApi } from './http.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** The host skills manager service provided by this plugin. */
    skillsManager: SkillsManager
  }
}

/** Plugin configuration schema; defaults resolve to a zero-config local setup. */
export const Config = Schema.object({
  projectRoot: Schema.string().default(''),
  extraDirs: Schema.array(Schema.string()).default([]),
  agentRoots: Schema.object({
    codex: Schema.string().default(''),
    claude: Schema.string().default(''),
    copilot: Schema.string().default(''),
  }).default({ codex: '', claude: '', copilot: '' }),
  githubApiBase: Schema.string().default('https://api.github.com'),
  githubRawBase: Schema.string().default('https://raw.githubusercontent.com'),
  githubToken: Schema.string().default(''),
  trashRetentionDays: Schema.number().default(30),
  scanOnStart: Schema.boolean().default(true),
})

/**
 * The plugin loads once the skill registry is available to register into, and
 * once the host web server can accept the client's HTTP route.
 */
export const inject = ['skills', 'webServer']

/**
 * Instantiate the manager, register its skill provider synchronously (per the
 * `ctx.skills` contract), expose its operations to the browser client over one
 * `ctx.webServer` prefix route, and drive store startup/teardown through an
 * effect so disposal cleanly stops every file watcher.
 * @param ctx - the plugin context.
 * @param config - the resolved plugin configuration.
 */
export function apply(ctx: Context, config: SkillsManagerConfig): void {
  const manager = new SkillsManager(ctx, config)
  // Register synchronously during apply; the returned disposer is fiber-owned
  // and unregisters the provider automatically on unload.
  ctx.skills.registerProvider(control => manager.createProvider(control))
  // The HTTP seam is the live host↔client transport; its disposer is fiber-owned.
  ctx.effect(() => registerHttpApi(manager, route => ctx.webServer.register(route)), 'skills-manager-http')
  // Stores open asynchronously; the effect disposer stops their watchers.
  ctx.effect(async () => {
    await manager.start()
    return () => {
      manager.stop()
    }
  }, 'skills-manager')
}

export { SkillsManager, type SkillsManagerConfig } from './service.ts'
export type {
  CompanySkillSource,
  CreateParams,
  DiffHunk,
  DiffLine,
  DiffResult,
  ImportParams,
  RepoConfig,
  RepoSkillItem,
  SkillFrontmatter,
  SkillRecord,
  SkillSource,
  SourceDetail,
  TrashRecord,
  UpdateInfo,
} from './types.ts'
