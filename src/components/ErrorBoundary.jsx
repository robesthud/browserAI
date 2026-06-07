import { Component } from 'react'

/**
 * Top-level error boundary so the user never sees a blank grey screen.
 * Also pings /api/debug/client-error so operators can read the stack via SSH:
 *   tail -f /opt/browserai-data/client-errors.log
 *
 * Hooks into:
 *   - React render errors (componentDidCatch)
 *   - window.onerror (sync runtime errors outside React tree)
 *   - window.unhandledrejection (async promises)
 */
export default class ErrorBoundary extends Component {
  constructor(props) {
    super(props)
    this.state = { error: null, info: null, source: null }
    this._onError = (event) => {
      this.report('window.onerror', {
        message: event.message,
        filename: event.filename,
        lineno: event.lineno,
        colno: event.colno,
        stack: event.error?.stack || null,
      })
    }
    this._onRejection = (event) => {
      const reason = event.reason
      this.report('unhandledrejection', {
        message: typeof reason === 'string' ? reason : reason?.message || String(reason),
        stack: reason?.stack || null,
      })
    }
  }

  componentDidMount() {
    window.addEventListener('error', this._onError)
    window.addEventListener('unhandledrejection', this._onRejection)
  }

  componentWillUnmount() {
    window.removeEventListener('error', this._onError)
    window.removeEventListener('unhandledrejection', this._onRejection)
  }

  static getDerivedStateFromError(error) {
    return { error, source: 'react-render' }
  }

  componentDidCatch(error, info) {
    this.setState({ info })
    this.report('react-componentDidCatch', {
      message: error?.message,
      stack: error?.stack,
      componentStack: info?.componentStack,
    })
  }

  report(kind, payload) {
    try {
      fetch('/api/debug/client-error', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          kind,
          url: typeof location !== 'undefined' ? location.href : '',
          ua: typeof navigator !== 'undefined' ? navigator.userAgent : '',
          ts: new Date().toISOString(),
          ...payload,
        }),
        keepalive: true,
      }).catch(() => {})
    } catch {}
  }

  render() {
    if (this.state.error) {
      const msg = this.state.error?.message || String(this.state.error)
      const stack = this.state.error?.stack || ''
      return (
        <div style={{
          minHeight: '100vh',
          background: '#1a1a1a',
          color: '#f5e6d3',
          padding: '24px',
          fontFamily: 'system-ui, sans-serif',
          overflow: 'auto',
        }}>
          <h1 style={{ color: '#ff6b6b', marginBottom: 12 }}>⚠️ Ошибка интерфейса</h1>
          <p style={{ marginBottom: 16, color: '#aaa' }}>
            Источник: <code>{this.state.source}</code>
          </p>
          <pre style={{
            background: '#0d0d0d',
            padding: 16,
            borderRadius: 8,
            overflow: 'auto',
            fontSize: 12,
            color: '#ffb3b3',
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
          }}>{msg}</pre>
          {stack && (
            <pre style={{
              background: '#0d0d0d',
              padding: 16,
              borderRadius: 8,
              overflow: 'auto',
              fontSize: 11,
              color: '#888',
              marginTop: 12,
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
            }}>{stack}</pre>
          )}
          <div style={{ marginTop: 16, display: 'flex', gap: 8 }}>
            <button
              onClick={() => location.reload()}
              style={{
                background: '#10b981',
                color: '#000',
                padding: '10px 20px',
                border: 'none',
                borderRadius: 8,
                fontWeight: 600,
                cursor: 'pointer',
              }}
            >Перезагрузить</button>
            <button
              onClick={() => this.setState({ error: null, info: null, source: null })}
              style={{
                background: '#3b3b3b',
                color: '#f5e6d3',
                padding: '10px 20px',
                border: '1px solid #555',
                borderRadius: 8,
                cursor: 'pointer',
              }}
            >Продолжить</button>
          </div>
          <p style={{ marginTop: 24, fontSize: 11, color: '#666' }}>
            Стек ошибки отправлен серверу для диагностики.
          </p>
        </div>
      )
    }
    return this.props.children
  }
}
