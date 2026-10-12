import { useCallback, useEffect, useState } from 'react'
import { onHostMessage, sendToHost } from './bridge'
import { useStylesStore } from './store/stylesStore'
import { Sidebar } from './components/Sidebar'
import { StyleGrid } from './components/StyleGrid'
import { ThumbProgressModal } from './components/ThumbProgressModal'
import { Toast } from './components/Toast'
import { LibraryToolbar } from './components/LibraryToolbar'
import {
  fetchUiPreferences,
  isPreferenceStorageKey,
  readCachedUiPreferences,
  saveUiPreferences,
  type UiPreferences,
} from './preferences'

export default function App() {
  const [isFullscreen, setIsFullscreen] = useState(false)
  const { setStyles } = useStylesStore()
  const [grouped, setGroupedState] = useState(() => readCachedUiPreferences().group_by_category)
  const setGrouped = useCallback((value: boolean) => {
    setGroupedState(value)
    saveUiPreferences({ group_by_category: value })
  }, [])

  const applyPreferences = useCallback((preferences: UiPreferences) => {
    setGroupedState(preferences.group_by_category)
    useStylesStore.getState().applyUiPreferences(preferences)
  }, [])

  const syncCachedPreferences = useCallback(() => {
    applyPreferences(readCachedUiPreferences())
  }, [applyPreferences])

  const syncPreferences = useCallback(async () => {
    try {
      applyPreferences(await fetchUiPreferences())
    } catch {
      syncCachedPreferences()
    }
  }, [applyPreferences, syncCachedPreferences])

  useEffect(() => {
    const timer = window.setTimeout(() => { void syncPreferences() }, 0)
    return () => window.clearTimeout(timer)
  }, [syncPreferences])

  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if (isPreferenceStorageKey(event.key)) syncCachedPreferences()
    }
    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') void syncPreferences()
    }

    window.addEventListener('storage', onStorage)
    window.addEventListener('focus', syncPreferences)
    window.addEventListener('pageshow', syncPreferences)
    document.addEventListener('visibilitychange', onVisibilityChange)
    return () => {
      window.removeEventListener('storage', onStorage)
      window.removeEventListener('focus', syncPreferences)
      window.removeEventListener('pageshow', syncPreferences)
      document.removeEventListener('visibilitychange', onVisibilityChange)
    }
  }, [syncCachedPreferences, syncPreferences])

  useEffect(() => {
    useStylesStore.getState().loadUsage()
    const unsub = onHostMessage((msg) => {
      if (msg.type === 'SG_INIT' || msg.type === 'SG_STYLES_UPDATE') {
        const raw: unknown = (msg as { styles?: unknown }).styles
        const arr = Array.isArray(raw)
          ? raw
          : Array.isArray((raw as { styles?: unknown[] } | null)?.styles)
            ? (raw as { styles: unknown[] }).styles
            : (raw as { categories?: Record<string, unknown[]> } | null)?.categories
              ? Object.values((raw as { categories: Record<string, unknown[]> }).categories).flat()
              : []
        setStyles(
          arr,
          msg.type === 'SG_INIT'
            ? msg.tab
            : useStylesStore.getState().tab,
        )
        void useStylesStore.getState().fetchPresets()
        void useStylesStore.getState().fetchLoras()
      }
      if (msg.type === 'SG_HOST_TAB') {
        void syncPreferences()
        useStylesStore.setState({ tab: msg.tab })
      }
      if (msg.type === 'SG_CLOSE') {
        sendToHost({ type: 'SG_CLOSE_REQUEST' })
      }
      if (msg.type === 'SG_CLEAR_SELECTION') {
        useStylesStore.setState({ selectedStyles: [] })
      }
      if (msg.type === 'SG_PROMPT_CHANGED') {
        if (useStylesStore.getState().hostPrompt !== msg.prompt) {
          useStylesStore.setState({ hostPrompt: msg.prompt })
        }
      }
      if (msg.type === 'SG_LORAS_UPDATED') {
        if (msg.clearSelection) {
          useStylesStore.getState().clearLoraBatchSelection()
        }
        void useStylesStore.getState().fetchLoras()
      }
      if (msg.type === 'SG_STYLE_APPLIED') {
        const { selectedStyles, addToRecent, silentMode } = useStylesStore.getState()
        addToRecent(msg.style.name)
        if (silentMode && !selectedStyles.some(s => s.name === msg.style.name)) {
          useStylesStore.getState().setSelectedStyles([...selectedStyles, msg.style])
        }
      }
      if (msg.type === 'SG_TEMP_WILDCARD_CREATED') {
        const store = useStylesStore.getState()
        store.finishStyleWildcardSelection()
        store.showToast(`Created ${msg.token} from ${msg.count} styles`, 'success')
      }
      if (msg.type === 'SG_STYLE_CATEGORIES_UPDATED') {
        useStylesStore.getState().clearStyleWildcardSelection()
      }
    })
    sendToHost({ type: 'SG_READY' })
    return unsub
  }, [setStyles, syncPreferences])

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !e.defaultPrevented) {
        sendToHost({ type: 'SG_CLOSE_REQUEST' })
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  const toggleFullscreen = () => {
    const iframe = window.frameElement as HTMLElement
    if (!iframe) return
    const wrapper = iframe.parentElement as HTMLElement
    if (!wrapper) return

    if (isFullscreen) {
      // Windowed mode (master-like): centered and readable
      wrapper.style.top = '80px'
      wrapper.style.right = '16px'
      wrapper.style.left = 'auto'
      wrapper.style.transform = 'none'
      wrapper.style.width = '1000px'
      wrapper.style.height = '650px'
      wrapper.style.minWidth = '600px'
      wrapper.style.minHeight = '400px'
      wrapper.style.maxWidth = '95vw'
      wrapper.style.maxHeight = '90vh'
      wrapper.style.borderRadius = '12px'
      wrapper.style.boxShadow = '0 25px 60px rgba(0,0,0,0.6), 0 0 0 1px rgba(255,255,255,0.05)'
      wrapper.style.resize = 'both'
      setIsFullscreen(false)
      return
    }

    // Fullscreen mode
    wrapper.style.top = '0'
    wrapper.style.right = 'auto'
    wrapper.style.left = '0'
    wrapper.style.transform = 'none'
    wrapper.style.width = '100vw'
    wrapper.style.height = '100vh'
    wrapper.style.minWidth = ''
    wrapper.style.minHeight = ''
    wrapper.style.maxWidth = ''
    wrapper.style.maxHeight = ''
    wrapper.style.borderRadius = '0'
    wrapper.style.boxShadow = 'none'
    wrapper.style.resize = 'none'
    setIsFullscreen(true)
  }

  const viewProps = { grouped, setGrouped, isFullscreen, toggleFullscreen }
  return (
    <div className="sg-library-app">
      <LibraryToolbar {...viewProps} />
      <div className="sg-library-body">
        <aside className="sg-library-sidebar"><Sidebar {...viewProps} /></aside>
        <main className="sg-library-main" aria-label="Style library">
          <div className="sg-library-content">
            <StyleGrid windowed={!isFullscreen} grouped={grouped} />
          </div>
        </main>
      </div>
      <ThumbProgressModal />
      <Toast />
    </div>
  )
}
