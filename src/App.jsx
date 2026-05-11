import { useEffect, useMemo, useState } from 'react'
import './App.css'

const fallbackReports = [
  {
    id: 'latest',
    generated_at: new Date().toISOString(),
    label: 'Latest',
    period_label: 'No saved report selected',
    has_shopify_data: false,
  },
]

const starterMessages = [
  {
    id: 'assistant-intro',
    role: 'assistant',
    text:
      'Ask me about the Meta Ads and Shopify reports posted to Teams. I can compare weeks, explain pruning decisions, and pull supporting snippets from saved reports.',
  },
]

const suggestions = [
  'Which ads should we scale this week?',
  'Summarize the latest pruning recommendations.',
  'Compare Meta performance with Shopify revenue.',
]

function App() {
  const [reports, setReports] = useState(fallbackReports)
  const [messages, setMessages] = useState(starterMessages)
  const [input, setInput] = useState('')
  const [isSending, setIsSending] = useState(false)
  const [selectedReport, setSelectedReport] = useState(fallbackReports[0].id)
  const [sources, setSources] = useState([])
  const [apiStatus, setApiStatus] = useState('Connecting')

  useEffect(() => {
    let isMounted = true

    async function loadReports() {
      try {
        const response = await fetch('/api/reports')
        if (!response.ok) {
          throw new Error('Report API is not available.')
        }

        const data = await response.json()
        const loadedReports = Array.isArray(data.reports) && data.reports.length
          ? data.reports
          : fallbackReports

        if (isMounted) {
          setReports(loadedReports)
          setSelectedReport(loadedReports[0].id)
          setApiStatus(data.reports?.length ? 'Supabase synced' : 'Waiting for reports')
        }
      } catch (error) {
        if (isMounted) {
          setApiStatus('API offline')
        }
      }
    }

    loadReports()

    return () => {
      isMounted = false
    }
  }, [])

  const activeReport = useMemo(
    () => reports.find((report) => report.id === selectedReport) || reports[0],
    [reports, selectedReport],
  )

  function formatReportDate(report) {
    if (report.label) {
      return report.label
    }

    return new Intl.DateTimeFormat('en', {
      month: 'short',
      day: 'numeric',
    }).format(new Date(report.generated_at))
  }

  async function sendMessage(messageText = input) {
    const trimmedMessage = messageText.trim()
    if (!trimmedMessage || isSending) {
      return
    }

    const userMessage = {
      id: crypto.randomUUID(),
      role: 'user',
      text: trimmedMessage,
    }

    setMessages((current) => [...current, userMessage])
    setInput('')
    setIsSending(true)

    try {
      const response = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: trimmedMessage,
          reportId: selectedReport,
        }),
      })

      if (!response.ok) {
        throw new Error('Chat endpoint is not available yet.')
      }

      const data = await response.json()
      setSources(data.sources?.length ? data.sources : [])
      setMessages((current) => [
        ...current,
        {
          id: crypto.randomUUID(),
          role: 'assistant',
          text: data.answer || 'I found the report context, but no answer was returned.',
        },
      ])
    } catch (error) {
      setMessages((current) => [
        ...current,
        {
          id: crypto.randomUUID(),
          role: 'assistant',
          text:
            'I could not reach the chat API. Start the backend server, then ask again and I will retrieve context from Supabase.',
          meta: error.message,
        },
      ])
    } finally {
      setIsSending(false)
    }
  }

  function handleSubmit(event) {
    event.preventDefault()
    sendMessage()
  }

  return (
    <main className="app-shell">
      <aside className="sidebar" aria-label="Report navigation">
        <div className="brand-block">
          <div className="brand-mark" aria-hidden="true">
            M
          </div>
          <div>
            <p className="eyebrow">Teams report RAG</p>
            <h1>Meta Update Bot</h1>
          </div>
        </div>

        <section className="panel">
          <div className="panel-heading">
            <h2>Saved Reports</h2>
            <span>{reports.length}</span>
          </div>
          <div className="report-list">
            {reports.map((report) => (
              <button
                className={`report-row ${selectedReport === report.id ? 'active' : ''}`}
                key={report.id}
                onClick={() => setSelectedReport(report.id)}
                type="button"
              >
                <span>
                  <strong>{formatReportDate(report)}</strong>
                  <small>{report.period_label || 'Stored report'}</small>
                </span>
                <em>{report.has_shopify_data ? 'Full' : 'Meta'}</em>
              </button>
            ))}
          </div>
        </section>

        <section className="panel metrics-panel">
          <div className="panel-heading">
            <h2>Latest Pulse</h2>
          </div>
          <dl>
            <div>
              <dt>Report</dt>
              <dd>{formatReportDate(activeReport)}</dd>
            </div>
            <div>
              <dt>Period</dt>
              <dd>{activeReport.period_label || 'Pending'}</dd>
            </div>
            <div>
              <dt>Shopify</dt>
              <dd>{activeReport.has_shopify_data ? 'Included' : 'Not included'}</dd>
            </div>
          </dl>
        </section>
      </aside>

      <section className="chat-area" aria-label="Chat workspace">
        <header className="chat-header">
          <div>
            <p className="eyebrow">Selected report: {formatReportDate(activeReport)}</p>
            <h2>Ask questions from Teams report history</h2>
          </div>
          <span className="status-dot">{apiStatus}</span>
        </header>

        <div className="chat-thread">
          {messages.map((message) => (
            <article className={`message ${message.role}`} key={message.id}>
              <div className="avatar" aria-hidden="true">
                {message.role === 'assistant' ? 'A' : 'Y'}
              </div>
              <div className="bubble">
                <p>{message.text}</p>
                {message.meta ? <small>{message.meta}</small> : null}
              </div>
            </article>
          ))}
          {isSending ? (
            <article className="message assistant">
              <div className="avatar" aria-hidden="true">
                A
              </div>
              <div className="bubble typing">
                <span></span>
                <span></span>
                <span></span>
              </div>
            </article>
          ) : null}
        </div>

        <div className="suggestion-row">
          {suggestions.map((suggestion) => (
            <button key={suggestion} onClick={() => sendMessage(suggestion)} type="button">
              {suggestion}
            </button>
          ))}
        </div>

        <form className="composer" onSubmit={handleSubmit}>
          <label htmlFor="chat-input">Message</label>
          <textarea
            id="chat-input"
            onChange={(event) => setInput(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault()
                sendMessage()
              }
            }}
            placeholder="Ask about ROAS, pruning, spend shifts, or Shopify validation..."
            rows="2"
            value={input}
          />
          <button aria-label="Send message" disabled={!input.trim() || isSending} type="submit">
            &rarr;
          </button>
        </form>
      </section>

      <aside className="context-panel" aria-label="Retrieved sources">
        <div className="panel-heading">
          <h2>Retrieved Context</h2>
          <span>{sources.length}</span>
        </div>
        <div className="source-list">
          {sources.length ? sources.map((source) => (
            <article className="source-card" key={source.id || source.title}>
              <div>
                <strong>{source.title}</strong>
                <small>{source.period}</small>
              </div>
              <p>{source.excerpt}</p>
            </article>
          )) : (
            <article className="source-card empty-source">
              <strong>No retrieved context yet</strong>
              <p>Ask a question and matching report sections will appear here.</p>
            </article>
          )}
        </div>
      </aside>
    </main>
  )
}

export default App
