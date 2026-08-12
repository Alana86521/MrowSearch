import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react"
import type { ClearDataRequest, SearchEngine, SearchResponse, SearchResult, SessionResponse, SessionUser, ViewerCommand, ViewerEvent, ViewerPreferences, ViewerSnapshot } from "../shared/contracts"
import { classifyAddressInput } from "../shared/url"
import { api, formatError, post } from "./api"

type Page = "search" | "viewer" | "settings" | "admin" | "privacy"

interface AdminUser {
  id: string
  username: string
  role: "owner" | "user"
  status: "pending" | "active" | "disabled"
  createdAt: number
  approvedAt: number | null
  totpEnabled: boolean
}

interface WorkerHealth {
  id: string
  ready: boolean
  browserConnected: boolean
  audioReady: boolean
  sessionId: string | null
}

const emptySession: SessionResponse = { setupRequired: false, authenticated: false }
const searchEngineOptions: Array<{ value: SearchEngine; label: string }> = [
  { value: "duckduckgo", label: "DuckDuckGo" },
  { value: "bing", label: "Bing" },
  { value: "mojeek", label: "Mojeek" },
  { value: "qwant", label: "Qwant" },
  { value: "yahoo", label: "Yahoo" },
  { value: "mwmbl", label: "Mwmbl" },
  { value: "wiby", label: "Wiby" },
  { value: "wikipedia", label: "Wikipedia" }
]

export function App() {
  const [session, setSession] = useState<SessionResponse>(emptySession)
  const [loading, setLoading] = useState(true)
  const [page, setPage] = useState<Page>("search")
  const [snapshot, setSnapshot] = useState<ViewerSnapshot | null>(null)
  const [viewerEvent, setViewerEvent] = useState<ViewerEvent | null>(null)
  const [notice, setNotice] = useState("")

  const refreshSession = useCallback(async () => {
    const next = await api<SessionResponse>("/api/auth/session")
    setSession(next)
    return next
  }, [])

  useEffect(() => {
    refreshSession().catch(error => setNotice(formatError(error))).finally(() => setLoading(false))
  }, [refreshSession])

  useEffect(() => {
    if (!session.authenticated || !session.csrfToken) return
    const release = () => {
      void fetch("/api/viewer/session", { method: "DELETE", headers: { "x-csrf-token": session.csrfToken! }, credentials: "same-origin", keepalive: true })
    }
    window.addEventListener("pagehide", release)
    return () => window.removeEventListener("pagehide", release)
  }, [session.authenticated, session.csrfToken])

  const sendCommand = useCallback(async (command: ViewerCommand) => {
    if (!session.csrfToken) {
      return
    }
    const next = await post<ViewerSnapshot>("/api/viewer/command", command, session.csrfToken)
    setSnapshot(next)
  }, [session.csrfToken])

  useViewerConnection(page === "viewer" && Boolean(snapshot), session.csrfToken, setSnapshot, setViewerEvent, setNotice)

  if (loading) {
    return <main className="center-stage"><p className="muted">Loading MrowSearch.</p></main>
  }

  if (!session.authenticated || !session.user || !session.csrfToken) {
    return <AuthScreen session={session} onAuthenticated={refreshSession} />
  }

  const openResult = async (result: SearchResult) => {
    try {
      const next = snapshot ?? await post<ViewerSnapshot>("/api/viewer/session", {}, session.csrfToken)
      const activeTabId = next.activeTabId
      if (!activeTabId) {
        throw new Error("The viewer did not create a private tab.")
      }
      setSnapshot(await post<ViewerSnapshot>("/api/viewer/command", { type: "navigate", tabId: activeTabId, value: result.url }, session.csrfToken))
      setPage("viewer")
    } catch (error) {
      setNotice(formatError(error))
    }
  }

  const logout = async () => {
    try {
      await post("/api/auth/logout", {}, session.csrfToken)
      sessionStorage.clear()
      setSnapshot(null)
      setSession(emptySession)
    } catch (error) {
      setNotice(formatError(error))
    }
  }

  return (
    <div className="app-shell">
      <Header page={page} user={session.user} onNavigate={setPage} onLogout={logout} />
      {notice && <div className="notice" role="status"><span>{notice}</span><button type="button" onClick={() => setNotice("")}>Dismiss</button></div>}
      {page === "search" && <SearchScreen user={session.user} csrfToken={session.csrfToken} onOpen={openResult} onNotice={setNotice} />}
      {page === "viewer" && <ViewerScreen snapshot={snapshot} viewerEvent={viewerEvent} csrfToken={session.csrfToken} onSnapshot={setSnapshot} onViewerEvent={setViewerEvent} onCommand={sendCommand} onSearch={() => setPage("search")} onNotice={setNotice} />}
      {page === "settings" && <SettingsScreen user={session.user} csrfToken={session.csrfToken} onSaved={refreshSession} onNotice={setNotice} />}
      {page === "admin" && session.user.role === "owner" && <AdminScreen csrfToken={session.csrfToken} onNotice={setNotice} />}
      {page === "privacy" && <PrivacyScreen csrfToken={session.csrfToken} onCleared={() => { setSnapshot(null); setPage("search") }} onNotice={setNotice} />}
    </div>
  )
}

function Header({ page, user, onNavigate, onLogout }: { page: Page; user: SessionUser; onNavigate: (page: Page) => void; onLogout: () => void }) {
  const links: Array<{ key: Page; label: string }> = [
    { key: "search", label: "Search" },
    { key: "viewer", label: "Viewer" },
    { key: "settings", label: "Settings" },
    { key: "privacy", label: "Privacy" }
  ]
  if (user.role === "owner") {
    links.push({ key: "admin", label: "Owner" })
  }
  return (
    <header className="app-header">
      <button className="wordmark" type="button" onClick={() => onNavigate("search")}>MrowSearch</button>
      <nav aria-label="Application">
        {links.map(link => <button className={page === link.key ? "nav-active" : ""} type="button" key={link.key} onClick={() => onNavigate(link.key)}>{link.label}</button>)}
      </nav>
      <div className="account-actions"><span>{user.username}</span><button type="button" onClick={onLogout}>Sign out</button></div>
    </header>
  )
}

function AuthScreen({ session, onAuthenticated }: { session: SessionResponse; onAuthenticated: () => Promise<SessionResponse> }) {
  const [mode, setMode] = useState<"login" | "invite" | "reset">(session.setupRequired ? "login" : "login")
  const [challengeToken, setChallengeToken] = useState("")
  const [error, setError] = useState("")
  const [busy, setBusy] = useState(false)
  const setup = session.setupRequired

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setBusy(true)
    setError("")
    const data = Object.fromEntries(new FormData(event.currentTarget)) as Record<string, string>
    try {
      if (challengeToken) {
        await post(data.method === "recovery" ? "/api/auth/recovery/complete" : "/api/auth/totp/complete", { challengeToken, code: data.code })
        await onAuthenticated()
        return
      }
      if (setup) {
        await post("/api/auth/setup", { setupToken: data.setupToken, username: data.username, password: data.password })
        await onAuthenticated()
        return
      }
      if (mode === "invite") {
        await post("/api/auth/register-invite", { code: data.inviteCode, username: data.username, password: data.password })
        setError("Your account is waiting for owner approval.")
        setMode("login")
        return
      }
      if (mode === "reset") {
        await post("/api/auth/password-reset", { code: data.resetCode, password: data.password })
        setError("Password reset. Sign in with the new password.")
        setMode("login")
        return
      }
      const result = await post<{ requiresTotp: boolean; challengeToken?: string }>("/api/auth/login", { username: data.username, password: data.password })
      if (result.requiresTotp && result.challengeToken) {
        setChallengeToken(result.challengeToken)
      } else {
        await onAuthenticated()
      }
    } catch (requestError) {
      setError(formatError(requestError))
    } finally {
      setBusy(false)
    }
  }

  return (
    <main className="auth-layout">
      <section className="auth-card" aria-labelledby="auth-title">
        <h1 id="auth-title">MrowSearch</h1>
        <p className="muted">{setup ? "Create the single owner account." : challengeToken ? "Complete two-step verification." : mode === "invite" ? "Use an invite to request access." : mode === "reset" ? "Set a new password with an owner reset code." : "Sign in to private search."}</p>
        <form onSubmit={submit}>
          {challengeToken ? (
            <>
              <label htmlFor="code">Verification or recovery code</label>
              <input id="code" name="code" autoComplete="one-time-code" required autoFocus />
              <label className="check-row"><input type="checkbox" name="method" value="recovery" /> Use a recovery code</label>
            </>
          ) : (
            <>
              {setup && <><label htmlFor="setup-token">Setup token</label><input id="setup-token" name="setupToken" type="password" autoComplete="off" required /></>}
              {mode === "invite" && <><label htmlFor="invite-code">Invite code</label><input id="invite-code" name="inviteCode" autoComplete="off" required /></>}
              {mode === "reset" && <><label htmlFor="reset-code">Password reset code</label><input id="reset-code" name="resetCode" autoComplete="off" required /></>}
              {mode !== "reset" && <><label htmlFor="username">Username</label><input id="username" name="username" autoComplete="username" required /></>}
              <label htmlFor="password">Password</label>
              <input id="password" name="password" type="password" autoComplete={mode === "login" ? "current-password" : "new-password"} minLength={12} required />
            </>
          )}
          {error && <p className="form-message" role="status">{error}</p>}
          <button className="primary" type="submit" disabled={busy}>{busy ? "Working" : setup ? "Create owner" : challengeToken ? "Verify" : mode === "invite" ? "Request access" : mode === "reset" ? "Reset password" : "Sign in"}</button>
        </form>
        {!setup && !challengeToken && <div className="auth-links">
          <button type="button" onClick={() => setMode(mode === "invite" ? "login" : "invite")}>{mode === "invite" ? "Return to sign in" : "Use an invite"}</button>
          <button type="button" onClick={() => setMode(mode === "reset" ? "login" : "reset")}>{mode === "reset" ? "Return to sign in" : "Use a reset code"}</button>
        </div>}
      </section>
    </main>
  )
}

function SearchScreen({ user, csrfToken, onOpen, onNotice }: { user: SessionUser; csrfToken: string; onOpen: (result: SearchResult) => void; onNotice: (message: string) => void }) {
  const [query, setQuery] = useState(() => {
    const pending = sessionStorage.getItem("mrow-pending-search") ?? ""
    sessionStorage.removeItem("mrow-pending-search")
    return pending
  })
  const [response, setResponse] = useState<SearchResponse | null>(null)
  const [busy, setBusy] = useState(false)
  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (!query.trim()) {
      return
    }
    setBusy(true)
    try {
      const next = await post<SearchResponse>("/api/search", { q: query, page: 1 }, csrfToken)
      setResponse(next)
      if (user.historyMode === "session") {
        const history = JSON.parse(sessionStorage.getItem("mrow-search-history") ?? "[]") as string[]
        sessionStorage.setItem("mrow-search-history", JSON.stringify([query, ...history.filter(value => value !== query)].slice(0, 50)))
      }
    } catch (error) {
      onNotice(formatError(error))
    } finally {
      setBusy(false)
    }
  }
  return (
    <main className="search-page">
      <section className="search-intro">
        <h1>Private search</h1>
        <p>Results stay in MrowSearch. Destination pages open in the isolated viewer.</p>
        <form className="search-form" onSubmit={submit}>
          <label className="sr-only" htmlFor="search-query">Search the web</label>
          <input id="search-query" value={query} onChange={event => setQuery(event.target.value)} placeholder="Search the web" autoComplete="off" autoFocus />
          <button className="primary" type="submit" disabled={busy}>{busy ? "Searching" : "Search"}</button>
        </form>
        <p className="search-meta">SafeSearch: {user.safeSearch === 0 ? "Off" : user.safeSearch === 2 ? "Strict" : "Moderate"}. Autocomplete is off.</p>
      </section>
      {response && <section className="results" aria-live="polite">
        <p className="result-count">Results for <strong>{response.query}</strong></p>
        {response.results.map(result => (
          <article className="result" key={result.id}>
            <button className="result-title" type="button" onClick={() => onOpen(result)}>{result.title}</button>
            <p className="result-url">{result.displayUrl}</p>
            <p>{result.snippet}</p>
            <span className="result-source">{result.source}</span>
          </article>
        ))}
      </section>}
    </main>
  )
}

function ViewerScreen({ snapshot, viewerEvent, csrfToken, onSnapshot, onViewerEvent, onCommand, onSearch, onNotice }: { snapshot: ViewerSnapshot | null; viewerEvent: ViewerEvent | null; csrfToken: string; onSnapshot: (snapshot: ViewerSnapshot | null) => void; onViewerEvent: (event: ViewerEvent | null) => void; onCommand: (command: ViewerCommand) => Promise<void>; onSearch: () => void; onNotice: (message: string) => void }) {
  const [address, setAddress] = useState("")
  const [externalUrl, setExternalUrl] = useState("")
  const [permissionsOpen, setPermissionsOpen] = useState(false)
  const [streamSrc, setStreamSrc] = useState("")
  const [audioEnabled, setAudioEnabled] = useState(false)
  const [audioStarting, setAudioStarting] = useState(false)
  const audioRef = useRef<HTMLAudioElement>(null)
  const active = snapshot?.tabs.find(tab => tab.id === snapshot.activeTabId) ?? null
  useEffect(() => setAddress(active?.currentUrl === "about:blank" ? "" : active?.currentUrl ?? ""), [active?.currentUrl])
  useEffect(() => {
    if (!snapshot) {
      setStreamSrc("")
      audioRef.current?.pause()
      audioRef.current?.removeAttribute("src")
      audioRef.current?.load()
      setAudioEnabled(false)
      setAudioStarting(false)
      return
    }
    let cancelled = false
    post<{ token: string }>("/api/auth/socket-token", {}, csrfToken).then(({ token }) => {
      if (cancelled) return
      const url = new URL(snapshot.streamPath, location.origin)
      url.searchParams.set("path", `api/viewer/stream?token=${encodeURIComponent(token)}`)
      setStreamSrc(`${url.pathname}${url.search}`)
    }).catch(error => onNotice(formatError(error)))
    return () => { cancelled = true }
  }, [snapshot?.sessionId, csrfToken, onNotice])

  const start = async () => {
    try {
      onSnapshot(await post<ViewerSnapshot>("/api/viewer/session", {}, csrfToken))
    } catch (error) {
      onNotice(formatError(error))
    }
  }
  const navigate = async (event: FormEvent) => {
    event.preventDefault()
    if (!active) {
      return
    }
    const destination = classifyAddressInput(address)
    if (destination.kind === "url") {
      await onCommand({ type: "navigate", tabId: active.id, value: destination.url }).catch(error => onNotice(formatError(error)))
      return
    }
    if (destination.kind === "invalid") {
      onNotice(destination.message)
      return
    }
    sessionStorage.setItem("mrow-pending-search", destination.query)
    onSearch()
  }
  const toggleAudio = async () => {
    const audio = audioRef.current
    if (!audio) {
      return
    }
    if (audioEnabled) {
      audio.pause()
      audio.removeAttribute("src")
      audio.load()
      setAudioEnabled(false)
      return
    }
    setAudioStarting(true)
    try {
      const { token } = await post<{ token: string }>("/api/auth/socket-token", {}, csrfToken)
      audio.src = `/api/viewer/audio?token=${encodeURIComponent(token)}`
      await audio.play()
      setAudioEnabled(true)
    } catch {
      audio.removeAttribute("src")
      audio.load()
      onNotice("Audio could not start. Check worker audio health and try again.")
    } finally {
      setAudioStarting(false)
    }
  }
  if (!snapshot) {
    return <main className="center-stage"><section className="empty-state"><h1>Private viewer</h1><p>Start an isolated Chromium session. Capacity is limited to four active viewers.</p><button className="primary" type="button" onClick={start}>Start viewer</button></section></main>
  }
  return (
    <main className="viewer-page">
      <div className="tab-strip" role="tablist" aria-label="Private tabs">
        {snapshot.tabs.map(tab => <div className={`tab ${tab.active ? "tab-active" : ""}`} key={tab.id} role="presentation"><button type="button" role="tab" aria-selected={tab.active} onClick={() => onCommand({ type: "activate", tabId: tab.id })}><span>{tab.suspended ? "Suspended" : tab.title || "New tab"}</span></button><button className="tab-close" type="button" aria-label={`Close ${tab.title || "tab"}`} title="Close tab" onClick={() => onCommand({ type: "close", tabId: tab.id })}>Close</button></div>)}
        <button type="button" onClick={() => onCommand({ type: "new-tab" })}>New tab</button>
      </div>
      <div className="viewer-toolbar" aria-label="Viewer controls">
        <button type="button" disabled={!active?.canGoBack} onClick={() => active && onCommand({ type: "back", tabId: active.id })}>Back</button>
        <button type="button" disabled={!active?.canGoForward} onClick={() => active && onCommand({ type: "forward", tabId: active.id })}>Forward</button>
        <button type="button" onClick={() => active && onCommand({ type: active.loading ? "stop" : "reload", tabId: active.id })}>{active?.loading ? "Stop" : "Reload"}</button>
        <button type="button" onClick={onSearch}>Home</button>
        <form onSubmit={navigate} className="address-form">
          <span className={`security-state ${active?.securityState === "insecure" ? "insecure" : ""}`}>{active?.securityState === "insecure" ? "Insecure HTTP" : active?.securityState === "secure" ? "HTTPS" : "Address"}</span>
          <label className="sr-only" htmlFor="viewer-address">Address or search</label>
          <input id="viewer-address" value={address} onChange={event => setAddress(event.target.value)} placeholder="Enter an address or search" autoComplete="off" />
          <button type="submit">Go</button>
        </form>
        <button type="button" disabled={!active?.currentUrl || active.currentUrl === "about:blank"} onClick={() => active && navigator.clipboard.writeText(active.currentUrl).then(() => onNotice("Destination URL copied.")).catch(() => onNotice("MrowSearch could not copy the URL. Use the address field to copy it."))}>Copy URL</button>
        <button type="button" disabled={!active?.currentUrl || active.currentUrl === "about:blank"} onClick={() => active && setExternalUrl(active.currentUrl)}>Open externally</button>
        <button type="button" onClick={() => active && onCommand({ type: "duplicate", tabId: active.id })}>Duplicate</button>
        <button type="button" onClick={() => onCommand({ type: "reopen-closed" })}>Reopen closed</button>
        <button type="button" disabled={!active?.currentUrl} onClick={() => setPermissionsOpen(true)}>Site permissions</button>
        <button type="button" disabled={audioStarting} onClick={() => void toggleAudio()}>{audioStarting ? "Starting audio" : audioEnabled ? "Mute audio" : "Enable audio"}</button>
        <button type="button" onClick={() => active && onCommand({ type: "clear-history", tabId: active.id })}>Clear history</button>
      </div>
      {active?.compatibility !== "ready" && active?.compatibility !== undefined && <div className="compatibility" role="alert"><strong>The destination cannot run in the private viewer.</strong><span>Check the address, try again, or open it externally.</span><button type="button" onClick={() => setExternalUrl(active.currentUrl)}>Open externally</button></div>}
      <div className="viewer-frame-wrap">
        {streamSrc ? <iframe title="Private Chromium display" className="viewer-frame" src={streamSrc} allow="clipboard-read 'none'; clipboard-write 'none'; camera 'none'; microphone 'none'; geolocation 'none'" /> : <div className="stream-loading">Connecting to the private display.</div>}
      </div>
      <audio ref={audioRef} preload="none" onEnded={() => setAudioEnabled(false)} onError={() => {
        setAudioEnabled(false)
        if (!audioStarting) onNotice("The audio stream stopped. Check worker audio health and try again.")
      }} />
      {externalUrl && <ConfirmExternal url={externalUrl} onCancel={() => setExternalUrl("")} />}
      {viewerEvent?.type === "download" && <DownloadApproval event={viewerEvent} onDecision={async decision => {
        await onCommand({ type: "download-decision", fileId: viewerEvent.fileId, decision })
        if (decision === "approve") {
          const link = document.createElement("a")
          link.href = `/api/viewer/downloads/${viewerEvent.fileId}`
          link.download = viewerEvent.filename
          link.click()
        }
        onViewerEvent(null)
      }} />}
      {viewerEvent?.type === "upload" && <UploadApproval event={viewerEvent} csrfToken={csrfToken} onComplete={() => onViewerEvent(null)} onNotice={onNotice} />}
      {viewerEvent?.type === "popup" && <div className="modal-backdrop" role="presentation"><section className="modal" role="dialog" aria-modal="true" aria-labelledby="popup-title"><h2 id="popup-title">Open a popup in a private tab?</h2><p>The current site requested a new window.</p><p className="url-preview">{viewerEvent.targetUrl}</p><div className="modal-actions"><button type="button" onClick={() => { void onCommand({ type: "popup-decision", requestId: viewerEvent.requestId, decision: "block" }); onViewerEvent(null) }}>Block</button><button className="primary" type="button" onClick={() => { void onCommand({ type: "popup-decision", requestId: viewerEvent.requestId, decision: "allow-once" }); onViewerEvent(null) }}>Open in private tab</button></div></section></div>}
      {viewerEvent?.type === "link-menu" && <div className="modal-backdrop" role="presentation"><section className="modal" role="dialog" aria-modal="true" aria-labelledby="link-title"><h2 id="link-title">Link actions</h2><p className="url-preview">{viewerEvent.targetUrl}</p><div className="link-actions"><button type="button" onClick={() => { void onCommand({ type: "link-action", requestId: viewerEvent.requestId, action: "open" }); onViewerEvent(null) }}>Open</button><button type="button" onClick={() => { void onCommand({ type: "link-action", requestId: viewerEvent.requestId, action: "private-tab" }); onViewerEvent(null) }}>Open in private tab</button><button type="button" onClick={() => { void navigator.clipboard.writeText(viewerEvent.targetUrl).then(() => onNotice("Link copied.")); onViewerEvent(null) }}>Copy link</button><button type="button" onClick={() => { setExternalUrl(viewerEvent.targetUrl); onViewerEvent(null) }}>Open externally</button></div></section></div>}
      {viewerEvent?.type === "clipboard" && <ClipboardApproval event={viewerEvent} onClose={() => onViewerEvent(null)} onCommand={onCommand} onNotice={onNotice} />}
      {permissionsOpen && active && <PermissionDialog tabId={active.id} origin={new URL(active.currentUrl).origin} onClose={() => setPermissionsOpen(false)} onDecision={async (permission, decision) => { await onCommand({ type: "set-permission", tabId: active.id, permission, decision }); setPermissionsOpen(false) }} />}
    </main>
  )
}

function ConfirmExternal({ url, onCancel }: { url: string; onCancel: () => void }) {
  const open = () => {
    window.open(url, "_blank", "noopener,noreferrer")
    onCancel()
  }
  return <div className="modal-backdrop" role="presentation"><section className="modal" role="dialog" aria-modal="true" aria-labelledby="external-title"><h2 id="external-title">Open outside MrowSearch?</h2><p>This sends the destination to your normal browser. It can enter local history and use your device network.</p><p className="url-preview">{url}</p><div className="modal-actions"><button type="button" onClick={onCancel}>Cancel</button><button className="primary" type="button" onClick={open}>Open externally</button></div></section></div>
}

function useViewerConnection(enabled: boolean, csrfToken: string | undefined, onSnapshot: (snapshot: ViewerSnapshot) => void, onEvent: (event: ViewerEvent) => void, onNotice: (message: string) => void) {
  useEffect(() => {
    if (!enabled || !csrfToken) {
      return
    }
    let socket: WebSocket | null = null
    let heartbeat = 0
    let cancelled = false
    post<{ token: string }>("/api/auth/socket-token", {}, csrfToken).then(({ token }) => {
      if (cancelled) {
        return
      }
      socket = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/api/viewer/control`)
      socket.addEventListener("open", () => {
        socket?.send(JSON.stringify({ type: "authenticate", token }))
        heartbeat = window.setInterval(() => socket?.readyState === WebSocket.OPEN && socket.send(JSON.stringify({ type: "heartbeat" })), 30000)
      })
      socket.addEventListener("message", event => {
        const message = JSON.parse(String(event.data)) as ViewerEvent
        if (message.type === "snapshot") {
          onSnapshot(message.snapshot)
        }
        if (message.type === "error") {
          onNotice(`${message.error.message}${message.error.action ? ` ${message.error.action}` : ""}`)
        }
        if (message.type === "notification") {
          onNotice(`${message.origin}: ${message.title}${message.body ? ` ${message.body}` : ""}`)
        } else if (!["snapshot", "error"].includes(message.type)) {
          onEvent(message)
        }
      })
      socket.addEventListener("close", event => {
        if (!cancelled) {
          onNotice(event.code === 1000 ? "The private viewer session ended. Start a new viewer to continue." : "The private viewer connection closed. Check worker health and try again.")
        }
      })
    }).catch(error => onNotice(formatError(error)))
    return () => {
      cancelled = true
      window.clearInterval(heartbeat)
      socket?.close()
    }
  }, [enabled, csrfToken, onSnapshot, onEvent, onNotice])
}

function DownloadApproval({ event, onDecision }: { event: Extract<ViewerEvent, { type: "download" }>; onDecision: (decision: "approve" | "reject") => Promise<void> }) {
  return <div className="modal-backdrop" role="presentation"><section className="modal" role="dialog" aria-modal="true" aria-labelledby="download-title"><h2 id="download-title">Approve download</h2><dl className="file-details"><dt>Filename</dt><dd>{event.filename}</dd><dt>Source</dt><dd>{event.sourceDomain}</dd><dt>Detected type</dt><dd>{event.mimeType}</dd><dt>Approximate size</dt><dd>{formatBytes(event.size)}</dd></dl><div className="modal-actions"><button className="danger" type="button" onClick={() => void onDecision("reject")}>Reject</button><button className="primary" type="button" onClick={() => void onDecision("approve")}>Download</button></div></section></div>
}

function UploadApproval({ event, csrfToken, onComplete, onNotice }: { event: Extract<ViewerEvent, { type: "upload" }>; csrfToken: string; onComplete: () => void; onNotice: (message: string) => void }) {
  const input = useRef<HTMLInputElement>(null)
  const upload = async (file: File) => {
    const data = new FormData()
    data.set("tabId", event.tabId)
    data.set("file", file)
    try {
      await api("/api/viewer/uploads", { method: "POST", body: data }, csrfToken)
      onComplete()
    } catch (error) {
      onNotice(formatError(error))
    }
  }
  return <div className="modal-backdrop" role="presentation"><section className="modal" role="dialog" aria-modal="true" aria-labelledby="upload-title"><h2 id="upload-title">Choose a file for this site</h2><p>The selected file enters temporary worker storage. The default limit is 100 MiB.</p><input ref={input} className="sr-only" type="file" accept={event.accept} multiple={event.multiple} onChange={change => { const file = change.target.files?.[0]; if (file) void upload(file) }} /><div className="modal-actions"><button type="button" onClick={onComplete}>Cancel</button><button className="primary" type="button" onClick={() => input.current?.click()}>Choose file</button></div></section></div>
}

function PermissionDialog({ origin, onClose, onDecision }: { tabId: string; origin: string; onClose: () => void; onDecision: (permission: "location" | "notifications" | "clipboard-read" | "clipboard-write", decision: "block" | "allow-once" | "allow-site") => Promise<void> }) {
  const [permission, setPermission] = useState<"location" | "notifications" | "clipboard-read" | "clipboard-write">("location")
  return <div className="modal-backdrop" role="presentation"><section className="modal" role="dialog" aria-modal="true" aria-labelledby="permission-title"><h2 id="permission-title">Site permissions</h2><p>{origin}</p><Select label="Permission" value={permission} onChange={value => setPermission(value as typeof permission)} options={[["location","Location"],["notifications","Notifications"],["clipboard-read","Read clipboard"],["clipboard-write","Write clipboard"]]} /><p>Camera and microphone access are always blocked. Clipboard access still needs a user action.</p><div className="modal-actions"><button type="button" onClick={onClose}>Cancel</button><button type="button" onClick={() => void onDecision(permission, "block")}>Block</button><button type="button" onClick={() => void onDecision(permission, "allow-once")}>Allow once</button><button className="primary" type="button" onClick={() => void onDecision(permission, "allow-site")}>Allow for site</button></div></section></div>
}

function ClipboardApproval({ event, onClose, onCommand, onNotice }: { event: Extract<ViewerEvent, { type: "clipboard" }>; onClose: () => void; onCommand: (command: ViewerCommand) => Promise<void>; onNotice: (message: string) => void }) {
  const block = async () => {
    await onCommand({ type: "clipboard-decision", requestId: event.requestId, decision: "block" })
    onClose()
  }
  const allow = async () => {
    try {
      if (event.operation === "clipboard-write") {
        await navigator.clipboard.writeText(event.text ?? "")
        await onCommand({ type: "clipboard-decision", requestId: event.requestId, decision: "allow" })
      } else {
        const text = await navigator.clipboard.readText()
        if (new TextEncoder().encode(text).byteLength > 1048576) {
          throw new Error("Clipboard text is larger than 1 MiB.")
        }
        await onCommand({ type: "clipboard-decision", requestId: event.requestId, decision: "allow", text })
      }
      onClose()
    } catch (error) {
      await onCommand({ type: "clipboard-decision", requestId: event.requestId, decision: "block" }).catch(() => undefined)
      onNotice(formatError(error))
      onClose()
    }
  }
  const size = event.text ? new TextEncoder().encode(event.text).byteLength : 0
  return <div className="modal-backdrop" role="presentation"><section className="modal" role="dialog" aria-modal="true" aria-labelledby="clipboard-title"><h2 id="clipboard-title">Approve clipboard access</h2><p>{event.origin} wants to {event.operation === "clipboard-write" ? "write text to" : "read text from"} your clipboard.</p>{event.operation === "clipboard-write" && <p>Text size: {formatBytes(size)}.</p>}<div className="modal-actions"><button type="button" onClick={() => void block()}>Block</button><button className="primary" type="button" onClick={() => void allow()}>Allow this time</button></div></section></div>
}

function formatBytes(value: number) {
  if (value < 1024) return `${value} B`
  if (value < 1048576) return `${(value / 1024).toFixed(1)} KiB`
  if (value < 1073741824) return `${(value / 1048576).toFixed(1)} MiB`
  return `${(value / 1073741824).toFixed(1)} GiB`
}

function SettingsScreen({ user, csrfToken, onSaved, onNotice }: { user: SessionUser; csrfToken: string; onSaved: () => Promise<SessionResponse>; onNotice: (message: string) => void }) {
  const initial: ViewerPreferences = useMemo(() => ({ safeSearch: user.safeSearch, searchEngines: user.searchEngines, privacyMode: user.privacyMode, historyMode: user.historyMode, trackingLevel: user.trackingLevel, popupPolicy: user.popupPolicy, closedTabsEnabled: user.closedTabsEnabled, clearOnLogout: user.clearOnLogout, clearOnTabClose: user.clearOnTabClose }), [user])
  const [preferences, setPreferences] = useState(initial)
  const [totp, setTotp] = useState<{ secret: string; qrCode: string } | null>(null)
  const [code, setCode] = useState("")
  const [recoveryCodes, setRecoveryCodes] = useState<string[]>([])
  const setSearchEngine = (engine: SearchEngine, enabled: boolean) => {
    if (!enabled && preferences.searchEngines.length === 1) {
      onNotice("Select at least one search engine.")
      return
    }
    setPreferences({ ...preferences, searchEngines: enabled ? [...preferences.searchEngines, engine] : preferences.searchEngines.filter(value => value !== engine) })
  }
  const save = async (event: FormEvent) => {
    event.preventDefault()
    try {
      await api("/api/settings/viewer", { method: "PUT", body: JSON.stringify(preferences) }, csrfToken)
      await onSaved()
      onNotice("Settings saved.")
    } catch (error) {
      onNotice(formatError(error))
    }
  }
  const startTotp = async () => {
    try {
      setTotp(await post("/api/auth/totp/start", {}, csrfToken))
    } catch (error) {
      onNotice(formatError(error))
    }
  }
  const confirmTotp = async () => {
    try {
      const result = await post<{ recoveryCodes: string[] }>("/api/auth/totp/confirm", { code }, csrfToken)
      setRecoveryCodes(result.recoveryCodes)
      setTotp(null)
      await onSaved()
    } catch (error) {
      onNotice(formatError(error))
    }
  }
  return <main className="settings-page"><div className="page-heading"><h1>Settings</h1><p>Control search, site data, and private tab behavior.</p></div><form className="settings-form" onSubmit={save}>
    <section><h2>Search and privacy</h2><div className="field-grid">
      <Select label="SafeSearch" value={String(preferences.safeSearch)} onChange={value => setPreferences({ ...preferences, safeSearch: Number(value) as 0 | 1 | 2 })} options={[['0','Off'],['1','Moderate'],['2','Strict']]} />
      <fieldset className="engine-fieldset"><legend>Search engines</legend><p>Choose which upstream engines receive your searches.</p><div className="engine-grid">{searchEngineOptions.map(engine => <Check key={engine.value} label={engine.label} checked={preferences.searchEngines.includes(engine.value)} onChange={value => setSearchEngine(engine.value, value)} />)}</div></fieldset>
      <Select label="Privacy mode" value={preferences.privacyMode} onChange={value => setPreferences({ ...preferences, privacyMode: value as ViewerPreferences["privacyMode"] })} options={[["ephemeral","Ephemeral"],["session","Session Only"],["persistent","Persistent"]]} />
      <Select label="Tracking protection" value={preferences.trackingLevel} onChange={value => setPreferences({ ...preferences, trackingLevel: value as ViewerPreferences["trackingLevel"] })} options={[["off","Off"],["standard","Standard"],["strict","Strict"]]} />
      <Select label="Popup policy" value={preferences.popupPolicy} onChange={value => setPreferences({ ...preferences, popupPolicy: value as ViewerPreferences["popupPolicy"] })} options={[["block","Block"],["ask","Ask"],["private-tab","Open in private tab"]]} />
      <Select label="History" value={preferences.historyMode} onChange={value => setPreferences({ ...preferences, historyMode: value as ViewerPreferences["historyMode"] })} options={[["never","Never keep"],["session","Current session"]]} />
    </div><div className="check-list">
      <Check label="Keep recently closed tabs for this session" checked={preferences.closedTabsEnabled} onChange={value => setPreferences({ ...preferences, closedTabsEnabled: value })} />
      <Check label="Clear session data when I sign out" checked={preferences.clearOnLogout} onChange={value => setPreferences({ ...preferences, clearOnLogout: value })} />
      <Check label="Clear ephemeral tab data when the tab closes" checked={preferences.clearOnTabClose} onChange={value => setPreferences({ ...preferences, clearOnTabClose: value })} />
    </div></section>
    <div className="form-actions"><button className="primary" type="submit">Save settings</button></div>
  </form><section className="settings-section"><h2>Two-step verification</h2>{user.totpEnabled ? <p>Time-based one-time password protection is enabled.</p> : <><p>Add an authenticator app. Save the recovery codes outside MrowSearch.</p>{!totp && <button type="button" onClick={startTotp}>Set up authenticator</button>}{totp && <div className="totp-setup"><img src={totp.qrCode} alt="Authenticator QR code" /><p>Manual key: <code>{totp.secret}</code></p><label htmlFor="totp-code">Six-digit code</label><input id="totp-code" value={code} onChange={event => setCode(event.target.value)} inputMode="numeric" /><button className="primary" type="button" onClick={confirmTotp}>Confirm</button></div>}{recoveryCodes.length > 0 && <div className="recovery-codes"><strong>Recovery codes</strong>{recoveryCodes.map(value => <code key={value}>{value}</code>)}</div>}</>}</section></main>
}

function Select({ label, value, onChange, options }: { label: string; value: string; onChange: (value: string) => void; options: string[][] }) {
  const id = `select-${label.toLowerCase().replaceAll(" ", "-")}`
  return <div><label htmlFor={id}>{label}</label><select id={id} value={value} onChange={event => onChange(event.target.value)}>{options.map(option => <option key={option[0]} value={option[0]}>{option[1]}</option>)}</select></div>
}

function Check({ label, checked, onChange }: { label: string; checked: boolean; onChange: (value: boolean) => void }) {
  return <label className="check-row"><input type="checkbox" checked={checked} onChange={event => onChange(event.target.checked)} /> {label}</label>
}

function AdminScreen({ csrfToken, onNotice }: { csrfToken: string; onNotice: (message: string) => void }) {
  const [users, setUsers] = useState<AdminUser[]>([])
  const [health, setHealth] = useState<WorkerHealth[]>([])
  const [network, setNetwork] = useState<{ settings: { dnsMode: string; dnsEndpoint: string; allowedPorts: number[] }; outboundAddresses: string[]; resolverStatus: string } | null>(null)
  const [invite, setInvite] = useState("")
  const [dnsMode, setDnsMode] = useState("system")
  const [dnsEndpoint, setDnsEndpoint] = useState("")
  const [ports, setPorts] = useState("80, 443")
  const load = useCallback(async () => {
    try {
      const [userResponse, healthResponse, networkResponse] = await Promise.all([
        api<{ users: AdminUser[] }>("/api/admin/users"),
        api<{ workers: WorkerHealth[] }>("/api/admin/health"),
        api<typeof network>("/api/admin/network")
      ])
      setUsers(userResponse.users)
      setHealth(healthResponse.workers)
      setNetwork(networkResponse)
      if (networkResponse) {
        setDnsMode(networkResponse.settings.dnsMode)
        setDnsEndpoint(networkResponse.settings.dnsEndpoint)
        setPorts(networkResponse.settings.allowedPorts.join(", "))
      }
    } catch (error) {
      onNotice(formatError(error))
    }
  }, [onNotice])
  useEffect(() => { void load() }, [load])
  const action = async (path: string, body: unknown = {}) => {
    try {
      await post(path, body, csrfToken)
      await load()
    } catch (error) {
      onNotice(formatError(error))
    }
  }
  const createInvite = async () => {
    try {
      const result = await post<{ code: string }>("/api/admin/invites", {}, csrfToken)
      setInvite(result.code)
    } catch (error) {
      onNotice(formatError(error))
    }
  }
  const saveNetwork = async (event: FormEvent) => {
    event.preventDefault()
    const allowedPorts = ports.split(",").map(value => Number(value.trim())).filter(Number.isInteger)
    await action("/api/admin/network", { dnsMode, dnsEndpoint, allowedPorts })
    onNotice("Network settings saved. The egress gateway will reload them within five seconds.")
  }
  return <main className="settings-page"><div className="page-heading"><h1>Owner settings</h1><p>Manage access, workers, DNS, and allowed destination ports.</p></div>
    <section className="settings-section"><h2>Invites</h2><p>Each code works once and expires after seven days.</p><button className="primary" type="button" onClick={createInvite}>Create invite</button>{invite && <div className="secret-output"><code>{invite}</code><button type="button" onClick={() => navigator.clipboard.writeText(invite)}>Copy code</button></div>}</section>
    <section className="settings-section"><h2>Users</h2><div className="data-list">{users.map(user => <div className="data-row" key={user.id}><div><strong>{user.username}</strong><span>{user.role}. {user.status}. {user.totpEnabled ? "Two-step enabled." : "Two-step off."}</span></div>{user.role !== "owner" && <div className="row-actions">{user.status === "pending" && <><button className="success" type="button" onClick={() => action(`/api/admin/users/${user.id}/approve`)}>Approve</button><button className="danger" type="button" onClick={() => action(`/api/admin/users/${user.id}/reject`)}>Reject</button></>}{user.status === "active" && <button type="button" onClick={() => action(`/api/admin/users/${user.id}/status`, { status: "disabled" })}>Disable</button>}{user.status === "disabled" && <button type="button" onClick={() => action(`/api/admin/users/${user.id}/status`, { status: "active" })}>Enable</button>}<button type="button" onClick={async () => { const result = await post<{ code: string }>(`/api/admin/users/${user.id}/password-reset`, {}, csrfToken); setInvite(result.code) }}>Reset password</button><button className="danger" type="button" onClick={() => api(`/api/admin/users/${user.id}`, { method: "DELETE" }, csrfToken).then(load).catch(error => onNotice(formatError(error)))}>Remove</button></div>}</div>)}</div></section>
    <section className="settings-section"><h2>Browser workers</h2><div className="worker-grid">{health.map(worker => <div className="worker" key={worker.id}><strong>{worker.id}</strong><span>{worker.ready && worker.browserConnected ? "Ready" : "Unavailable"}</span><span>{worker.audioReady ? "Audio ready" : "Audio unavailable"}</span><span>{worker.sessionId ? "In use" : "Available"}</span></div>)}</div></section>
    <section className="settings-section"><h2>Network and DNS</h2><p>MrowSearch uses the server network route. Configure the host VPN outside this application.</p>{network && <p className="diagnostic">Outbound address: {network.outboundAddresses.join(", ") || "Test unavailable"}. Resolver: {network.resolverStatus}.</p>}<form onSubmit={saveNetwork} className="field-grid"><Select label="DNS mode" value={dnsMode} onChange={setDnsMode} options={[["system","System DNS"],["custom","Custom DNS"],["doh","DNS over HTTPS"],["dot","DNS over TLS"]]} /><div><label htmlFor="dns-endpoint">Resolver endpoint</label><input id="dns-endpoint" value={dnsEndpoint} onChange={event => setDnsEndpoint(event.target.value)} placeholder={dnsMode === "doh" ? "https://resolver.example/dns-query" : "Resolver address"} disabled={dnsMode === "system"} /></div><div><label htmlFor="allowed-ports">Allowed destination ports</label><input id="allowed-ports" value={ports} onChange={event => setPorts(event.target.value)} /></div><div className="field-action"><button className="primary" type="submit">Save network settings</button></div></form></section>
  </main>
}

function PrivacyScreen({ csrfToken, onCleared, onNotice }: { csrfToken: string; onCleared: () => void; onNotice: (message: string) => void }) {
  const [range, setRange] = useState<ClearDataRequest["range"]>("all")
  const [selected, setSelected] = useState<ClearDataRequest["dataTypes"]>(["history", "cookies", "storage", "cache", "files", "permissions", "closed-tabs", "search-history", "form-state"])
  const types: Array<{ value: ClearDataRequest["dataTypes"][number]; label: string }> = [{ value: "history", label: "Viewer history" }, { value: "cookies", label: "Cookies" }, { value: "storage", label: "Site storage" }, { value: "cache", label: "Cache" }, { value: "files", label: "Temporary files" }, { value: "permissions", label: "Site permissions" }, { value: "closed-tabs", label: "Recently closed tabs" }, { value: "search-history", label: "Search history" }, { value: "form-state", label: "Form state" }]
  const clear = async () => {
    try {
      await post("/api/privacy/clear", { range, dataTypes: selected }, csrfToken)
      if (selected.includes("search-history")) sessionStorage.removeItem("mrow-search-history")
      if (selected.includes("closed-tabs")) sessionStorage.removeItem("mrow-closed-tabs")
      onCleared()
      onNotice("Selected data cleared.")
    } catch (error) {
      onNotice(formatError(error))
    }
  }
  const clearSession = async () => {
    try {
      await post("/api/privacy/clear-session", {}, csrfToken)
      sessionStorage.clear()
      onCleared()
      onNotice("Session cleared.")
    } catch (error) {
      onNotice(formatError(error))
    }
  }
  return <main className="settings-page"><div className="page-heading"><h1>Privacy and data</h1><p>MrowSearch reduces data exposure. It does not provide absolute anonymity.</p></div><section className="privacy-explainer"><h2>Where data can exist</h2><dl><dt>Your browser</dt><dd>The MrowSearch address, authentication cookie, and current session interface state.</dd><dt>Temporary server data</dt><dd>Browser profiles, uploads, downloads, cache, and viewer processes. Cleanup runs when a viewer ends.</dd><dt>Persistent server data</dt><dd>Your account, encrypted authenticator secret, account audit events, preferences, and encrypted site storage when Persistent mode is selected.</dd><dt>Destination sites</dt><dd>Data you submit, the server exit address, browser details, and site storage allowed by your privacy mode.</dd><dt>Search providers</dt><dd>The bundled search service sends full queries to its configured upstream engines. Autocomplete is off.</dd></dl></section><section className="settings-section"><h2>Clear browsing data</h2><Select label="Time range" value={range} onChange={value => setRange(value as ClearDataRequest["range"])} options={[["hour","Last hour"],["today","Today"],["all","All time"]]} /><div className="clear-grid">{types.map(type => <Check key={type.value} label={type.label} checked={selected.includes(type.value)} onChange={checked => setSelected(checked ? [...selected, type.value] : selected.filter(value => value !== type.value))} />)}</div><div className="form-actions"><button type="button" onClick={clearSession}>Clear session</button><button className="danger" type="button" disabled={selected.length === 0} onClick={clear}>Clear selected data</button></div></section></main>
}
