/**
 * The Skills-Manager settings panel: one React component tree registered into
 * the host's `settings.section` slot. It talks to the host exclusively through
 * the typed {@link api} HTTP surface and renders five tabs — skills, trash,
 * repository sources, company sources, and updates (with a diff viewer).
 *
 * The component is written with `React.createElement` (aliased `h`) rather than
 * JSX so the browser bundle depends only on the `react` module the loader seeds,
 * never on `react/jsx-runtime`. Copy arrives through the framework-injected `t`
 * bound to the `skills-manager` locale namespace.
 *
 * @module @dsh-skills-manager/dsh-skills-manager/client/section
 */

import * as React from 'react'
import type { DiffResult, RepoSkillItem, SkillRecord } from './wire.ts'
import { api, type CompanySkillEntry, type Snapshot } from './api.ts'
import styles from './styles.module.css'

const h = React.createElement

/** Namespace-bound translate the framework injects as the `t` prop. */
export type Translate = (key: string, params?: Record<string, unknown>) => string

/** Props the settings-section slot hands the panel (owner `close` + locale `t`). */
export interface SectionProps {
  t: Translate
  close?: () => void
}

/** The five panel tabs. */
type Tab = 'skills' | 'trash' | 'repos' | 'company' | 'updates'

/** Discriminated modal state. */
type Modal =
  | { kind: 'detail'; id: string }
  | { kind: 'diff'; id: string }
  | { kind: 'create' }
  | { kind: 'import' }
  | { kind: 'repo-add' }
  | { kind: 'company-add' }
  | { kind: 'confirm-delete'; id: string; name: string }
  | { kind: 'confirm-purge'; trashId: string; name: string }
  | null

/** A transient result banner. */
type Notice = { text: string; kind: 'ok' | 'error' } | null

/** Join truthy class names into one string. */
function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter((part): part is string => typeof part === 'string' && part.length > 0).join(' ')
}

/** Best-effort human-readable message for a caught value. */
function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error ?? 'unknown error')
}

/** Localize a skill source key, falling back to the raw key. */
function sourceLabel(t: Translate, source: string): string {
  const value = t(`source.${source}`)
  return value === `source.${source}` ? source : value
}

/** Format an epoch-millisecond timestamp for the current locale. */
function formatTime(value: number): string {
  return new Date(value).toLocaleString()
}

// ── Presentational primitives ───────────────────────────────────────────────

/** An on/off toggle rendered as an ARIA switch button. */
function Switch(props: { on: boolean; disabled?: boolean; label: string; onClick: () => void }): React.ReactNode {
  return h('button', {
    type: 'button',
    role: 'switch',
    'aria-checked': props.on,
    'aria-label': props.label,
    className: cx(styles.switch, props.on ? styles.switchOn : undefined),
    disabled: props.disabled === true,
    onClick: props.onClick,
  })
}

/** A labelled form row. */
function Field(props: { label: string; children?: React.ReactNode }): React.ReactNode {
  return h('label', { className: styles.field }, h('span', { className: styles.label }, props.label), props.children)
}

/** A centered modal dialog with a title bar and close button. */
function Modal(props: { title: string; closeLabel: string; wide?: boolean; onClose: () => void; children?: React.ReactNode }): React.ReactNode {
  return h(
    'div',
    {
      className: styles.mask,
      onClick: (event: React.MouseEvent<HTMLDivElement>) => {
        if (event.target === event.currentTarget) props.onClose()
      },
    },
    h(
      'div',
      { className: cx(styles.modal, props.wide === true ? styles.modalWide : undefined), role: 'dialog', 'aria-modal': 'true' },
      h(
        'div',
        { className: styles.modalHead },
        h('h3', { className: styles.modalTitle }, props.title),
        h('button', { type: 'button', className: cx(styles.btn, styles.btnQuiet), 'aria-label': props.closeLabel, onClick: props.onClose }, '×'),
      ),
      props.children,
    ),
  )
}

// ── Main panel ──────────────────────────────────────────────────────────────

/** The registered settings section component. */
export function SkillManagerSection(props: SectionProps): React.ReactNode {
  const { t } = props

  const [data, setData] = React.useState<Snapshot | null>(null)
  const [tab, setTab] = React.useState<Tab>('skills')
  const [busy, setBusy] = React.useState(false)
  const [notice, setNotice] = React.useState<Notice>(null)
  const [query, setQuery] = React.useState('')
  const [modal, setModal] = React.useState<Modal>(null)

  const [detailBody, setDetailBody] = React.useState<string | undefined>(undefined)
  const [diff, setDiff] = React.useState<DiffResult | undefined>(undefined)
  const [updates, setUpdates] = React.useState<UpdateList>(null)

  const [repoSkills, setRepoSkills] = React.useState<Record<string, RepoSkillItem[]>>({})
  const [companySkills, setCompanySkills] = React.useState<Record<string, CompanySkillEntry[]>>({})
  const [openRepos, setOpenRepos] = React.useState<Record<string, boolean>>({})
  const [openCompany, setOpenCompany] = React.useState<Record<string, boolean>>({})

  const [createName, setCreateName] = React.useState('')
  const [createDesc, setCreateDesc] = React.useState('')
  const [createBody, setCreateBody] = React.useState('')
  const [importPath, setImportPath] = React.useState('')
  const [importType, setImportType] = React.useState<'zip' | 'folder' | 'file'>('folder')
  const [repoUrl, setRepoUrl] = React.useState('')
  const [repoBranch, setRepoBranch] = React.useState('main')
  const [companyName, setCompanyName] = React.useState('')
  const [companyType, setCompanyType] = React.useState<'api' | 'git'>('git')
  const [companyEndpoint, setCompanyEndpoint] = React.useState('')
  const [companyRepo, setCompanyRepo] = React.useState('')

  const fail = React.useCallback((error: unknown) => {
    setNotice({ text: t('error.action', { error: errorMessage(error) }), kind: 'error' })
  }, [t])

  const reload = React.useCallback(async (): Promise<void> => {
    try {
      setData(await api.state())
    } catch (error) {
      fail(error)
    }
  }, [fail])

  React.useEffect(() => {
    void reload()
  }, [reload])

  /** Run a mutation, then reload the snapshot and surface a result banner. */
  const run = React.useCallback(
    async (task: () => Promise<unknown>): Promise<boolean> => {
      setBusy(true)
      setNotice(null)
      try {
        await task()
        await reload()
        setNotice({ text: t('result.ok'), kind: 'ok' })
        return true
      } catch (error) {
        fail(error)
        return false
      } finally {
        setBusy(false)
      }
    },
    [reload, fail, t],
  )

  const loadUpdates = React.useCallback(async (): Promise<void> => {
    setBusy(true)
    try {
      setUpdates(await api.updates())
    } catch (error) {
      fail(error)
    } finally {
      setBusy(false)
    }
  }, [fail])

  React.useEffect(() => {
    if (tab === 'updates' && updates === null) void loadUpdates()
  }, [tab, updates, loadUpdates])

  const openDetail = (id: string): void => {
    setDetailBody(undefined)
    setModal({ kind: 'detail', id })
    void api.content(id).then(setDetailBody).catch(fail)
  }

  const openDiff = (id: string): void => {
    setDiff(undefined)
    setModal({ kind: 'diff', id })
    void api.diff(id).then(setDiff).catch(fail)
  }

  const toggleRepo = (id: string): void => {
    const next = openRepos[id] !== true
    setOpenRepos({ ...openRepos, [id]: next })
    if (next && repoSkills[id] === undefined) void api.repoSkills(id).then(items => setRepoSkills(prev => ({ ...prev, [id]: items }))).catch(fail)
  }

  const toggleCompany = (id: string): void => {
    const next = openCompany[id] !== true
    setOpenCompany({ ...openCompany, [id]: next })
    if (next && companySkills[id] === undefined) void api.companySkills(id).then(items => setCompanySkills(prev => ({ ...prev, [id]: items }))).catch(fail)
  }

  const closeModal = (): void => setModal(null)

  // ── Tab bodies ──────────────────────────────────────────────────────────

  const renderSkills = (): React.ReactNode => {
    const skills = data?.skills ?? []
    const q = query.trim().toLowerCase()
    const visible = q.length === 0 ? skills : skills.filter(skill => `${skill.name} ${skill.description}`.toLowerCase().includes(q))
    const enabled = skills.filter(skill => skill.enabled).length
    const summary = h(
      'div',
      { className: styles.summary },
      h('div', { className: styles.stat }, h('strong', null, skills.length), t('summary.total', { count: skills.length }).replace(String(skills.length), '')),
      h('div', { className: styles.stat }, h('strong', null, enabled), t('summary.enabled', { count: enabled }).replace(String(enabled), '')),
      h('div', { className: styles.stat }, h('strong', null, skills.length - enabled), t('summary.disabled', { count: skills.length - enabled }).replace(String(skills.length - enabled), '')),
    )
    const filters = h(
      'div',
      { className: styles.filters },
      h('input', { className: cx(styles.control, styles.search), value: query, 'aria-label': t('search'), placeholder: t('search.placeholder'), onChange: (event: React.ChangeEvent<HTMLInputElement>) => setQuery(event.target.value) }),
    )
    const rows = visible.length === 0
      ? h('div', { className: styles.empty }, q.length === 0 ? t('empty.skills') : t('empty.search'))
      : h('div', { className: styles.list }, visible.map(skill => renderSkillRow(skill)))
    return h(React.Fragment, null, summary, filters, rows)
  }

  const renderSkillRow = (skill: SkillRecord): React.ReactNode => {
    const removable = skill.source === 'managed' || skill.source === 'repo' || skill.source === 'company'
    return h(
      'div',
      { key: skill.id, className: styles.row },
      h(
        'div',
        { className: styles.main },
        h('div', { className: styles.name }, skill.name),
        h('div', { className: styles.note }, skill.description),
        h('div', { className: styles.meta }, h('div', { className: styles.tags }, h('span', { className: styles.tag }, sourceLabel(t, skill.source)), skill.version !== undefined ? h('span', { className: styles.tag }, skill.version) : null)),
      ),
      h(
        'div',
        { className: styles.rowState },
        h('span', { className: skill.enabled ? styles.statusEnabled : styles.statusDisabled }, skill.enabled ? t('status.enabled') : t('status.disabled')),
        h(Switch, { on: skill.enabled, disabled: busy, label: `${skill.enabled ? t('btn.disable') : t('btn.enable')} ${skill.name}`, onClick: () => void run(() => api.enable(skill.id, !skill.enabled)) }),
      ),
      h(
        'div',
        { className: styles.rowActions },
        h('button', { type: 'button', className: cx(styles.btn, styles.btnQuiet), onClick: () => openDetail(skill.id) }, t('btn.detail')),
        removable ? h('button', { type: 'button', className: cx(styles.btn, styles.btnQuiet, styles.btnDanger), disabled: busy, onClick: () => setModal({ kind: 'confirm-delete', id: skill.id, name: skill.name }) }, t('btn.delete')) : null,
      ),
    )
  }

  const renderTrash = (): React.ReactNode => {
    const trash = data?.trash ?? []
    if (trash.length === 0) return h('div', { className: styles.empty }, t('empty.trash'))
    return h(
      'div',
      { className: styles.list },
      trash.map(entry =>
        h(
          'div',
          { key: entry.id, className: styles.row },
          h('div', { className: styles.main }, h('div', { className: styles.name }, entry.originalSkill.name), h('div', { className: styles.note }, t('trash.deletedAt', { time: formatTime(entry.deletedAt) }))),
          h(
            'div',
            { className: styles.rowActions },
            h('button', { type: 'button', className: cx(styles.btn, styles.btnQuiet), disabled: busy, onClick: () => void run(() => api.restore(entry.id)) }, t('btn.restore')),
            h('button', { type: 'button', className: cx(styles.btn, styles.btnQuiet, styles.btnDanger), disabled: busy, onClick: () => setModal({ kind: 'confirm-purge', trashId: entry.id, name: entry.originalSkill.name }) }, t('btn.purge')),
          ),
        ),
      ),
    )
  }

  const renderRepos = (): React.ReactNode => {
    const repos = data?.repos ?? []
    const items = repos.map(repo => {
      const open = openRepos[repo.id] === true
      const cached = repoSkills[repo.id]
      return h(
        'div',
        { key: repo.id, className: styles.sourceItem },
        h(
          'div',
          { className: styles.sourceHead },
          h('button', { type: 'button', className: cx(styles.btn, styles.btnQuiet), 'aria-expanded': open, onClick: () => toggleRepo(repo.id) }, open ? '▾' : '▸'),
          h('span', { className: styles.sourceTitle }, repo.name),
          h('span', { className: styles.sourcePath }, `${repo.url} · ${repo.branch}`),
          h('button', { type: 'button', className: cx(styles.btn, styles.btnQuiet), disabled: busy, onClick: () => void run(async () => { const list = await api.refreshRepo(repo.id); setRepoSkills(prev => ({ ...prev, [repo.id]: list })); setOpenRepos(prev => ({ ...prev, [repo.id]: true })) }) }, t('btn.sync')),
          h('button', { type: 'button', className: cx(styles.btn, styles.btnQuiet, styles.btnDanger), disabled: busy, onClick: () => void run(() => api.removeRepo(repo.id)) }, t('btn.remove')),
        ),
        open
          ? h(
              'div',
              { className: styles.sourceBody },
              h('div', { className: styles.count }, repo.lastFetchedAt !== undefined ? t('repo.lastFetched', { time: formatTime(repo.lastFetchedAt) }) : t('repo.never')),
              cached === undefined
                ? h('div', { className: styles.empty }, t('loading'))
                : cached.length === 0
                  ? h('div', { className: styles.empty }, t('empty.repoSkills'))
                  : cached.map(item =>
                      h(
                        'div',
                        { key: item.path, className: styles.row },
                        h('div', { className: styles.main }, h('div', { className: styles.name }, item.name), h('div', { className: styles.note }, item.description)),
                        h('div', { className: styles.rowActions }, h('button', { type: 'button', className: cx(styles.btn, styles.btnQuiet), disabled: busy, onClick: () => void run(() => api.installRepoSkill(repo.id, item.path)) }, t('btn.install'))),
                      ),
                    ),
            )
          : null,
      )
    })
    return h(
      React.Fragment,
      null,
      h('div', { className: styles.actions }, h('button', { type: 'button', className: styles.btn, onClick: () => setModal({ kind: 'repo-add' }) }, t('btn.add'))),
      repos.length === 0 ? h('div', { className: styles.empty }, t('empty.repos')) : h('div', { className: styles.sources }, items),
    )
  }

  const renderCompany = (): React.ReactNode => {
    const sources = data?.company ?? []
    const items = sources.map(source => {
      const open = openCompany[source.id] === true
      const cached = companySkills[source.id]
      return h(
        'div',
        { key: source.id, className: styles.sourceItem },
        h(
          'div',
          { className: styles.sourceHead },
          h('button', { type: 'button', className: cx(styles.btn, styles.btnQuiet), 'aria-expanded': open, onClick: () => toggleCompany(source.id) }, open ? '▾' : '▸'),
          h('span', { className: styles.sourceTitle }, source.name),
          h('span', { className: styles.sourcePath }, `${t(`company.type.${source.type}`)} · ${source.endpoint ?? source.repoUrl ?? ''}`),
          h('button', { type: 'button', className: cx(styles.btn, styles.btnQuiet), disabled: busy, onClick: () => void run(async () => { const list = await api.syncCompany(source.id); setCompanySkills(prev => ({ ...prev, [source.id]: list })); setOpenCompany(prev => ({ ...prev, [source.id]: true })) }) }, t('btn.sync')),
          h('button', { type: 'button', className: cx(styles.btn, styles.btnQuiet, styles.btnDanger), disabled: busy, onClick: () => void run(() => api.removeCompany(source.id)) }, t('btn.remove')),
        ),
        open
          ? h(
              'div',
              { className: styles.sourceBody },
              h('div', { className: styles.count }, source.lastSyncedAt !== undefined ? t('company.lastSynced', { time: formatTime(source.lastSyncedAt) }) : t('repo.never')),
              cached === undefined
                ? h('div', { className: styles.empty }, t('loading'))
                : cached.length === 0
                  ? h('div', { className: styles.empty }, t('empty.companySkills'))
                  : cached.map(entry =>
                      h(
                        'div',
                        { key: entry.name, className: styles.row },
                        h('div', { className: styles.main }, h('div', { className: styles.name }, entry.name), h('div', { className: styles.note }, entry.description)),
                        h('div', { className: styles.rowActions }, h('button', { type: 'button', className: cx(styles.btn, styles.btnQuiet), disabled: busy, onClick: () => void run(() => api.installCompanySkill(source.id, entry.name)) }, t('btn.install'))),
                      ),
                    ),
            )
          : null,
      )
    })
    return h(
      React.Fragment,
      null,
      h('div', { className: styles.actions }, h('button', { type: 'button', className: styles.btn, onClick: () => setModal({ kind: 'company-add' }) }, t('btn.add'))),
      sources.length === 0 ? h('div', { className: styles.empty }, t('empty.company')) : h('div', { className: styles.sources }, items),
    )
  }

  const renderUpdates = (): React.ReactNode => {
    if (updates === null) return h('div', { className: styles.empty }, t('loading'))
    if (updates.length === 0) return h('div', { className: styles.empty }, t('empty.updates'))
    const nameOf = (id: string): string => data?.skills.find(skill => skill.id === id)?.name ?? id
    return h(
      'div',
      { className: styles.list },
      updates.map(info =>
        h(
          'div',
          { key: info.skillId, className: styles.row },
          h('div', { className: styles.main }, h('div', { className: styles.name }, nameOf(info.skillId)), h('div', { className: styles.note }, `${t('updates.current', { version: info.currentVersion })} → ${t('updates.latest', { version: info.latestVersion })}`)),
          h(
            'div',
            { className: styles.rowActions },
            h('button', { type: 'button', className: cx(styles.btn, styles.btnQuiet), onClick: () => openDiff(info.skillId) }, t('btn.viewDiff')),
            h('button', { type: 'button', className: styles.btn, disabled: busy, onClick: () => void run(() => api.applyUpdate(info.skillId)).then(ok => { if (ok) setUpdates(null) }) }, t('btn.applyUpdate')),
          ),
        ),
      ),
    )
  }

  // ── Modals ──────────────────────────────────────────────────────────────

  const renderModal = (): React.ReactNode => {
    if (modal === null) return null
    switch (modal.kind) {
      case 'detail': {
        const skill = data?.skills.find(item => item.id === modal.id)
        return h(
          Modal,
          { title: t('detail.title'), closeLabel: t('btn.close'), wide: true, onClose: closeModal },
          h('div', { className: styles.detailSection }, h('div', { className: styles.detailTitle }, t('detail.path')), h('div', { className: styles.detailPath }, skill?.originPath ?? '')),
          h('div', { className: styles.detailSection }, h('div', { className: styles.detailTitle }, t('detail.frontmatter')), h('pre', { className: styles.code }, skill !== undefined ? JSON.stringify(skill.frontmatter, null, 2) : '')),
          h('div', { className: styles.detailSection }, h('div', { className: styles.detailTitle }, t('detail.body')), h('pre', { className: styles.code }, detailBody ?? t('loading'))),
        )
      }
      case 'diff':
        return h(
          Modal,
          { title: t('diff.title'), closeLabel: t('btn.close'), wide: true, onClose: closeModal },
          diff === undefined
            ? h('div', { className: styles.empty }, t('loading'))
            : diff.hunks.length === 0
              ? h('div', { className: styles.empty }, t('diff.none'))
              : h('div', { className: styles.diff }, diff.hunks.flatMap(hunk => hunk.lines).map((line, index) =>
                  h(
                    'div',
                    { key: index, className: cx(styles.diffLine, line.type === 'add' ? styles.diffAdd : line.type === 'remove' ? styles.diffRemove : undefined) },
                    h('span', { className: styles.diffNo }, line.type === 'remove' ? line.oldLineNo ?? '' : line.newLineNo ?? ''),
                    h('span', null, `${line.type === 'add' ? '+' : line.type === 'remove' ? '-' : ' '}${line.content}`),
                  ),
                )),
        )
      case 'create':
        return h(
          Modal,
          { title: t('create.title'), closeLabel: t('btn.close'), onClose: closeModal },
          h(
            'div',
            { className: styles.form },
            h(Field, { label: t('create.name') }, h('input', { className: styles.control, value: createName, placeholder: t('create.name.placeholder'), onChange: (event: React.ChangeEvent<HTMLInputElement>) => setCreateName(event.target.value) })),
            h(Field, { label: t('create.description') }, h('input', { className: styles.control, value: createDesc, placeholder: t('create.description.placeholder'), onChange: (event: React.ChangeEvent<HTMLInputElement>) => setCreateDesc(event.target.value) })),
            h(Field, { label: t('create.body') }, h('textarea', { className: cx(styles.control, styles.textarea), value: createBody, placeholder: t('create.body.placeholder'), onChange: (event: React.ChangeEvent<HTMLTextAreaElement>) => setCreateBody(event.target.value) })),
          ),
          h(
            'div',
            { className: styles.modalActions },
            h('button', { type: 'button', className: cx(styles.btn, styles.btnSecondary), onClick: closeModal }, t('btn.cancel')),
            h('button', { type: 'button', className: styles.btn, disabled: busy || createName.trim().length === 0 || createDesc.trim().length === 0 || createBody.trim().length === 0, onClick: () => void run(() => api.create(createName.trim(), createDesc.trim(), createBody)).then(ok => { if (ok) { setCreateName(''); setCreateDesc(''); setCreateBody(''); closeModal() } }) }, t('create.submit')),
          ),
        )
      case 'import':
        return h(
          Modal,
          { title: t('import.title'), closeLabel: t('btn.close'), onClose: closeModal },
          h(
            'div',
            { className: styles.form },
            h(Field, { label: t('import.path') }, h('input', { className: styles.control, value: importPath, placeholder: t('import.path.placeholder'), onChange: (event: React.ChangeEvent<HTMLInputElement>) => setImportPath(event.target.value) })),
            h(
              Field,
              { label: t('import.type') },
              h(
                'select',
                { className: styles.control, value: importType, onChange: (event: React.ChangeEvent<HTMLSelectElement>) => setImportType(event.target.value as 'zip' | 'folder' | 'file') },
                h('option', { value: 'folder' }, t('import.type.folder')),
                h('option', { value: 'zip' }, t('import.type.zip')),
                h('option', { value: 'file' }, t('import.type.file')),
              ),
            ),
            h('p', { className: styles.help }, t('import.hint')),
          ),
          h(
            'div',
            { className: styles.modalActions },
            h('button', { type: 'button', className: cx(styles.btn, styles.btnSecondary), onClick: closeModal }, t('btn.cancel')),
            h('button', { type: 'button', className: styles.btn, disabled: busy || importPath.trim().length === 0, onClick: () => void run(() => api.importFromPath(importPath.trim(), importType)).then(ok => { if (ok) { setImportPath(''); closeModal() } }) }, t('import.submit')),
          ),
        )
      case 'repo-add':
        return h(
          Modal,
          { title: t('repo.add.title'), closeLabel: t('btn.close'), onClose: closeModal },
          h(
            'div',
            { className: styles.form },
            h(Field, { label: t('repo.url') }, h('input', { className: styles.control, value: repoUrl, placeholder: t('repo.url.placeholder'), onChange: (event: React.ChangeEvent<HTMLInputElement>) => setRepoUrl(event.target.value) })),
            h(Field, { label: t('repo.branch') }, h('input', { className: styles.control, value: repoBranch, placeholder: t('repo.branch.placeholder'), onChange: (event: React.ChangeEvent<HTMLInputElement>) => setRepoBranch(event.target.value) })),
          ),
          h(
            'div',
            { className: styles.modalActions },
            h('button', { type: 'button', className: cx(styles.btn, styles.btnSecondary), onClick: closeModal }, t('btn.cancel')),
            h('button', { type: 'button', className: styles.btn, disabled: busy || repoUrl.trim().length === 0, onClick: () => void run(() => api.addRepo(repoUrl.trim(), repoBranch.trim() || 'main')).then(ok => { if (ok) { setRepoUrl(''); setRepoBranch('main'); closeModal() } }) }, t('btn.add')),
          ),
        )
      case 'company-add':
        return h(
          Modal,
          { title: t('company.add.title'), closeLabel: t('btn.close'), onClose: closeModal },
          h(
            'div',
            { className: styles.form },
            h(Field, { label: t('company.name') }, h('input', { className: styles.control, value: companyName, onChange: (event: React.ChangeEvent<HTMLInputElement>) => setCompanyName(event.target.value) })),
            h(
              Field,
              { label: t('company.type') },
              h('select', { className: styles.control, value: companyType, onChange: (event: React.ChangeEvent<HTMLSelectElement>) => setCompanyType(event.target.value as 'api' | 'git') }, h('option', { value: 'git' }, t('company.type.git')), h('option', { value: 'api' }, t('company.type.api'))),
            ),
            companyType === 'git'
              ? h(Field, { label: t('company.repoUrl') }, h('input', { className: styles.control, value: companyRepo, placeholder: t('repo.url.placeholder'), onChange: (event: React.ChangeEvent<HTMLInputElement>) => setCompanyRepo(event.target.value) }))
              : h(Field, { label: t('company.endpoint') }, h('input', { className: styles.control, value: companyEndpoint, onChange: (event: React.ChangeEvent<HTMLInputElement>) => setCompanyEndpoint(event.target.value) })),
          ),
          h(
            'div',
            { className: styles.modalActions },
            h('button', { type: 'button', className: cx(styles.btn, styles.btnSecondary), onClick: closeModal }, t('btn.cancel')),
            h('button', {
              type: 'button',
              className: styles.btn,
              disabled: busy || companyName.trim().length === 0,
              onClick: () =>
                void run(() =>
                  api.addCompany(
                    companyType === 'git'
                      ? { name: companyName.trim(), type: 'git', repoUrl: companyRepo.trim(), authType: 'none' }
                      : { name: companyName.trim(), type: 'api', endpoint: companyEndpoint.trim(), authType: 'none' },
                  ),
                ).then(ok => { if (ok) { setCompanyName(''); setCompanyRepo(''); setCompanyEndpoint(''); closeModal() } }),
            }, t('btn.add')),
          ),
        )
      case 'confirm-delete':
        return h(
          Modal,
          { title: t('confirm.delete.title'), closeLabel: t('btn.close'), onClose: closeModal },
          h('p', { className: styles.desc }, t('confirm.delete.desc', { name: modal.name })),
          h(
            'div',
            { className: styles.modalActions },
            h('button', { type: 'button', className: cx(styles.btn, styles.btnSecondary), onClick: closeModal }, t('btn.cancel')),
            h('button', { type: 'button', className: cx(styles.btn, styles.btnDanger), disabled: busy, onClick: () => void run(() => api.remove(modal.id)).then(ok => { if (ok) closeModal() }) }, t('btn.delete')),
          ),
        )
      case 'confirm-purge':
        return h(
          Modal,
          { title: t('confirm.purge.title'), closeLabel: t('btn.close'), onClose: closeModal },
          h('p', { className: styles.desc }, t('confirm.purge.desc', { name: modal.name })),
          h(
            'div',
            { className: styles.modalActions },
            h('button', { type: 'button', className: cx(styles.btn, styles.btnSecondary), onClick: closeModal }, t('btn.cancel')),
            h('button', { type: 'button', className: cx(styles.btn, styles.btnDanger), disabled: busy, onClick: () => void run(() => api.purge(modal.trashId)).then(ok => { if (ok) closeModal() }) }, t('btn.purge')),
          ),
        )
      default:
        return null
    }
  }

  // ── Shell ───────────────────────────────────────────────────────────────

  const tabs: Array<{ id: Tab; label: string; badge?: number }> = [
    { id: 'skills', label: t('tab.skills') },
    { id: 'trash', label: t('tab.trash'), badge: data?.trash.length ?? 0 },
    { id: 'repos', label: t('tab.repos') },
    { id: 'company', label: t('tab.company') },
    { id: 'updates', label: t('tab.updates') },
  ]

  const body = tab === 'skills'
    ? renderSkills()
    : tab === 'trash'
      ? renderTrash()
      : tab === 'repos'
        ? renderRepos()
        : tab === 'company'
          ? renderCompany()
          : renderUpdates()

  return h(
    'section',
    { className: styles.section },
    h(
      'div',
      { className: styles.head },
      h('div', { className: styles.titleRow }, h('h2', { className: styles.title }, t('title'))),
      h('p', { className: styles.desc }, t('desc')),
    ),
    h(
      'div',
      { className: styles.tabs, role: 'tablist' },
      tabs.map(item =>
        h(
          'button',
          { key: item.id, type: 'button', role: 'tab', 'aria-selected': tab === item.id, className: styles.tab, onClick: () => setTab(item.id) },
          item.label,
          item.badge !== undefined && item.badge > 0 ? h('span', { className: styles.tabBadge }, item.badge) : null,
        ),
      ),
    ),
    h(
      'div',
      { className: styles.actions },
      h('button', { type: 'button', className: cx(styles.btn, styles.btnSecondary), disabled: busy, onClick: () => void run(() => api.refresh()) }, t('btn.refresh')),
      tab === 'skills' ? h('button', { type: 'button', className: styles.btn, onClick: () => setModal({ kind: 'create' }) }, t('btn.create')) : null,
      tab === 'skills' ? h('button', { type: 'button', className: cx(styles.btn, styles.btnSecondary), onClick: () => setModal({ kind: 'import' }) }, t('btn.import')) : null,
      tab === 'trash' && (data?.trash.length ?? 0) > 0 ? h('button', { type: 'button', className: cx(styles.btn, styles.btnDanger), disabled: busy, onClick: () => void run(() => api.emptyTrash()) }, t('btn.emptyTrash')) : null,
      tab === 'updates' ? h('button', { type: 'button', className: cx(styles.btn, styles.btnSecondary), disabled: busy, onClick: () => { setUpdates(null); void loadUpdates() } }, t('btn.refresh')) : null,
    ),
    notice !== null ? h('div', { className: cx(styles.feedback, notice.kind === 'error' ? styles.error : undefined), role: notice.kind === 'error' ? 'alert' : undefined }, notice.text) : null,
    data === null && notice === null ? h('div', { className: styles.empty }, t('loading')) : body,
    renderModal(),
  )
}

/** The updates list, `null` until first loaded. */
type UpdateList = Array<{ skillId: string; currentVersion: string; latestVersion: string; hasUpdate: boolean }> | null
