const DEFAULT_ERROR_REPORT_URL = 'http://127.0.0.1:8787/client-error'

export interface ClientErrorPayload {
  message: string
  stack?: string
  context: string
  href: string
  userAgent: string
  timestamp: string
  extra?: Record<string, unknown>
}

function getReportUrl() {
  return (import.meta.env.VITE_ERROR_REPORT_URL ?? DEFAULT_ERROR_REPORT_URL).trim()
}

export function reportClientError(payload: ClientErrorPayload) {
  const body = JSON.stringify(payload)
  const reportUrl = getReportUrl()

  try {
    if (navigator.sendBeacon) {
      const blob = new Blob([body], { type: 'application/json' })
      navigator.sendBeacon(reportUrl, blob)
      return
    }
  } catch {
    // Fall through to fetch.
  }

  void fetch(reportUrl, {
    method: 'POST',
    mode: 'cors',
    keepalive: true,
    headers: {
      'Content-Type': 'application/json',
    },
    body,
  }).catch(() => undefined)
}

export function normalizeErrorPayload(
  errorValue: unknown,
  context: string,
  extra?: Record<string, unknown>,
): ClientErrorPayload {
  const error = errorValue instanceof Error ? errorValue : new Error(String(errorValue))

  return {
    message: error.message,
    stack: error.stack,
    context,
    href: window.location.href,
    userAgent: navigator.userAgent,
    timestamp: new Date().toISOString(),
    extra,
  }
}

export function installGlobalErrorForwarding() {
  window.addEventListener('error', (event) => {
    reportClientError(
      normalizeErrorPayload(event.error ?? new Error(event.message), 'window.error', {
        filename: event.filename,
        lineno: event.lineno,
        colno: event.colno,
      }),
    )
  })

  window.addEventListener('unhandledrejection', (event) => {
    reportClientError(
      normalizeErrorPayload(event.reason, 'window.unhandledrejection'),
    )
  })
}
