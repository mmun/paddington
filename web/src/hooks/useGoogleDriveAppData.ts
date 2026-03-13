import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { GoogleDriveAppDataClient } from '../lib/googleDriveAppData'
import type { WalkingPadStateSnapshot } from '../lib/walkingPadState'

type SyncState = 'unconfigured' | 'initializing' | 'signed-out' | 'authorizing' | 'ready' | 'syncing'

export function useGoogleDriveAppData(
  snapshot: WalkingPadStateSnapshot,
  onRestore: (snapshot: WalkingPadStateSnapshot) => void,
) {
  const clientId = (import.meta.env.VITE_GOOGLE_CLIENT_ID ?? '').trim()
  const clientRef = useRef<GoogleDriveAppDataClient | null>(null)
  const restoreGuardRef = useRef(false)
  const hasLoadedRemoteStateRef = useRef(false)

  const [syncState, setSyncState] = useState<SyncState>(clientId ? 'initializing' : 'unconfigured')
  const [syncError, setSyncError] = useState<string | null>(null)
  const [syncMessage, setSyncMessage] = useState<string>(() =>
    clientId ? 'Loading Google Identity Services…' : 'Set VITE_GOOGLE_CLIENT_ID to enable Google Drive sync.',
  )
  const [lastSyncedAt, setLastSyncedAt] = useState<string | null>(null)
  const lastSavedSignatureRef = useRef<string | null>(null)

  const snapshotSignature = useMemo(
    () =>
      JSON.stringify({
        version: snapshot.version,
        deviceName: snapshot.deviceName,
        sessionState: snapshot.sessionState,
        resumeSpeedKmh: snapshot.resumeSpeedKmh,
        metrics: snapshot.metrics,
      }),
    [snapshot],
  )

  useEffect(() => {
    if (!clientId) {
      return
    }

    const client = new GoogleDriveAppDataClient(clientId)
    clientRef.current = client

    let cancelled = false

    void client
      .initialize()
      .then(() => {
        if (cancelled) {
          return
        }

        setSyncState('signed-out')
        setSyncError(null)
        setSyncMessage('Google Drive sync is ready. Sign in to use appDataFolder backup.')
      })
      .catch((error: unknown) => {
        if (cancelled) {
          return
        }

        const message = error instanceof Error ? error.message : 'Google Drive sync failed to initialize.'
        setSyncState('unconfigured')
        setSyncError(message)
        setSyncMessage(message)
      })

    return () => {
      cancelled = true
    }
  }, [clientId])

  const loadRemoteState = useCallback(async () => {
    const client = clientRef.current
    if (!client) {
      return
    }

    setSyncState('syncing')
    setSyncError(null)
    setSyncMessage('Loading state from Google Drive…')

    try {
      const remoteState = await client.loadState()
      hasLoadedRemoteStateRef.current = true

      if (!remoteState) {
        setSyncState('ready')
        setSyncMessage('No saved WalkingPad state exists in appDataFolder yet.')
        return
      }

      restoreGuardRef.current = true
      onRestore(remoteState)
      window.setTimeout(() => {
        restoreGuardRef.current = false
      }, 0)

      lastSavedSignatureRef.current = JSON.stringify({
        version: remoteState.version,
        deviceName: remoteState.deviceName,
        sessionState: remoteState.sessionState,
        resumeSpeedKmh: remoteState.resumeSpeedKmh,
        metrics: remoteState.metrics,
      })
      setLastSyncedAt(remoteState.updatedAt)
      setSyncState('ready')
      setSyncMessage('Loaded the latest WalkingPad state from appDataFolder.')
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to load state from Google Drive.'
      setSyncState('ready')
      setSyncError(message)
      setSyncMessage(message)
    }
  }, [onRestore])

  const signIn = useCallback(async () => {
    const client = clientRef.current
    if (!client) {
      return
    }

    setSyncState('authorizing')
    setSyncError(null)
    setSyncMessage('Opening Google authorization…')

    try {
      await client.authorize('consent select_account')
      setSyncState('ready')
      setSyncMessage('Google Drive connected. Checking appDataFolder…')
      await loadRemoteState()
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Google sign-in failed.'
      setSyncState('signed-out')
      setSyncError(message)
      setSyncMessage(message)
    }
  }, [loadRemoteState])

  const signOut = useCallback(async () => {
    const client = clientRef.current
    if (!client) {
      return
    }

    await client.signOut()
    hasLoadedRemoteStateRef.current = false
    setSyncState('signed-out')
    setSyncError(null)
    setSyncMessage('Google Drive disconnected.')
  }, [])

  const saveRemoteState = useCallback(async () => {
    const client = clientRef.current
    if (!client) {
      return
    }

    const snapshotToSave: WalkingPadStateSnapshot = {
      ...snapshot,
      updatedAt: new Date().toISOString(),
    }

    setSyncState('syncing')
    setSyncError(null)
    setSyncMessage('Saving state to appDataFolder…')

    try {
      const response = await client.saveState(snapshotToSave)
      const updatedAt = new Date().toISOString()
      hasLoadedRemoteStateRef.current = true
      lastSavedSignatureRef.current = snapshotSignature
      setLastSyncedAt(response.modifiedTime ?? updatedAt)
      setSyncState('ready')
      setSyncMessage('WalkingPad state saved to appDataFolder.')
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to save state to Google Drive.'
      setSyncState('ready')
      setSyncError(message)
      setSyncMessage(message)
    }
  }, [snapshot, snapshotSignature])

  useEffect(() => {
    if (syncState !== 'ready') {
      return
    }

    if (!clientRef.current?.signedIn || !hasLoadedRemoteStateRef.current || restoreGuardRef.current) {
      return
    }

    if (lastSavedSignatureRef.current === snapshotSignature) {
      return
    }

    const timer = window.setTimeout(() => {
      void saveRemoteState()
    }, 1200)

    return () => window.clearTimeout(timer)
  }, [saveRemoteState, snapshotSignature, syncState])

  return {
    configured: Boolean(clientId),
    syncState,
    syncError,
    syncMessage,
    lastSyncedAt,
    signIn,
    signOut,
    loadRemoteState,
    saveRemoteState,
    signedIn: syncState === 'ready' || syncState === 'syncing',
  }
}
