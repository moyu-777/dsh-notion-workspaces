/**
 * Notion MCP OAuth (dynamic client registration + authorization code + PKCE).
 *
 * Ported from `dsh-notion-mcp` by mingzeng (github.com/mingzeng21), MIT
 * licensed — see NOTICE for the retained copyright notice. The flow is
 * unchanged because it is the one Notion actually accepts:
 *
 *   1. RFC 9470 protected-resource metadata on the MCP origin
 *   2. RFC 8414 authorization-server metadata
 *   3. RFC 7591 dynamic client registration (no client_id to copy by hand)
 *   4. authorization code + PKCE S256, callback on loopback
 *
 * The one deliberate difference from the upstream module is that the callback
 * port is a parameter rather than a constant. This plugin authorizes a
 * different Notion workspace per binding, so two logins may be in flight at
 * once and each needs its own loopback listener.
 *
 * @module dsh-notion-workspaces/notion-oauth
 */

import { createHash, randomBytes } from 'node:crypto'
import { createServer } from 'node:http'

/** Refresh token that the authorization server has retired. */
export class InvalidGrantError extends Error {
  constructor() {
    super('invalid_grant: refresh token expired or rotated away — re-authorize required')
    this.name = 'InvalidGrantError'
  }
}

const base64url = (buf) => buf.toString('base64url')

/** PKCE code verifier: 32 random bytes, base64url (43 chars, within RFC 7636). */
export function generateVerifier() {
  return base64url(randomBytes(32))
}

/** PKCE S256 challenge for one verifier. */
export function computeChallenge(verifier) {
  return base64url(createHash('sha256').update(verifier).digest())
}

/** Opaque CSRF token echoed back through the authorization server. */
export function generateState() {
  return base64url(randomBytes(16))
}

async function fetchJson(url, init) {
  const res = await fetch(url, init)
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`)
  return res.json()
}

/**
 * Endpoints advertised by the MCP resource's authorization server.
 * @param resourceBaseUrl - the MCP endpoint, e.g. `https://mcp.notion.com/mcp`.
 */
export async function discoverOAuth(resourceBaseUrl) {
  const origin = new URL(resourceBaseUrl).origin
  const protectedResource = await fetchJson(`${origin}/.well-known/oauth-protected-resource`)
  const authServer = protectedResource.authorization_servers?.[0]
  if (!authServer) throw new Error('OAuth discovery: no authorization_servers advertised')
  const meta = await fetchJson(`${authServer}/.well-known/oauth-authorization-server`)
  return {
    authorizationEndpoint: meta.authorization_endpoint,
    tokenEndpoint: meta.token_endpoint,
    registrationEndpoint: meta.registration_endpoint,
  }
}

/**
 * Register one throwaway public client for a set of loopback redirect URIs.
 * @returns the issued `client_id`; the flow uses no client secret.
 */
export async function registerClient(registrationEndpoint, redirectUris, clientName) {
  const res = await fetch(registrationEndpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_name: clientName,
      redirect_uris: redirectUris,
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
    }),
  })
  if (!res.ok) throw new Error(`DCR failed: HTTP ${res.status}`)
  return { clientId: (await res.json()).client_id }
}

/** Compose the URL the human opens in a browser. */
export function buildAuthorizeUrl(authorizationEndpoint, opts) {
  const url = new URL(authorizationEndpoint)
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('client_id', opts.clientId)
  url.searchParams.set('redirect_uri', opts.redirectUri)
  url.searchParams.set('state', opts.state)
  url.searchParams.set('code_challenge', opts.codeChallenge)
  url.searchParams.set('code_challenge_method', 'S256')
  return url.toString()
}

/** Normalize one token endpoint body, rejecting the shapes we cannot store. */
function parseTokenBody(body) {
  const accessToken = body.access_token
  const expiresIn = body.expires_in
  if (typeof accessToken !== 'string' || accessToken.length === 0) {
    throw new Error('token response missing access_token')
  }
  if (typeof expiresIn !== 'number' || !Number.isFinite(expiresIn) || expiresIn <= 0) {
    throw new Error('token response missing or invalid expires_in')
  }
  return {
    accessToken,
    refreshToken: typeof body.refresh_token === 'string' ? body.refresh_token : undefined,
    expiresIn,
    // Notion returns the workspace the grant is scoped to. Recorded so the
    // configuration UI can show WHICH Notion workspace a binding is attached
    // to instead of just "authorized".
    workspaceId: typeof body.workspace_id === 'string' ? body.workspace_id : undefined,
    workspaceName: typeof body.workspace_name === 'string' ? body.workspace_name : undefined,
    botId: typeof body.bot_id === 'string' ? body.bot_id : undefined,
  }
}

/** Exchange an authorization code (with its PKCE verifier) for tokens. */
export async function exchangeCode(tokenEndpoint, opts) {
  const res = await fetch(tokenEndpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: opts.clientId,
      code: opts.code,
      redirect_uri: opts.redirectUri,
      code_verifier: opts.codeVerifier,
    }),
  })
  if (!res.ok) throw new Error(`token exchange failed: HTTP ${res.status}`)
  return parseTokenBody(await res.json())
}

/**
 * Rotate an access token, distinguishing a retired refresh token from a
 * transient server fault: only the former must force re-authorization.
 */
export async function refreshAccessToken(tokenEndpoint, opts) {
  const res = await fetch(tokenEndpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: opts.clientId,
      refresh_token: opts.refreshToken,
    }),
  })
  const body = await res.json().catch(() => ({}))
  if (body.error === 'invalid_grant') throw new InvalidGrantError()
  if (!res.ok) throw new Error(`refresh failed: HTTP ${res.status}`)
  return parseTokenBody(body)
}

const SUCCESS_HTML = '<h1>授权成功，可以关闭此页面</h1><p>Notion 已连接，回到 DSH 继续即可。</p>'

/**
 * Listen on loopback for the one authorization redirect this login expects.
 *
 * Resolves as soon as the socket is listening — before any human has acted —
 * because the redirect URI is an input to client registration. The caller
 * awaits the returned `wait` promise separately.
 *
 * @param expectedState - the CSRF token this login minted.
 * @param port - preferred loopback port; 0 picks any free port.
 * @returns `{ redirectUri, wait, close }`; `wait` resolves with the code.
 */
export async function startLoginServer(expectedState, port) {
  let resolveWait
  let rejectWait
  const wait = new Promise((resolve, reject) => {
    resolveWait = resolve
    rejectWait = reject
  })
  // Nothing may await `wait` yet when a bind error rejects it; without this the
  // rejection would surface as an unhandled rejection.
  wait.catch(() => {})

  const server = createServer((req, res) => {
    let url
    try {
      url = new URL(req.url ?? '/', 'http://127.0.0.1')
    } catch {
      res.writeHead(400).end()
      return
    }
    if (url.pathname !== '/callback') {
      res.writeHead(404).end()
      return
    }
    const respond = (body, status = 200) => {
      res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end(body)
    }
    const fail = (html, error) => {
      respond(html, 400)
      rejectWait(error)
    }
    const error = url.searchParams.get('error')
    if (error !== null) {
      fail(`<h1>授权失败</h1><p>${error}</p>`, new Error(`OAuth error: ${error}`))
      return
    }
    const code = url.searchParams.get('code')
    const state = url.searchParams.get('state')
    if (code === null || code === '' || state === null || state === '') {
      fail('<h1>缺少 code 或 state</h1>', new Error('missing code or state'))
      return
    }
    if (state !== expectedState) {
      fail('<h1>state 校验失败</h1>', new Error('state mismatch'))
      return
    }
    respond(SUCCESS_HTML)
    resolveWait({ code, state })
  })

  await new Promise((resolveListen, rejectListen) => {
    const onError = (error) => {
      server.off('listening', onListening)
      rejectListen(error)
    }
    const onListening = () => {
      server.off('error', onError)
      resolveListen()
    }
    server.once('error', onError)
    server.once('listening', onListening)
    server.listen(port, '127.0.0.1')
  })

  const address = server.address()
  const actualPort = typeof address === 'object' && address !== null ? address.port : port
  return {
    redirectUri: `http://127.0.0.1:${actualPort}/callback`,
    wait,
    close: () => {
      try {
        server.close()
      } catch {
        // Already closed by a completed redirect.
      }
    },
  }
}

/**
 * Run one complete login: register a client, hand back the URL a human must
 * open, and settle the token on the returned promise.
 *
 * @param opts.mcpUrl - MCP endpoint whose authorization server to use.
 * @param opts.port - preferred loopback callback port.
 * @param opts.clientName - label recorded on the registered client.
 * @returns `{ url, redirectUri, done }`; `done` resolves with the token record.
 */
export async function beginLogin(opts) {
  const state = generateState()
  const verifier = generateVerifier()
  let server
  try {
    server = await startLoginServer(state, opts.port)
  } catch (error) {
    // A busy preferred port is not a failure: any loopback port is registrable.
    if (error?.code !== 'EADDRINUSE') throw error
    server = await startLoginServer(state, 0)
  }
  try {
    const discovery = await discoverOAuth(opts.mcpUrl)
    const { clientId } = await registerClient(
      discovery.registrationEndpoint,
      [server.redirectUri],
      opts.clientName,
    )
    const url = buildAuthorizeUrl(discovery.authorizationEndpoint, {
      clientId,
      redirectUri: server.redirectUri,
      state,
      codeChallenge: computeChallenge(verifier),
    })
    const done = (async () => {
      try {
        const { code } = await server.wait
        const tokens = await exchangeCode(discovery.tokenEndpoint, {
          clientId,
          code,
          redirectUri: server.redirectUri,
          codeVerifier: verifier,
        })
        return {
          accessToken: tokens.accessToken,
          refreshToken: tokens.refreshToken,
          clientId,
          tokenEndpoint: discovery.tokenEndpoint,
          expiresAt: Date.now() + tokens.expiresIn * 1000,
          workspaceId: tokens.workspaceId,
          workspaceName: tokens.workspaceName,
          botId: tokens.botId,
          authorizedAt: Date.now(),
        }
      } finally {
        server.close()
      }
    })()
    return { url, redirectUri: server.redirectUri, done }
  } catch (error) {
    server.close()
    throw error
  }
}
