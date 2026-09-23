/**
 * Browser entry for the Skills-Manager plugin. tsdown bundles this module (and
 * everything it imports except `react`) into `client/client.js`, wrapped in a
 * `window.__ModuleLoader__.load({ id, factory })` closure. The DSH client
 * runtime reads the exported `inject` to require the `slots` and `locale`
 * services, then calls `apply(ctx)`.
 *
 * `apply` registers the panel's i18n dictionaries and contributes the
 * {@link SkillManagerSection} component into the host's `settings.section` slot,
 * so the panel appears as a page inside the harness settings dialog. The host
 * half is reached only over the `fetch` HTTP seam in `./api.ts`.
 *
 * @module @dsh-skills-manager/dsh-skills-manager/client
 */

import { DICT, LOCALE_NAMESPACE } from './locales.ts'
import { SkillManagerSection, type SectionProps, type Translate } from './section.ts'

/** Loader-visible plugin name. */
export const name = '@dsh-skills-manager/dsh-skills-manager/client'

/** Client services this entry consumes: the slot registry and the locale face. */
export const inject = ['slots', 'locale']

/** The locale service face this plugin uses (duck-typed to stay bundler-local). */
interface LocaleFace {
  /** Register a namespace's zh/en dictionaries; returns the unregister disposer. */
  register(namespace: string, dictionary: Record<string, Record<string, string>>): () => void
  /** Bind a namespace, returning its translate function. */
  bind(namespace: string): Translate
}

/** The slot registry face this plugin uses (duck-typed to stay bundler-local). */
interface SlotsFace {
  /** Contribute into a declared slot; the factory performs the registration. */
  inject(name: string, factory: () => unknown): unknown
  /** Register a component into a slot with its nav identity options. */
  register(options: Record<string, unknown>, component: (props: SectionProps) => unknown): unknown
}

/** The minimal client Cordis context this entry relies on. */
interface ClientContext {
  /** Run an effect owned by the plugin fiber; a returned function is its disposer. */
  effect(effect: () => void | (() => void), label?: string): unknown
  locale: LocaleFace
  slots: SlotsFace
}

/**
 * Register the panel's copy and contribute its settings section. The locale
 * registration rides an effect so its dictionary is withdrawn on unload; the
 * slot contribution is fiber-owned directly (its disposer is returned to the
 * runtime by `slots.inject`).
 * @param ctx - the client Cordis context carrying `slots` and `locale`.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(LOCALE_NAMESPACE, DICT), 'skills-manager: locale')
  ctx.slots.inject('settings.section', () =>
    ctx.slots.register(
      {
        name: 'settings.section',
        id: 'skills-manager',
        order: 40,
        label: () => ctx.locale.bind(LOCALE_NAMESPACE)('title'),
        icon: 'skill',
        locale: LOCALE_NAMESPACE,
      },
      SkillManagerSection,
    ),
  )
}
