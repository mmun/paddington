import { isWalkingPadStateSnapshot, type WalkingPadStateSnapshot } from './walkingPadState'

const GOOGLE_IDENTITY_SCRIPT = 'https://accounts.google.com/gsi/client'
const DRIVE_APPDATA_SCOPE = 'https://www.googleapis.com/auth/drive.appdata'
const DRIVE_API_BASE = 'https://www.googleapis.com/drive/v3'
const DRIVE_UPLOAD_BASE = 'https://www.googleapis.com/upload/drive/v3'
const STATE_FILE_NAME = 'walkingpad-state.json'

interface DriveFileRecord {
  id: string
  name: string
  modifiedTime?: string
}

interface DriveUploadResponse {
  id: string
  modifiedTime?: string
}

function assertGoogleIdentity() {
  if (!window.google?.accounts.oauth2) {
    throw new Error('Google Identity Services failed to initialize.')
  }

  return window.google.accounts.oauth2
}

async function loadGoogleIdentityScript() {
  if (window.google?.accounts.oauth2) {
    return
  }

  await new Promise<void>((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>(
      `script[src="${GOOGLE_IDENTITY_SCRIPT}"]`,
    )

    if (existing) {
      existing.addEventListener('load', () => resolve(), { once: true })
      existing.addEventListener('error', () => reject(new Error('Could not load Google Identity Services.')), {
        once: true,
      })
      return
    }

    const script = document.createElement('script')
    script.src = GOOGLE_IDENTITY_SCRIPT
    script.async = true
    script.defer = true
    script.onload = () => resolve()
    script.onerror = () => reject(new Error('Could not load Google Identity Services.'))
    document.head.append(script)
  })
}

async function parseDriveError(response: Response) {
  const fallback = `Google Drive request failed with ${response.status}.`

  try {
    const payload = (await response.json()) as {
      error?: { message?: string }
    }
    return payload.error?.message ?? fallback
  } catch {
    return fallback
  }
}

export class GoogleDriveAppDataClient {
  private clientId: string
  private tokenClient: GoogleTokenClient | null = null
  private accessToken: string | null = null
  private expiresAt = 0
  private pendingTokenRequest:
    | {
        resolve: (response: GoogleTokenResponse) => void
        reject: (error: Error) => void
      }
    | null = null

  constructor(clientId: string) {
    this.clientId = clientId
  }

  get configured() {
    return this.clientId.length > 0
  }

  get signedIn() {
    return Boolean(this.accessToken) && Date.now() < this.expiresAt
  }

  async initialize() {
    if (!this.configured || this.tokenClient) {
      return
    }

    await loadGoogleIdentityScript()

    const oauth2 = assertGoogleIdentity()
    this.tokenClient = oauth2.initTokenClient({
      client_id: this.clientId,
      scope: DRIVE_APPDATA_SCOPE,
      include_granted_scopes: true,
      callback: (response) => {
        if (!this.pendingTokenRequest) {
          return
        }

        const pending = this.pendingTokenRequest
        this.pendingTokenRequest = null

        if (response.error || !response.access_token) {
          pending.reject(new Error(response.error_description ?? response.error ?? 'Google authorization failed.'))
          return
        }

        const expiresInMs = Number(response.expires_in) * 1000
        this.accessToken = response.access_token
        this.expiresAt = Date.now() + Math.max(expiresInMs - 60_000, 60_000)
        pending.resolve(response)
      },
      error_callback: (error) => {
        if (!this.pendingTokenRequest) {
          return
        }

        const pending = this.pendingTokenRequest
        this.pendingTokenRequest = null
        pending.reject(new Error(`Google sign-in failed: ${error.type}.`))
      },
    })
  }

  async authorize(prompt: '' | 'consent select_account' = 'consent select_account') {
    await this.initialize()

    if (!this.tokenClient) {
      throw new Error('Google token client is unavailable.')
    }

    return await new Promise<GoogleTokenResponse>((resolve, reject) => {
      this.pendingTokenRequest = { resolve, reject }
      this.tokenClient?.requestAccessToken({ prompt })
    })
  }

  async signOut() {
    if (!this.accessToken || !window.google?.accounts.oauth2) {
      this.accessToken = null
      this.expiresAt = 0
      return
    }

    const oauth2 = assertGoogleIdentity()

    await new Promise<void>((resolve) => {
      oauth2.revoke(this.accessToken!, () => resolve())
    })

    this.accessToken = null
    this.expiresAt = 0
  }

  async loadState() {
    const token = await this.ensureAccessToken()
    const file = await this.findStateFile(token)

    if (!file) {
      return null
    }

    const response = await fetch(`${DRIVE_API_BASE}/files/${file.id}?alt=media`, {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    })

    if (!response.ok) {
      throw new Error(await parseDriveError(response))
    }

    const payload = (await response.json()) as unknown

    if (!isWalkingPadStateSnapshot(payload)) {
      throw new Error('The saved Google Drive state file has an invalid format.')
    }

    return payload
  }

  async saveState(snapshot: WalkingPadStateSnapshot) {
    const token = await this.ensureAccessToken()
    const existing = await this.findStateFile(token)

    if (existing) {
      return await this.uploadState(token, snapshot, existing.id)
    }

    return await this.uploadState(token, snapshot)
  }

  private async ensureAccessToken() {
    if (this.accessToken && Date.now() < this.expiresAt) {
      return this.accessToken
    }

    await this.authorize('')

    if (!this.accessToken) {
      throw new Error('Google authorization did not return an access token.')
    }

    return this.accessToken
  }

  private async findStateFile(token: string) {
    const query = new URLSearchParams({
      spaces: 'appDataFolder',
      fields: 'files(id,name,modifiedTime)',
      q: `name='${STATE_FILE_NAME}'`,
      pageSize: '1',
    })

    const response = await fetch(`${DRIVE_API_BASE}/files?${query.toString()}`, {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    })

    if (!response.ok) {
      throw new Error(await parseDriveError(response))
    }

    const payload = (await response.json()) as {
      files?: DriveFileRecord[]
    }

    return payload.files?.[0] ?? null
  }

  private async uploadState(token: string, snapshot: WalkingPadStateSnapshot, fileId?: string) {
    const boundary = `walkingpad_${crypto.randomUUID()}`
    const metadata = JSON.stringify(
      fileId ? { name: STATE_FILE_NAME } : { name: STATE_FILE_NAME, parents: ['appDataFolder'] },
    )
    const media = JSON.stringify(snapshot)
    const body = [
      `--${boundary}`,
      'Content-Type: application/json; charset=UTF-8',
      '',
      metadata,
      `--${boundary}`,
      'Content-Type: application/json; charset=UTF-8',
      '',
      media,
      `--${boundary}--`,
      '',
    ].join('\r\n')

    const endpoint = fileId
      ? `${DRIVE_UPLOAD_BASE}/files/${fileId}?uploadType=multipart&fields=id,modifiedTime`
      : `${DRIVE_UPLOAD_BASE}/files?uploadType=multipart&fields=id,modifiedTime`
    const method = fileId ? 'PATCH' : 'POST'

    const response = await fetch(endpoint, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': `multipart/related; boundary=${boundary}`,
      },
      body,
    })

    if (!response.ok) {
      throw new Error(await parseDriveError(response))
    }

    return (await response.json()) as DriveUploadResponse
  }
}
