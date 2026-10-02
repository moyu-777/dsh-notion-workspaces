/**
 * dsh-notion-workspaces — bind a DSH workspace to a Notion workspace.
 *
 * ## Why this exists
 *
 * The upstream plugin (`dsh-notion-mcp`) holds exactly one Notion grant for a
 * whole DSH environment: it hardcodes the credential ref `NOTION_OAUTH`, a
 * single `serverName`, and mounts its MCP client in the profile's global
 * scope. DSH, meanwhile, has no per-workspace settings or credential scope at
 * all — `<cwd>/.env` ranks *below* the managed credential store, and the
 * desktop host boots once for every workspace it serves. So "one DSH workspace
 * ↔ one Notion workspace" is not expressible there.
 *
 * This plugin expresses it in the one place DSH does offer the granularity:
 * the **agent scope**. Every session's agent carries its own
 * `session.header.cwd` (the workspace directory) and its own scoped tool
 * registry (`agent.ctx.tools`), and `@deepseek-ai/dsh-mcp-client` deliberately
 * supports being mounted per agent ("Agent-scoped MCP servers may reuse a
 * namespace in another Agent" — dsh-mcp-client). So:
 *
 *   - a binding maps a workspace path to a Notion grant (its own credential
 *     ref, its own `serverName`);
 *   - on `agent/created` the agent's workspace decides which binding applies;
 *   - the MCP client is mounted under *that agent's* context, so only that
 *     session ever sees those `mcp__<serverName>__*` tools.
 *
 * The mapping is a real constraint, not a convention: a session in an unbound
 * workspace sees no Notion tools at all.
 *
 * ## Configuration
 *
 * Bindings live in `$DSH_HOME/notion-workspaces.json` and are edited through
 * this plugin's own HTTP routes, which its client UI drives. The file is
 * written atomically (temp file + rename) so a crash mid-save cannot leave the
 * host reading a truncated document.
 *
 * @module dsh-notion-workspaces
 */

import { appendFileSync, existsSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import z from '@deepseek-ai/schemastery'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import * as mcpClient from '@deepseek-ai/dsh-mcp-client'
import { beginLogin, InvalidGrantError, refreshAccessToken } from './notion-oauth.js'

export const name = 'notion-workspaces'

/** Only the credential store is mandatory; everything else degrades gracefully. */
export const inject = ['credentials']

const DEFAULT_MCP_URL = 'https://mcp.notion.com/mcp'
const STATE_FILENAME = 'notion-workspaces.json'
const ROUTE_PREFIX = '/notion-workspaces'
const MAX_BODY_BYTES = 256 * 1024
const SERVER_NAME_RE = /^[A-Za-z0-9_-]{1,32}$/
const REF_RE = /^[A-Za-z0-9_.-]{1,64}$/

/** Refresh an access token once it is within this window of expiring. */
const REFRESH_WINDOW_MS = 30 * 60 * 1000
const REFRESH_TICK_MS = 5 * 60 * 1000

export const Config = z.object({
  mcpUrl: z.string().default(DEFAULT_MCP_URL),
  /** Override the binding file location; blank means `$DSH_HOME/notion-workspaces.json`. */
  statePath: z.string().default(''),
  /** First loopback port tried for OAuth callbacks; later bindings use +1, +2, … */
  callbackPortBase: z.number().default(53010),
})

// ---------------------------------------------------------------------------
// Binding file
// ---------------------------------------------------------------------------

function dshHome() {
  const fromEnv = (process.env.DSH_HOME ?? '').trim()
  return fromEnv === '' ? join(homedir(), '.dsh') : fromEnv
}

function resolveStatePath(config) {
  const explicit = (config.statePath ?? '').trim()
  return explicit === '' ? join(dshHome(), STATE_FILENAME) : explicit
}

/**
 * Append one JSON line to this plugin's self-check log.
 *
 * The desktop app composes a different profile than an ordinary `dsh
 * --profile desktop` boot, and its HTTP surface answers 403 to anything but
 * the packaged window — so "did the client half load?" has to be answerable
 * from disk. The host writes one line when it applies; the client half POSTs
 * a beacon through the route below at each step that could silently fail.
 */
function diag(entry) {
  try {
    appendFileSync(
      join(dshHome(), 'notion-workspaces-diag.log'),
      `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`,
      'utf8',
    )
  } catch {
    // Diagnostics must never be able to break the plugin.
  }
}

/** One binding, or undefined when the record is not usable as one. */
function normalizeBinding(value, index, basePort) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  const record = value
  const id = typeof record.id === 'string' && record.id.trim() !== '' ? record.id.trim() : `binding-${index + 1}`
  const workspacePath = typeof record.workspacePath === 'string' ? record.workspacePath.trim() : ''
  if (workspacePath === '') return undefined
  const serverName = typeof record.serverName === 'string' && SERVER_NAME_RE.test(record.serverName.trim())
    ? record.serverName.trim()
    : undefined
  const refName = typeof record.credentialRef === 'string' && REF_RE.test(record.credentialRef.trim())
    ? record.credentialRef.trim()
    : undefined
  return {
    id,
    label: typeof record.label === 'string' ? record.label.trim() : '',
    workspacePath,
    serverName: serverName ?? defaultServerName(id, index),
    credentialRef: refName ?? defaultRefName(id, index),
    port: Number.isInteger(record.port) && record.port > 0 && record.port < 65536
      ? record.port
      : basePort + index,
  }
}

/** Derive a stable, pattern-valid `serverName` from a binding id. */
function defaultServerName(id, index) {
  const slug = id.toLowerCase().replace(/[^a-z0-9_-]/g, '_').slice(0, 24)
  const candidate = slug === '' ? `notion_${index + 1}` : `notion_${slug}`
  return SERVER_NAME_RE.test(candidate) ? candidate : `notion_${index + 1}`
}

function defaultRefName(id, index) {
  const slug = id.toUpperCase().replace(/[^A-Z0-9_]/g, '_').slice(0, 40)
  return slug === '' ? `NOTION_OAUTH_${index + 1}` : `NOTION_OAUTH_${slug}`
}

/** Parse the on-disk document, dropping anything that is not a usable binding. */
function parseState(raw, basePort) {
  let document
  try {
    document = JSON.parse(raw)
  } catch {
    return { version: 1, bindings: [] }
  }
  const list = Array.isArray(document?.bindings) ? document.bindings : []
  const bindings = []
  for (const [index, entry] of list.entries()) {
    const binding = normalizeBinding(entry, index, basePort)
    if (binding === undefined) continue
    if (bindings.some((existing) => existing.id === binding.id)) continue
    bindings.push(binding)
  }
  return { version: 1, bindings }
}

function loadState(file, basePort) {
  try {
    return parseState(readFileSync(file, 'utf8'), basePort)
  } catch {
    // Absent or unreadable: an empty configuration, never a crash on boot.
    return { version: 1, bindings: [] }
  }
}

/** Write the document through a temp file so readers never see a partial save. */
function saveState(file, state) {
  const temp = `${file}.tmp-${process.pid}`
  writeFileSync(temp, `${JSON.stringify(state, null, 2)}\n`, 'utf8')
  try {
    renameSync(temp, file)
  } catch (error) {
    try {
      unlinkSync(temp)
    } catch {
      // Best effort.
    }
    throw error
  }
}

// ---------------------------------------------------------------------------
// Workspace matching
// ---------------------------------------------------------------------------

/**
 * Canonical comparison key for a workspace path.
 *
 * `realpath` resolves symlinks and 8.3 short names, which matters on Windows
 * where one directory is reachable as both `C:\Users\me\projects` and
 * `C:\Users\ME~1\PROJEC~1`. Case is folded because NTFS is case-insensitive: a
 * binding spelled `d:\work` must still match a session opened at `D:\Work`.
 *
 * @returns the key, or null when the path does not exist (an unbound session).
 */
function canonicalKey(path) {
  if (typeof path !== 'string' || path.trim() === '') return null
  let resolved
  try {
    resolved = realpathSync.native ? realpathSync.native(path) : realpathSync(path)
  } catch {
    return null
  }
  return resolved.replace(/[\\/]+$/, '').replace(/\//g, '\\').toLowerCase()
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

export function apply(ctx, config) {
  const statePath = resolveStatePath(config)
  const mcpUrl = (config.mcpUrl ?? '').trim() === '' ? DEFAULT_MCP_URL : config.mcpUrl.trim()
  const basePort = Number.isInteger(config.callbackPortBase) ? config.callbackPortBase : 53010

  // Where this host half actually loaded from, and whether the client bundle
  // sits beside it. If a desktop composition resolves the package through a
  // different anchor than the profile, this line is what shows it.
  const hostModuleUrl = import.meta.url
  let clientBundlePath = ''
  try {
    clientBundlePath = fileURLToPath(new URL('../client/client.js', import.meta.url))
  } catch {
    clientBundlePath = ''
  }
  diag({
    phase: 'host-apply',
    pid: process.pid,
    hostModuleUrl,
    clientBundlePath,
    clientBundleExists: clientBundlePath !== '' && existsSync(clientBundlePath),
    statePath,
    cwd: process.cwd(),
  })

  let state = loadState(statePath, basePort)

  /** agentId → { bindingId, scope, fiber } — the live mounts, for remount-on-refresh. */
  const mounts = new Map()
  /** bindingId → { error } — logged once per binding so a missing grant is not spam. */
  const warned = new Map()
  /** bindingId → login progress, surfaced to the configuration UI. */
  const logins = new Map()

  const log = (level, message) => {
    const logger = ctx.logger
    if (logger !== undefined && typeof logger[level] === 'function') logger[level](`[notion-workspaces] ${message}`)
  }

  // -- credentials ---------------------------------------------------------

  async function readTokens(binding) {
    try {
      const resolved = await ctx.credentials.resolve(credentialRef(binding.credentialRef))
      if (resolved === undefined || resolved === null) return undefined
      const raw = resolved.value
      if (typeof raw !== 'string' || raw.trim() === '') return undefined
      const parsed = JSON.parse(raw)
      if (typeof parsed?.accessToken !== 'string' || parsed.accessToken === '') return undefined
      return parsed
    } catch (error) {
      log('warn', `${binding.id}: stored grant is unreadable — ${String(error)}`)
      return undefined
    }
  }

  async function writeTokens(binding, tokens) {
    await ctx.credentials.set(credentialRef(binding.credentialRef), JSON.stringify(tokens))
  }

  // -- mounting ------------------------------------------------------------

  /** MCP client config for one binding and one access token. */
  function mountConfig(binding, accessToken) {
    return {
      transport: 'streamable-http',
      serverName: binding.serverName,
      url: mcpUrl,
      headers: { Authorization: `Bearer ${accessToken}` },
      toolCallTimeoutMs: 60_000,
      // A Notion outage must not take the whole agent down; the tools simply
      // stay absent and the next turn retries the connection.
      failOnStartupError: false,
    }
  }

  function disposeMount(agentId) {
    const entry = mounts.get(agentId)
    if (entry === undefined) return
    mounts.delete(agentId)
    try {
      entry.fiber?.dispose?.()
    } catch (error) {
      log('warn', `agent ${agentId}: disposing the Notion mount failed — ${String(error)}`)
    }
  }

  /** (Re)mount this agent's Notion client inside its own scope. */
  function remountInScope(agent, entry, tokens) {
    const binding = state.bindings.find((candidate) => candidate.id === entry.bindingId)
    if (binding === undefined) {
      disposeMount(agent.id)
      return
    }
    try {
      entry.fiber?.dispose?.()
    } catch {
      // A dead fiber must not block the fresh one.
    }
    entry.fiber = entry.scope.plugin(mcpClient, mountConfig(binding, tokens.accessToken))
  }

  /** Bind one live agent to whichever binding owns its workspace. */
  async function mountFor(agent) {
    const cwd = agent?.session?.header?.cwd
    const key = canonicalKey(cwd)
    if (key === null) return
    const binding = state.bindings.find((candidate) => canonicalKey(candidate.workspacePath) === key)
    const existing = mounts.get(agent.id)
    if (binding === undefined) {
      // A workspace that was unbound between sessions must lose its tools.
      if (existing !== undefined) disposeMount(agent.id)
      return
    }
    if (existing !== undefined && existing.bindingId === binding.id) return

    const tokens = await readTokens(binding)
    if (tokens === undefined) {
      if (warned.get(binding.id) !== 'unauthorized') {
        warned.set(binding.id, 'unauthorized')
        log('warn', `${binding.id}: workspace "${cwd}" is bound but has no Notion grant — authorize it to get tools`)
      }
      return
    }
    warned.delete(binding.id)

    disposeMount(agent.id)
    // `inject` runs once the scoped tool registry is available, and re-runs if
    // it ever goes away; the mount is rebuilt on each run rather than appended.
    agent.ctx.inject(['tools'], (scope) => {
      // `inject` re-runs if the scoped registry is ever replaced; drop the
      // previous mount so a re-run cannot orphan an MCP connection.
      if (mounts.has(agent.id)) disposeMount(agent.id)
      const entry = { bindingId: binding.id, scope, fiber: undefined }
      mounts.set(agent.id, entry)
      remountInScope(agent, entry, tokens)
      scope.effect(() => () => {
        if (mounts.get(agent.id) === entry) mounts.delete(agent.id)
      })
    })
  }

  /** Mount every already-live agent — the plugin may load after they exist. */
  async function mountAllLiveAgents() {
    let live = []
    try {
      const registry = ctx.get('agents')
      if (registry !== undefined && typeof registry.list === 'function') live = registry.list()
    } catch {
      return
    }
    for (const agent of live) {
      try {
        await mountFor(agent)
      } catch (error) {
        log('warn', `agent ${agent?.id}: initial Notion mount failed — ${String(error)}`)
      }
    }
  }

  ctx.on('agent/created', ({ agent }) => {
    void mountFor(agent).catch((error) => {
      log('warn', `agent ${agent?.id}: Notion mount failed — ${String(error)}`)
    })
  })
  ctx.on('agent/disposed', ({ agent }) => {
    if (agent !== undefined) disposeMount(agent.id)
  })

  // -- token refresh -------------------------------------------------------

  /**
   * Keep every binding's access token fresh, and remount the agents holding the
   * old one.
   *
   * Remounting is not optional: a mounted MCP client sends the bearer token it
   * was created with, so a rotation that only rewrote the credential store
   * would leave live sessions authenticating with a token the server has
   * already retired.
   */
  async function refreshDueTokens() {
    for (const binding of state.bindings) {
      const tokens = await readTokens(binding)
      if (tokens === undefined) continue
      const expiresAt = typeof tokens.expiresAt === 'number' ? tokens.expiresAt : 0
      if (expiresAt - Date.now() > REFRESH_WINDOW_MS) continue
      if (typeof tokens.refreshToken !== 'string' || tokens.refreshToken === '') continue
      try {
        const refreshed = await refreshAccessToken(tokens.tokenEndpoint, {
          clientId: tokens.clientId,
          refreshToken: tokens.refreshToken,
        })
        const next = {
          ...tokens,
          accessToken: refreshed.accessToken,
          refreshToken: refreshed.refreshToken ?? tokens.refreshToken,
          expiresAt: Date.now() + refreshed.expiresIn * 1000,
          workspaceId: refreshed.workspaceId ?? tokens.workspaceId,
          workspaceName: refreshed.workspaceName ?? tokens.workspaceName,
        }
        await writeTokens(binding, next)
        for (const [agentId, entry] of mounts) {
          if (entry.bindingId !== binding.id) continue
          const agent = ctx.get('agents')?.get?.(agentId)
          if (agent === undefined) continue
          remountInScope(agent, entry, next)
        }
        log('info', `${binding.id}: access token refreshed`)
      } catch (error) {
        if (error instanceof InvalidGrantError) {
          // Retired refresh token: drop it so the UI can say "re-authorize"
          // instead of silently retrying a credential that can never work.
          try {
            await ctx.credentials.unset(credentialRef(binding.credentialRef))
          } catch {
            // Best effort.
          }
          disposeBindingMounts(binding.id)
          log('warn', `${binding.id}: grant was revoked or rotated away — re-authorize it`)
        } else {
          log('warn', `${binding.id}: token refresh failed — ${String(error)}`)
        }
      }
    }
  }

  function disposeBindingMounts(bindingId) {
    for (const [agentId, entry] of [...mounts]) {
      if (entry.bindingId === bindingId) disposeMount(agentId)
    }
  }

  const refreshTimer = setInterval(() => {
    void refreshDueTokens().catch((error) => log('warn', `refresh sweep failed — ${String(error)}`))
  }, REFRESH_TICK_MS)
  refreshTimer.unref?.()
  ctx.effect(() => () => clearInterval(refreshTimer), 'notion-workspaces: refresh sweep')

  // -- binding mutations ---------------------------------------------------

  function applyBindings(next) {
    state = { version: 1, bindings: next }
    saveState(statePath, state)
    warned.clear()
    // Drop mounts whose binding was removed or re-pointed, then re-evaluate
    // every live agent against the new table.
    for (const [agentId, entry] of [...mounts]) {
      if (!state.bindings.some((binding) => binding.id === entry.bindingId)) disposeMount(agentId)
    }
    return mountAllLiveAgents()
  }

  // -- authorization -------------------------------------------------------

  /**
   * Start one OAuth login for a binding.
   * @returns the URL a human must open. The grant lands in the credential
   *   store when the browser comes back, which `done` awaits.
   */
  async function authorize(binding) {
    const inFlight = logins.get(binding.id)
    if (inFlight !== undefined && inFlight.state === 'pending') return { url: inFlight.url, resumed: true }

    const login = await beginLogin({
      mcpUrl,
      port: binding.port,
      clientName: `dsh-notion-workspaces (${binding.label || binding.id})`,
    })
    const record = { state: 'pending', url: login.url, error: undefined, startedAt: Date.now() }
    logins.set(binding.id, record)
    void login.done.then(
      async (tokens) => {
        try {
          await writeTokens(binding, tokens)
          record.state = 'authorized'
          record.error = undefined
          warned.delete(binding.id)
          log('info', `${binding.id}: authorized${tokens.workspaceName === undefined ? '' : ` (${tokens.workspaceName})`}`)
          await mountAllLiveAgents()
        } catch (error) {
          record.state = 'failed'
          record.error = String(error)
        }
      },
      (error) => {
        record.state = 'failed'
        record.error = String(error)
      },
    )
    return { url: login.url, resumed: false }
  }

  async function revoke(binding) {
    try {
      await ctx.credentials.unset(credentialRef(binding.credentialRef))
    } catch (error) {
      log('warn', `${binding.id}: clearing the stored grant failed — ${String(error)}`)
    }
    logins.delete(binding.id)
    disposeBindingMounts(binding.id)
  }

  // -- HTTP surface for the configuration UI -------------------------------

  function sendJson(res, status, body) {
    const payload = JSON.stringify(body)
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'Content-Length': Buffer.byteLength(payload),
    })
    res.end(payload)
  }

  /**
   * Reject cross-origin writes.
   *
   * The GUI is same-origin, so a foreign `Origin` is either a mistake or a
   * browser-mediated attack on a loopback port. A request with no Origin (curl,
   * a test) is allowed — that is the operator's own tooling, not a web page.
   */
  function sameOrigin(req) {
    const origin = req.headers.origin
    if (typeof origin !== 'string' || origin === '') return true
    try {
      return new URL(origin).host === req.headers.host
    } catch {
      return false
    }
  }

  async function readJsonBody(req) {
    const chunks = []
    let size = 0
    for await (const chunk of req) {
      size += chunk.length
      if (size > MAX_BODY_BYTES) throw new Error('request body too large')
      chunks.push(chunk)
    }
    if (size === 0) return {}
    // Tolerate a UTF-8 BOM: browsers never send one, but hand-written curl
    // payloads and PowerShell-generated files routinely do, and `JSON.parse`
    // rejects it as a stray token.
    return JSON.parse(Buffer.concat(chunks).toString('utf8').replace(/^\uFEFF/u, ''))
  }

  /** Bindings as the UI sees them, with grant state and live-mount counts. */
  async function describeBindings() {
    const described = []
    for (const binding of state.bindings) {
      const tokens = await readTokens(binding)
      const login = logins.get(binding.id)
      const pathKey = canonicalKey(binding.workspacePath)
      described.push({
        ...binding,
        workspaceExists: pathKey !== null,
        authorized: tokens !== undefined,
        workspaceName: tokens?.workspaceName,
        workspaceId: tokens?.workspaceId,
        expiresAt: tokens?.expiresAt,
        authorizedAt: tokens?.authorizedAt,
        loginState: login?.state,
        loginError: login?.error,
        loginUrl: login?.state === 'pending' ? login.url : undefined,
        mountedAgents: [...mounts.values()].filter((entry) => entry.bindingId === binding.id).length,
      })
    }
    return described
  }

  /** DSH workspaces, for the UI's directory picker. */
  function describeWorkspaces() {
    try {
      const registry = ctx.get('workspaceRegistry')
      if (registry === undefined || typeof registry.list !== 'function') return []
      return registry.list().map((workspace) => ({
        id: String(workspace?.id ?? ''),
        title: typeof workspace?.title === 'string' ? workspace.title : '',
        path: typeof workspace?.path === 'string' ? workspace.path : '',
      }))
    } catch {
      return []
    }
  }

  ctx.inject(['webServer'], (webCtx) => {
    // A log sink the client half reports through. Deliberately not
    // origin-guarded: it writes only diagnostics, and a rejection here would
    // hide exactly the fact this exists to establish.
    webCtx.effect(() => webCtx.webServer.register({
      kind: 'exact',
      path: `${ROUTE_PREFIX}/beacon`,
      handler: async (req, res) => {
        if (req.method !== 'POST') {
          sendJson(res, 405, { ok: false, error: 'method not allowed' })
          return
        }
        try {
          const body = await readJsonBody(req)
          diag({
            phase: `client:${typeof body?.phase === 'string' ? body.phase : 'unknown'}`,
            detail: body?.detail,
            userAgent: req.headers['user-agent'],
          })
        } catch (error) {
          diag({ phase: 'client:beacon-error', detail: String(error) })
        }
        sendJson(res, 200, { ok: true })
      },
    }), 'notion-workspaces: POST beacon')

    webCtx.effect(() => webCtx.webServer.register({
      kind: 'exact',
      path: `${ROUTE_PREFIX}/state`,
      handler: async (req, res) => {
        if (req.method !== 'GET') {
          sendJson(res, 405, { ok: false, error: 'method not allowed' })
          return
        }
        sendJson(res, 200, {
          ok: true,
          mcpUrl,
          statePath,
          workspaces: describeWorkspaces(),
          bindings: await describeBindings(),
        })
      },
    }), 'notion-workspaces: GET state')

    webCtx.effect(() => webCtx.webServer.register({
      kind: 'exact',
      path: `${ROUTE_PREFIX}/bindings`,
      handler: async (req, res) => {
        if (req.method !== 'POST') {
          sendJson(res, 405, { ok: false, error: 'method not allowed' })
          return
        }
        if (!sameOrigin(req)) {
          sendJson(res, 403, { ok: false, error: 'untrusted origin' })
          return
        }
        try {
          const body = await readJsonBody(req)
          const incoming = Array.isArray(body?.bindings) ? body.bindings : undefined
          if (incoming === undefined) {
            sendJson(res, 400, { ok: false, error: 'bindings must be an array' })
            return
          }
          const parsed = parseState(JSON.stringify({ version: 1, bindings: incoming }), basePort)
          if (parsed.bindings.length !== incoming.length) {
            sendJson(res, 400, {
              ok: false,
              error: '每个绑定都需要一个存在的 workspacePath；id 不能重复',
            })
            return
          }
          await applyBindings(parsed.bindings)
          sendJson(res, 200, { ok: true, statePath, bindings: await describeBindings() })
        } catch (error) {
          sendJson(res, 400, { ok: false, error: String(error) })
        }
      },
    }), 'notion-workspaces: POST bindings')

    webCtx.effect(() => webCtx.webServer.register({
      kind: 'exact',
      path: `${ROUTE_PREFIX}/authorize`,
      handler: async (req, res) => {
        if (req.method !== 'POST') {
          sendJson(res, 405, { ok: false, error: 'method not allowed' })
          return
        }
        if (!sameOrigin(req)) {
          sendJson(res, 403, { ok: false, error: 'untrusted origin' })
          return
        }
        try {
          const body = await readJsonBody(req)
          const binding = state.bindings.find((candidate) => candidate.id === body?.id)
          if (binding === undefined) {
            sendJson(res, 404, { ok: false, error: 'unknown binding' })
            return
          }
          const result = await authorize(binding)
          sendJson(res, 200, { ok: true, url: result.url, resumed: result.resumed })
        } catch (error) {
          sendJson(res, 502, { ok: false, error: String(error) })
        }
      },
    }), 'notion-workspaces: POST authorize')

    webCtx.effect(() => webCtx.webServer.register({
      kind: 'exact',
      path: `${ROUTE_PREFIX}/revoke`,
      handler: async (req, res) => {
        if (req.method !== 'POST') {
          sendJson(res, 405, { ok: false, error: 'method not allowed' })
          return
        }
        if (!sameOrigin(req)) {
          sendJson(res, 403, { ok: false, error: 'untrusted origin' })
          return
        }
        try {
          const body = await readJsonBody(req)
          const binding = state.bindings.find((candidate) => candidate.id === body?.id)
          if (binding === undefined) {
            sendJson(res, 404, { ok: false, error: 'unknown binding' })
            return
          }
          await revoke(binding)
          sendJson(res, 200, { ok: true, bindings: await describeBindings() })
        } catch (error) {
          sendJson(res, 502, { ok: false, error: String(error) })
        }
      },
    }), 'notion-workspaces: POST revoke')
  })

  // -- CLI fallback --------------------------------------------------------

  /**
   * `dsh notion-workspaces login <bindingId>` — authorization for a profile
   * with no web server (a minimal CLI profile), the same escape hatch the
   * upstream plugin documents for its own `notion login`.
   */
  ctx.inject(['cmdlineArgs'], (cliCtx) => {
    const argv = cliCtx.cmdlineArgs?.get?.() ?? []
    if (argv[0] !== 'notion-workspaces' || argv[1] !== 'login') return
    const bindingId = argv[2]
    const binding = state.bindings.find((candidate) => candidate.id === bindingId)
    if (binding === undefined) {
      ctx.logger?.error?.(`[notion-workspaces] unknown binding "${bindingId ?? ''}" — known: ${state.bindings.map((b) => b.id).join(', ') || '(none)'}`)
      ctx.appExit?.(1)
      return
    }
    void authorize(binding).then(
      ({ url }) => {
        ctx.logger?.info?.(`[notion-workspaces] open this URL to authorize "${binding.id}":\n${url}`)
      },
      (error) => {
        ctx.logger?.error?.(`[notion-workspaces] could not start authorization — ${String(error)}`)
        ctx.appExit?.(1)
      },
    )
  })

  // -- boot ----------------------------------------------------------------

  void mountAllLiveAgents().catch((error) => log('warn', `initial mount sweep failed — ${String(error)}`))
}
