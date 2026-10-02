/**
 * dsh-notion-workspaces — client half.
 *
 * Hand-written in the `window.__ModuleLoader__.load({id, factory})` lazy-CJS
 * form the DSH client loader requires (dsh-client-modules/lib/client.js:229).
 * Plain ES2020 + `React.createElement` rather than JSX precisely so no bundler
 * is needed: the only imports are platform seed words the shell already
 * provides, so `require` never misses the module table.
 *
 * Layout and colour travel with the elements as inline styles on purpose: a
 * stylesheet this plugin injects is one more thing that can fail to load, and
 * when it does the whole surface collapses. Inline styles cannot.
 *
 * Three seats, because DSH's slot catalog (69 keys) offers no per-workspace
 * menu item: `sidebar.workspaces` is a `single` seat already claimed by the
 * shipped browser and its row menu is hardcoded inside it.
 *
 *   sidebar.footer.action  — a button beside Settings that opens the dialog
 *   shell.overlay          — the dialog itself (the catalog calls this the
 *                            additive seat for a frame-wide surface)
 *   settings.section       — the same editor as a full settings page
 *
 * Every step that could fail silently posts a beacon to the host half, which
 * appends it to `$DSH_HOME/notion-workspaces-diag.log`. That log is the only
 * way to tell "the bundle never loaded" from "it loaded and threw" inside the
 * packaged desktop window, which answers HTTP 403 to everything else.
 */
window.__ModuleLoader__.load({
  id: 'dsh-notion-workspaces',
  factory: (require) => {
    const React = require('react')
    const h = React.createElement

    const name = 'notion-workspaces'
    const inject = ['slots']

    const API = '/notion-workspaces'
    const SECTION_ID = 'notion-workspaces'

    /** Fire-and-forget report; never awaited, never allowed to throw. */
    function beacon(phase, detail) {
      try {
        fetch(`${API}/beacon`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ phase, detail }),
          cache: 'no-store',
          keepalive: true,
        }).catch(() => {})
      } catch {
        // A beacon must never be the reason the UI fails.
      }
    }

    beacon('factory', { href: String(window.location?.href ?? '') })

    // ---------------------------------------------------------------------
    // Dialog visibility — module state plus a tiny subscription, so the
    // sidebar button and the overlay occupant need not know each other.
    // ---------------------------------------------------------------------

    const listeners = new Set()
    let dialogOpen = false

    const setDialogOpen = (next) => {
      dialogOpen = next
      for (const listener of listeners) {
        try {
          listener(next)
        } catch {
          // One bad subscriber must not break the others.
        }
      }
    }

    function useDialogOpen() {
      const [open, setOpen] = React.useState(dialogOpen)
      React.useEffect(() => {
        const listener = (value) => setOpen(value)
        listeners.add(listener)
        setOpen(dialogOpen)
        return () => listeners.delete(listener)
      }, [])
      return open
    }

    // ---------------------------------------------------------------------
    // Host API
    // ---------------------------------------------------------------------

    async function request(path, options) {
      const response = await fetch(`${API}${path}`, { cache: 'no-store', ...options })
      const text = await response.text()
      let body
      try {
        body = text === '' ? {} : JSON.parse(text)
      } catch {
        body = { ok: false, error: text.slice(0, 300) }
      }
      if (!response.ok || body.ok === false) throw new Error(body.error ?? `HTTP ${response.status}`)
      return body
    }

    const post = (path, payload) => request(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload ?? {}),
    })

    // ---------------------------------------------------------------------
    // Styles
    // ---------------------------------------------------------------------

    const TEXT = 'var(--dsw-alias-label-primary, CanvasText)'
    const SURFACE = 'var(--dsw-alias-bg-base, Canvas)'
    const BORDER = '1px solid rgba(127, 127, 127, 0.28)'
    const BORDER_STRONG = '1px solid rgba(127, 127, 127, 0.42)'
    const MUTED = { opacity: 0.68 }
    const MONO = 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace'

    const TONE = {
      ok: 'rgba(63, 185, 80, 0.95)',
      warn: 'rgba(210, 153, 34, 0.95)',
      bad: '#e5484d',
      idle: 'rgba(127, 127, 127, 0.75)',
      accent: 'rgba(80, 140, 255, 0.9)',
    }

    const FIELD = {
      font: 'inherit',
      width: '100%',
      boxSizing: 'border-box',
      padding: '6px 9px',
      borderRadius: 7,
      border: BORDER_STRONG,
      background: 'transparent',
      color: 'inherit',
      minWidth: 0,
    }

    const BUTTON = {
      font: 'inherit',
      padding: '6px 13px',
      borderRadius: 7,
      border: BORDER_STRONG,
      background: 'transparent',
      color: 'inherit',
      cursor: 'pointer',
      whiteSpace: 'nowrap',
    }

    const BUTTON_SMALL = { ...BUTTON, padding: '4px 10px', fontSize: 12.5 }
    const BUTTON_PRIMARY = { ...BUTTON, borderColor: TONE.accent }
    const BUTTON_DANGER = { ...BUTTON_SMALL, borderColor: 'rgba(229, 72, 77, 0.55)' }
    const BUTTON_DISABLED = (style, disabled) => ({
      ...style,
      disabled,
      opacity: disabled ? 0.55 : 1,
      cursor: disabled ? 'default' : 'pointer',
    })

    const CARD = {
      border: BORDER,
      borderRadius: 10,
      padding: '12px 14px',
      display: 'grid',
      gap: 11,
      background: 'transparent',
    }

    const FIELD_LABEL = { display: 'block', fontSize: 12, marginBottom: 5, ...MUTED }

    const LINK_BUTTON = {
      font: 'inherit',
      fontSize: 12,
      padding: 0,
      border: 'none',
      background: 'transparent',
      color: 'inherit',
      cursor: 'pointer',
      textDecoration: 'underline',
      opacity: 0.75,
    }

    function Dot({ tone }) {
      return h('span', {
        style: {
          width: 7, height: 7, borderRadius: 999, background: tone,
          display: 'inline-block', flex: '0 0 auto',
        },
      })
    }

    function StatusPill(props) {
      return h('span', {
        style: {
          display: 'inline-flex', alignItems: 'center', gap: 6,
          fontSize: 12, padding: '2px 9px', borderRadius: 999, border: BORDER,
          whiteSpace: 'nowrap',
        },
      }, [h(Dot, { key: 'd', tone: props.tone }), h('span', { key: 't' }, props.text)])
    }

    // ---------------------------------------------------------------------
    // Model
    // ---------------------------------------------------------------------

    const toDraft = (binding) => ({
      id: binding.id,
      label: binding.label ?? '',
      workspacePath: binding.workspacePath ?? '',
      serverName: binding.serverName,
      credentialRef: binding.credentialRef,
      port: binding.port,
    })

    let sequence = 0
    const nextId = () => {
      sequence += 1
      return `binding-${Date.now().toString(36)}-${sequence}`
    }

    /** What one saved binding means, rendered as a status pill. */
    function statusOf(saved) {
      if (saved === undefined) return { tone: TONE.idle, text: '未保存' }
      if (saved.loginState === 'pending') return { tone: TONE.warn, text: '等待浏览器授权…' }
      if (saved.workspaceExists === false) return { tone: TONE.bad, text: '目录不存在' }
      if (saved.authorized) {
        const who = saved.workspaceName ?? saved.workspaceId ?? '已授权'
        return { tone: TONE.ok, text: `已连接：${who}` }
      }
      return { tone: TONE.warn, text: '未授权' }
    }

    // ---------------------------------------------------------------------
    // One binding, as a self-contained card
    // ---------------------------------------------------------------------

    function BindingCard(props) {
      const { draft, saved, workspaces, busy, onChange, onRemove, onAuthorize, onRevoke } = props
      const known = saved !== undefined
      const matched = workspaces.find((workspace) => workspace.path === draft.workspacePath)
      // A path that is not one of the registered workspaces has to be typed,
      // so the text field is revealed rather than duplicated side by side.
      const [manual, setManual] = React.useState(false)
      const showManual = manual || (draft.workspacePath !== '' && matched === undefined)

      const title = matched !== undefined
        ? (matched.title || matched.path)
        : draft.workspacePath !== '' ? draft.workspacePath : '新绑定'
      const status = statusOf(saved)

      const header = h('div', {
        key: 'head',
        style: { display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' },
      }, [
        h('span', { key: 't', style: { fontSize: 13.5, fontWeight: 600, color: TEXT } }, title),
        h(StatusPill, { key: 's', tone: status.tone, text: status.text }),
        h('span', { key: 'sp', style: { flex: 1 } }),
        known && saved.authorized
          ? h('span', {
            key: 'm',
            style: { fontSize: 11.5, ...MUTED },
            title: '当前挂载该 Notion 工作区的存活会话数',
          }, `${saved.mountedAgents ?? 0} 个会话在用`)
          : null,
        known
          ? h('button', {
            key: 'auth',
            style: BUTTON_DISABLED(BUTTON_PRIMARY, busy || saved.loginState === 'pending'),
            onClick: () => onAuthorize(saved),
          }, saved.authorized ? '重新授权' : '授权')
          : null,
        known && saved.authorized
          ? h('button', {
            key: 'rev',
            style: BUTTON_DISABLED(BUTTON_SMALL, busy),
            onClick: () => onRevoke(saved),
          }, '撤销')
          : null,
        h('button', {
          key: 'del',
          style: BUTTON_DISABLED(BUTTON_DANGER, busy),
          onClick: onRemove,
        }, '删除'),
      ])

      const fields = h('div', {
        key: 'fields',
        style: {
          display: 'grid',
          gridTemplateColumns: 'minmax(0, 1.25fr) minmax(0, 1fr)',
          gap: 12,
          alignItems: 'start',
        },
      }, [
        h('div', { key: 'ws' }, [
          h('label', { key: 'l', style: FIELD_LABEL }, 'DSH 工作区'),
          showManual
            ? h('div', { key: 'm', style: { display: 'grid', gap: 6 } }, [
              h('input', {
                style: FIELD,
                value: draft.workspacePath,
                disabled: busy,
                spellCheck: false,
                placeholder: 'C:\\path\\to\\your\\project',
                onChange: (event) => onChange({ workspacePath: event.target.value }),
              }),
              h('button', {
                key: 'back',
                type: 'button',
                style: LINK_BUTTON,
                disabled: busy,
                onClick: () => {
                  setManual(false)
                  onChange({ workspacePath: '' })
                },
              }, '改回从列表选择'),
            ])
            : h('select', {
              style: FIELD,
              value: matched !== undefined ? draft.workspacePath : '',
              disabled: busy,
              onChange: (event) => onChange({ workspacePath: event.target.value }),
            }, [
              h('option', { key: '__none', value: '' }, '— 选择一个工作区 —'),
              ...workspaces.map((workspace) => h('option', {
                key: workspace.path,
                value: workspace.path,
              }, `${workspace.title || workspace.path}　${workspace.path}`)),
            ]),
          showManual
            ? null
            : h('button', {
              key: 'manual',
              type: 'button',
              style: { ...LINK_BUTTON, marginTop: 6 },
              disabled: busy,
              onClick: () => setManual(true),
            }, '手动输入路径'),
        ]),

        h('div', { key: 'note' }, [
          h('label', { key: 'l', style: FIELD_LABEL }, '备注（可选）'),
          h('input', {
            style: FIELD,
            value: draft.label,
            disabled: busy,
            placeholder: '例如：个人 Notion',
            onChange: (event) => onChange({ label: event.target.value }),
          }),
        ]),
      ])

      const identity = known
        ? h('div', {
          key: 'id',
          style: { fontSize: 11.5, fontFamily: MONO, ...MUTED, overflowWrap: 'anywhere' },
        }, `工具名 mcp__${draft.serverName}__*　·　凭证 ${draft.credentialRef}　·　回调端口 ${draft.port}`)
        : h('div', { key: 'id', style: { fontSize: 11.5, ...MUTED } }, '保存后自动分配工具名与凭证引用。')

      return h('div', { style: CARD }, [header, fields, identity])
    }

    // ---------------------------------------------------------------------
    // Configuration state
    // ---------------------------------------------------------------------

    function useBindings() {
      const [state, setState] = React.useState(null)
      const [draft, setDraft] = React.useState([])
      const [error, setError] = React.useState('')
      const [notice, setNotice] = React.useState('')
      const [busy, setBusy] = React.useState(false)
      const [dirty, setDirty] = React.useState(false)

      const load = React.useCallback(async () => {
        try {
          const body = await request('/state')
          setState(body)
          setDraft((current) => (dirty ? current : body.bindings.map(toDraft)))
          setError('')
        } catch (cause) {
          setError(String(cause?.message ?? cause))
        }
      }, [dirty])

      React.useEffect(() => { void load() }, [load])

      React.useEffect(() => {
        const pending = state?.bindings?.some((binding) => binding.loginState === 'pending')
        if (pending !== true) return undefined
        const timer = setInterval(() => { void load() }, 2000)
        return () => clearInterval(timer)
      }, [state, load])

      const savedById = new Map((state?.bindings ?? []).map((binding) => [binding.id, binding]))

      const update = (index, patch) => {
        setDraft((current) => current.map((row, at) => (at === index ? { ...row, ...patch } : row)))
        setDirty(true)
        setNotice('')
      }
      const remove = (index) => {
        setDraft((current) => current.filter((_, at) => at !== index))
        setDirty(true)
      }
      const add = () => {
        const id = nextId()
        setDraft((current) => [...current, {
          id, label: '', workspacePath: '', serverName: undefined, credentialRef: '', port: undefined,
        }])
        setDirty(true)
      }
      const save = async () => {
        setBusy(true)
        try {
          const body = await post('/bindings', { bindings: draft })
          setState((current) => ({ ...current, bindings: body.bindings }))
          setDraft(body.bindings.map(toDraft))
          setDirty(false)
          setNotice('已保存')
          setError('')
        } catch (cause) {
          setError(String(cause?.message ?? cause))
        } finally {
          setBusy(false)
        }
      }
      const authorize = async (binding) => {
        setBusy(true)
        try {
          const body = await post('/authorize', { id: binding.id })
          setNotice(`已生成授权链接，请在浏览器窗口完成（回调端口 ${binding.port}）`)
          setError('')
          if (typeof window !== 'undefined' && typeof window.open === 'function') {
            window.open(body.url, '_blank', 'noopener')
          }
          await load()
        } catch (cause) {
          setError(String(cause?.message ?? cause))
        } finally {
          setBusy(false)
        }
      }
      const revoke = async (binding) => {
        setBusy(true)
        try {
          await post('/revoke', { id: binding.id })
          setNotice('已撤销该工作区的 Notion 授权')
          await load()
        } catch (cause) {
          setError(String(cause?.message ?? cause))
        } finally {
          setBusy(false)
        }
      }

      return {
        state, draft, error, notice, busy, dirty, workspaces: state?.workspaces ?? [],
        savedById, load: async () => { setDirty(false); await load() },
        update, remove, add, save, authorize, revoke,
      }
    }

    // ---------------------------------------------------------------------
    // Shared pieces
    // ---------------------------------------------------------------------

    function Messages({ model }) {
      const children = []
      if (model.error !== '') {
        children.push(h('div', {
          key: 'err',
          style: {
            border: '1px solid rgba(229, 72, 77, 0.5)', borderRadius: 8,
            padding: '8px 11px', fontSize: 12.5, color: TONE.bad,
          },
        }, model.error))
      }
      if (model.notice !== '') {
        children.push(h('div', { key: 'ok', style: { fontSize: 12.5, ...MUTED } }, model.notice))
      }
      if (children.length === 0) return null
      return h('div', { style: { display: 'grid', gap: 8 } }, children)
    }

    function BindingsList({ model }) {
      const { draft, busy, workspaces, savedById } = model
      if (draft.length === 0) {
        return h('div', {
          style: {
            border: '1px dashed rgba(127, 127, 127, 0.4)', borderRadius: 10,
            padding: '26px 16px', textAlign: 'center', fontSize: 13, ...MUTED,
          },
        }, [
          h('div', { key: 'a' }, '还没有绑定。'),
          h('div', { key: 'b', style: { marginTop: 6 } }, '点右下角「新增绑定」，选择 DSH 工作区，再授权对应的 Notion 工作区。'),
        ])
      }
      return h('div', { style: { display: 'grid', gap: 10 } }, draft.map((row, index) => h(BindingCard, {
        key: row.id ?? index,
        draft: row,
        saved: savedById.get(row.id),
        workspaces,
        busy,
        onChange: (patch) => model.update(index, patch),
        onRemove: () => model.remove(index),
        onAuthorize: (binding) => void model.authorize(binding),
        onRevoke: (binding) => void model.revoke(binding),
      })))
    }

    /** 新增 / 保存 / 刷新, with the unsaved marker beside them. */
    function Toolbar({ model }) {
      const { busy, dirty } = model
      return h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' } }, [
        h('button', { key: 'add', style: BUTTON_DISABLED(BUTTON, busy), onClick: model.add }, '新增绑定'),
        h('button', {
          key: 'save',
          style: BUTTON_DISABLED(BUTTON_PRIMARY, busy || !dirty),
          onClick: () => void model.save(),
        }, '保存'),
        h('button', { key: 'reload', style: BUTTON_DISABLED(BUTTON, busy), onClick: () => void model.load() }, '刷新'),
        dirty ? h('span', { key: 'd', style: { fontSize: 12, color: TONE.warn } }, '有未保存的更改') : null,
      ])
    }

    function StatePath({ model }) {
      if (model.state?.statePath === undefined) return null
      return h('div', {
        style: { fontSize: 11.5, fontFamily: MONO, ...MUTED, overflowWrap: 'anywhere' },
      }, model.state.statePath)
    }

    // ---------------------------------------------------------------------
    // Settings page
    // ---------------------------------------------------------------------

    function Panel() {
      const model = useBindings()
      return h('div', { style: { display: 'grid', gap: 14, maxWidth: 900 } }, [
        h('p', { key: 'lead', style: { margin: 0, fontSize: 13, ...MUTED } },
          '每个 DSH 工作区绑定一个 Notion 工作区：只有该工作区的会话能看到对应的 ',
          h('code', { key: 'c' }, 'mcp__<工具名>__*'),
          ' 工具。'),
        h(Toolbar, { key: 'bar', model }),
        h(Messages, { key: 'msg', model }),
        h(BindingsList, { key: 'list', model }),
        h(StatePath, { key: 'path', model }),
      ])
    }

    // ---------------------------------------------------------------------
    // The dialog
    // ---------------------------------------------------------------------

    function Dialog() {
      const open = useDialogOpen()
      const model = useBindings()

      React.useEffect(() => {
        if (!open) return undefined
        const onKey = (event) => {
          if (event.key === 'Escape') setDialogOpen(false)
        }
        window.addEventListener('keydown', onKey)
        return () => window.removeEventListener('keydown', onKey)
      }, [open])

      if (!open) return null

      return h('div', {
        style: {
          position: 'fixed', inset: 0, zIndex: 1000, display: 'flex',
          alignItems: 'center', justifyContent: 'center', padding: 24,
          background: 'rgba(0, 0, 0, 0.45)',
          // `shell.overlay` is click-through; each occupant opts back in.
          pointerEvents: 'auto',
        },
        onMouseDown: (event) => {
          if (event.target === event.currentTarget) setDialogOpen(false)
        },
      }, h('div', {
        style: {
          display: 'flex', flexDirection: 'column',
          width: 'min(940px, 94vw)', maxHeight: '86vh',
          border: BORDER_STRONG, borderRadius: 12, background: SURFACE, color: TEXT,
          boxShadow: '0 20px 56px rgba(0, 0, 0, 0.4)', overflow: 'hidden',
        },
      }, [
        // Fixed header
        h('div', {
          key: 'head',
          style: {
            display: 'flex', alignItems: 'baseline', gap: 12,
            padding: '15px 18px', borderBottom: BORDER,
          },
        }, [
          h('h2', { key: 't', style: { margin: 0, fontSize: 15.5, fontWeight: 600 } }, '设置 Notion 工作空间'),
          h('span', { key: 'hint', style: { fontSize: 12, ...MUTED } }, 'DSH 工作区 → Notion 工作区'),
          h('span', { key: 'sp', style: { flex: 1 } }),
          h('button', { key: 'x', style: BUTTON_SMALL, onClick: () => setDialogOpen(false) }, '关闭'),
        ]),

        // Scrolling body
        h('div', {
          key: 'body',
          style: { flex: 1, overflow: 'auto', padding: '14px 18px', display: 'grid', gap: 12, alignContent: 'start' },
        }, [
          h(Messages, { key: 'msg', model }),
          h(BindingsList, { key: 'list', model }),
          h(StatePath, { key: 'path', model }),
        ]),

        // Fixed footer
        h('div', {
          key: 'foot',
          style: {
            display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap',
            padding: '12px 18px', borderTop: BORDER,
          },
        }, [
          h(Toolbar, { key: 'bar', model }),
          h('span', { key: 'sp', style: { flex: 1 } }),
          h('span', { key: 'w', style: { fontSize: 12, ...MUTED } }, model.dirty ? '保存后生效' : '更改实时生效'),
        ]),
      ]))
    }

    /** Frame-wide dialog seat: stays mounted, renders the modal only when open. */
    function DialogHost() {
      return h(Dialog, null)
    }

    /** Sidebar-foot button beside Settings. */
    function SidebarAction(props) {
      const wide = props?.wide !== false
      return h('button', {
        type: 'button',
        title: '设置 Notion 工作空间',
        style: { ...BUTTON, padding: '5px 10px', fontSize: 12.5 },
        onClick: () => {
          beacon('sidebar-click', {})
          setDialogOpen(true)
        },
      }, wide ? 'Notion' : 'N')
    }

    // ---------------------------------------------------------------------
    // Registration
    // ---------------------------------------------------------------------

    function register(ctx, seat, id, order, component) {
      try {
        return ctx.slots.inject(seat, () => {
          // The callback runs once the seat has a live declaration, so this is
          // the first moment registration can actually succeed.
          const off = ctx.slots.register({
            name: seat,
            id,
            order,
            label: () => 'Notion 工作区',
          }, component)
          beacon(`registered:${seat}`, {})
          return off
        })
      } catch (error) {
        // Report and continue: one unavailable seat must not cost the others.
        beacon(`failed:${seat}`, { message: String(error?.message ?? error) })
        return undefined
      }
    }

    function apply(ctx) {
      beacon('apply', { hasSlots: typeof ctx?.slots?.inject === 'function' })
      const disposers = [
        register(ctx, 'sidebar.footer.action', `${SECTION_ID}-action`, 20, SidebarAction),
        register(ctx, 'shell.overlay', `${SECTION_ID}-dialog`, 30, DialogHost),
        register(ctx, 'settings.section', SECTION_ID, 45, Panel),
      ]
      return () => {
        for (const dispose of disposers) {
          try {
            if (typeof dispose === 'function') dispose()
          } catch {
            // Best effort.
          }
        }
      }
    }

    const module = { exports: {} }
    module.exports.name = name
    module.exports.inject = inject
    module.exports.apply = apply
    return module.exports
  },
})
