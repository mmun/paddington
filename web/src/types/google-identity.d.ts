interface GoogleTokenResponse {
  access_token: string
  expires_in: string | number
  scope: string
  token_type: string
  error?: string
  error_description?: string
}

interface GoogleTokenClientConfig {
  client_id: string
  scope: string
  callback: (response: GoogleTokenResponse) => void
  prompt?: string
  include_granted_scopes?: boolean
  error_callback?: (error: { type: 'popup_failed_to_open' | 'popup_closed' | 'unknown' }) => void
}

interface GoogleTokenClient {
  requestAccessToken(config?: {
    prompt?: string
    scope?: string
    include_granted_scopes?: boolean
    state?: string
    login_hint?: string
  }): void
}

interface Window {
  google?: {
    accounts: {
      oauth2: {
        initTokenClient(config: GoogleTokenClientConfig): GoogleTokenClient
        revoke(token: string, done: (response: { successful?: boolean; error?: string }) => void): void
      }
    }
  }
}
