import { create } from 'zustand'
import { sendToHost, type Lora, type Preset, type Style, type Tab } from '../bridge'
import {
  readCachedUiPreferences,
  saveUiPreferences,
  type UiPreferences,
} from '../preferences'

const cachedUiPreferences = readCachedUiPreferences()

/** Maps category text to a stable palette index for repeatable colors. */
export function getCategoryColor(category: string): string {
  // Fixed palette of visually distinct colors — no duplicates
  const PALETTE = [
    '#f472b6', // pink
    '#fb923c', // orange
    '#facc15', // yellow
    '#4ade80', // green
    '#34d399', // emerald
    '#22d3ee', // cyan
    '#60a5fa', // blue
    '#818cf8', // indigo
    '#a78bfa', // violet
    '#e879f9', // fuchsia
    '#f87171', // red
    '#a3e635', // lime
    '#2dd4bf', // teal
    '#38bdf8', // sky
    '#c084fc', // purple
    '#fb7185', // rose
    '#fdba74', // amber
    '#86efac', // light green
    '#93c5fd', // light blue
    '#fda4af', // light pink
    '#6ee7b7', // light teal
    '#fcd34d', // light yellow
    '#d8b4fe', // light purple
    '#67e8f9', // light cyan
    '#bbf7d0', // mint
    '#fecaca', // salmon
    '#bfdbfe', // powder blue
    '#ddd6fe', // lavender
    '#fed7aa', // peach
    '#bbf7d0', // seafoam
  ]

  // Deterministic index based on category name hash
  let hash = 0
  for (let i = 0; i < category.length; i++) {
    hash = category.charCodeAt(i) + ((hash << 5) - hash)
    hash = hash & hash // Convert to 32bit int
  }

  // Spread across palette using prime multiplication to avoid clustering
  const index = Math.abs(hash * 2654435761) % PALETTE.length
  return PALETTE[index]
}

/** Stable React key when the same name can appear from different CSV rows. */
export function styleRowKey(s: Pick<Style, 'name' | 'source_file'>): string {
  return `${s.source_file}\0${s.name}`
}

/** Return the family prefix used by the sidebar (for example, "Clothing"). */
export function getTopLevelCategory(category: string): string {
  const separator = category.indexOf(' - ')
  return separator === -1 ? category : category.slice(0, separator)
}

/** Match either an exact category or every child category in a family. */
export function categoryMatches(category: string, selectedCategory: string): boolean {
  return category === selectedCategory || category.startsWith(`${selectedCategory} - `)
}

/** Normalize current multi-category presets and legacy single-category presets. */
export function getPresetCategories(preset: Preset): string[] {
  const rawCategories = Array.isArray(preset.categories)
    ? preset.categories
    : (preset.category ? [preset.category] : [])
  const seen = new Set<string>()
  return rawCategories.filter(category => {
    const key = category.trim().toLowerCase()
    if (!key || seen.has(key)) return false
    seen.add(key)
    return true
  }).map(category => category.trim())
}

/** First occurrence wins; use only when the active source is "All sources". */
export function dedupeStylesByNameForAllSources(styles: Style[]): Style[] {
  const seen = new Set<string>()
  return styles.filter((s) => {
    if (seen.has(s.name)) return false
    seen.add(s.name)
    return true
  })
}

/** Map persisted or UI source string to an entry in `sources` (exact match, else basename). */
function resolveSourceInList(sources: string[], preferred: string | null): string | null {
  if (!preferred || sources.length === 0) return null
  if (sources.includes(preferred)) return preferred
  const key = (s: string) => {
    const base = s.replace(/\\/g, '/').split('/').pop() ?? s
    return base.replace(/\.csv$/i, '').toLowerCase()
  }
  const k = key(preferred)
  const found = sources.find((s) => key(s) === k)
  return found ?? null
}

/**
 * Values of `activeCategory` that are sidebar “special” views (not real CSV categories).
 * Matches Favorites / Recent; use the same checks in grid layout as those.
 */
export type ActiveSpecialView = '★ Favorites' | '🕑 Recent' | 'loras' | 'presets'

/** Central UI state for style filtering, selection, and host-side actions. */
interface StylesStore {
  toasts: { id: number; message: string; variant: 'success' | 'error' | 'info' }[]
  // Data
  styles: Style[]
  tab: Tab
  
  // Filters
  search: string
  activeCategory: string | null
  activeStyleCategories: string[]
  activeStyleTags: string[]
  activePresetCategories: string[]
  activeLoraCategories: string[]
  styleMultiSelect: boolean
  styleTagMultiSelect: boolean
  presetMultiSelect: boolean
  loraMultiSelect: boolean
  presetBatchSelect: boolean
  loraBatchSelect: boolean
  selectedPresetNames: string[]
  selectedLoraIds: string[]
  styleWildcardSelect: boolean
  selectedWildcardStyleNames: string[]
  sources: string[]
  activeSource: string | null
  
  // Selection
  selectedStyles: Style[]
  /** Collapsed category names in the All/Categories views. */
  collapsedCategories: Set<string>
  silentMode: boolean
  compactMode: boolean
  /** Favorite style names persisted in the extension preferences file. */
  favorites: Set<string>
  /** Most recently applied style names (max 10). */
  recentNames: string[]
  /** Usage counters loaded/persisted via backend API. */
  usageCounts: Record<string, number>
  /** User-defined top-level family order for All Sources view. */
  categoryOrder: string[]
  /** Saved style presets from backend (`/style_grid/presets` / list API). */
  presets: Record<string, Preset>
  /** Forge LoRAs with organizer-only local categories and sidecar previews. */
  loras: Lora[]
  /** Current positive prompt reported by the active Forge tab. */
  hostPrompt: string
  
  // Actions
  setStyles: (styles: Style[], tab: Tab) => void
  applyUiPreferences: (preferences: UiPreferences) => void
  setSearch: (q: string) => void
  setCategory: (cat: string | null) => void
  selectStyleCategory: (cat: string | null) => void
  selectStyleTag: (tag: string | null) => void
  selectPresetCategory: (cat: string | null) => void
  selectLoraCategory: (cat: string | null) => void
  toggleStyleMultiSelect: () => void
  toggleStyleTagMultiSelect: () => void
  togglePresetMultiSelect: () => void
  toggleLoraMultiSelect: () => void
  togglePresetBatchSelect: () => void
  toggleLoraBatchSelect: () => void
  togglePresetBatchItem: (name: string) => void
  toggleLoraBatchItem: (id: string) => void
  clearPresetBatchSelection: () => void
  clearLoraBatchSelection: () => void
  toggleStyleWildcardSelect: () => void
  toggleWildcardStyle: (name: string) => void
  clearStyleWildcardSelection: () => void
  finishStyleWildcardSelection: () => void
  setActiveSource: (src: string | null) => void
  toggleSilent: () => void
  toggleCompact: () => void
  toggleCollapse: (cat: string) => void
  collapseAll: () => void
  expandAll: () => void
  selectAllInCategory: (cat: string) => void
  toggleStyle: (style: Style) => void
  setSelectedStyles: (styles: Style[]) => void
  clearAll: () => void
  showToast: (message: string, variant?: 'success' | 'error' | 'info') => void
  loadUsage: () => Promise<void>
  incrementUsage: (name: string) => void
  setCategoryOrder: (order: string[]) => void
  toggleFavorite: (name: string) => void
  isFavorite: (name: string) => boolean
  addToRecent: (name: string) => void
  fetchPresets: () => Promise<void>
  fetchLoras: () => Promise<void>
  
  // Derived
  categories: () => string[]
  styleTags: () => string[]
}

export function selectFilteredStyles(
  styles: Style[],
  search: string,
  activeCategory: string | null,
  activeSource: string | null,
  favorites: Set<string>,
  recentNames: string[],
  presets: Record<string, Preset>,
  activeStyleCategories: string[] = [],
  activeStyleTags: string[] = [],
): Style[] {
  const term = search.trim().toLowerCase()
  let available = styles.filter(s =>
    (!activeSource || s.source_file === activeSource) &&
    (!term || `${s.name} ${s.description || ''} ${s.category || ''} ${(s.organizer_tags || []).join(' ')}`.toLowerCase().includes(term))
  )
  if (!activeSource) available = dedupeStylesByNameForAllSources(available)
  available = available.filter(style => {
    const tags = Array.isArray(style.organizer_tags) ? style.organizer_tags : []
    return activeStyleTags.every(selectedTag =>
      tags.some(tag => tag.toLowerCase() === selectedTag.toLowerCase())
    )
  })

  if (activeCategory === '★ Favorites') {
    return available.filter(s => favorites.has(s.name))
  }

  if (activeCategory === '🕑 Recent') {
    return recentNames
      .map(name => available.find(s => s.name === name))
      .filter(Boolean) as Style[]
  }

  if (activeCategory === 'presets') {
    const order: string[] = []
    const seen = new Set<string>()
    for (const key of Object.keys(presets).sort()) {
      for (const n of presets[key]?.styles ?? []) {
        if (!seen.has(n)) {
          seen.add(n)
          order.push(n)
        }
      }
    }
    return order
      .map(name => styles.find(s => s.name === name))
      .filter(Boolean) as Style[]
  }

  const selectedCategories = activeStyleCategories.length
    ? activeStyleCategories
    : activeCategory ? [activeCategory] : []
  return available.filter(s =>
    selectedCategories.length === 0 ||
    selectedCategories.some(category => categoryMatches(s.category, category))
  )
}

export const useStylesStore = create<StylesStore>((set, get) => ({
  toasts: [],
  styles: [],
  tab: 'txt2img',
  search: '',
  activeCategory: null,
  activeStyleCategories: [],
  activeStyleTags: [],
  activePresetCategories: [],
  activeLoraCategories: [],
  styleMultiSelect: cachedUiPreferences.style_multi_select,
  styleTagMultiSelect: cachedUiPreferences.style_tag_multi_select,
  presetMultiSelect: cachedUiPreferences.preset_multi_select,
  loraMultiSelect: cachedUiPreferences.lora_multi_select,
  presetBatchSelect: false,
  loraBatchSelect: false,
  selectedPresetNames: [],
  selectedLoraIds: [],
  styleWildcardSelect: false,
  selectedWildcardStyleNames: [],
  activeSource: null,
  sources: [],
  selectedStyles: [],
  usageCounts: {},
  categoryOrder: cachedUiPreferences.category_order,
  collapsedCategories: new Set(),
  silentMode: false,
  compactMode: cachedUiPreferences.compact_mode,
  favorites: new Set(cachedUiPreferences.favorites),
  recentNames: cachedUiPreferences.recent_names,
  presets: {},
  loras: [],
  hostPrompt: '',

  setStyles: (styles, tab) => {
    const sources = [...new Set(
      styles.map(s => s.source_file).filter(Boolean)
    )].sort()

    // Restore selection: exact match can fail when host path strings differ from LS (basename must match)
    const lastSource = localStorage.getItem('sg_v2_last_source')
    const prevActive = get().activeSource
    const activeSource =
      resolveSourceInList(sources, prevActive) ??
      resolveSourceInList(sources, lastSource)

    const availableCategories = new Set(styles.map(style => getTopLevelCategory(style.category)))
    const availableTags = new Set(styles.flatMap(style => style.organizer_tags || []))
    set((state) => {
      const activeStyleCategories = state.activeStyleCategories.filter(category => availableCategories.has(category))
      const activeStyleTags = state.activeStyleTags.filter(tag => availableTags.has(tag))
      return {
        styles,
        tab,
        sources,
        activeSource,
        activeCategory: state.activeStyleCategories.length
          ? activeStyleCategories[0] ?? null
          : state.activeCategory,
        activeStyleCategories,
        activeStyleTags,
        selectedWildcardStyleNames: activeSource !== state.activeSource
          ? []
          : state.selectedWildcardStyleNames,
      }
    })
    if (activeSource) {
      localStorage.setItem('sg_v2_last_source', activeSource)
      sendToHost({ type: 'SG_SOURCE_CHANGE', source: activeSource })
    }
  },
  applyUiPreferences: (preferences) => {
    const current = get()
    const activeSource = current.sources.length
      ? resolveSourceInList(current.sources, preferences.active_source)
      : current.activeSource
    set({
      compactMode: preferences.compact_mode,
      favorites: new Set(preferences.favorites),
      recentNames: preferences.recent_names,
      categoryOrder: preferences.category_order,
      styleMultiSelect: preferences.style_multi_select,
      styleTagMultiSelect: preferences.style_tag_multi_select,
      presetMultiSelect: preferences.preset_multi_select,
      loraMultiSelect: preferences.lora_multi_select,
      activeSource,
      selectedWildcardStyleNames: activeSource !== current.activeSource
        ? []
        : current.selectedWildcardStyleNames,
      activeStyleCategories: preferences.style_multi_select
        ? current.activeStyleCategories
        : current.activeStyleCategories.slice(0, 1),
      activeStyleTags: preferences.style_tag_multi_select
        ? current.activeStyleTags
        : current.activeStyleTags.slice(0, 1),
      activePresetCategories: preferences.preset_multi_select
        ? current.activePresetCategories
        : current.activePresetCategories.slice(0, 1),
      activeLoraCategories: preferences.lora_multi_select
        ? current.activeLoraCategories
        : current.activeLoraCategories.slice(0, 1),
    })
    if (current.sources.length && activeSource !== current.activeSource) {
      sendToHost({ type: 'SG_SOURCE_CHANGE', source: activeSource })
    }
  },
  setSearch: (search) => set({ search }),
  setCategory: (activeCategory) => set((state) => ({
    activeCategory,
    activeStyleCategories: activeCategory && activeCategory !== 'presets' && activeCategory !== 'loras' &&
      activeCategory !== '\u2605 Favorites' && activeCategory !== '\u{1F551} Recent'
      ? [activeCategory]
      : [],
    activeStyleTags: activeCategory === null || activeCategory === 'presets' || activeCategory === 'loras'
      ? []
      : state.activeStyleTags,
    activePresetCategories: activeCategory === 'presets' ? state.activePresetCategories : [],
    activeLoraCategories: activeCategory === 'loras' ? state.activeLoraCategories : [],
    presetBatchSelect: activeCategory === 'presets' ? state.presetBatchSelect : false,
    loraBatchSelect: activeCategory === 'loras' ? state.loraBatchSelect : false,
    selectedPresetNames: activeCategory === 'presets' ? state.selectedPresetNames : [],
    selectedLoraIds: activeCategory === 'loras' ? state.selectedLoraIds : [],
    styleWildcardSelect: activeCategory === 'presets' || activeCategory === 'loras'
      ? false
      : state.styleWildcardSelect,
    selectedWildcardStyleNames: activeCategory === 'presets' || activeCategory === 'loras'
      ? []
      : state.selectedWildcardStyleNames,
  })),
  selectStyleCategory: (category) => set((state) => {
    if (!category) return { activeCategory: null, activeStyleCategories: [] }
    if (!state.styleMultiSelect) {
      const alreadySelected = state.activeStyleCategories.length === 1 && state.activeStyleCategories[0] === category
      return {
        activeCategory: alreadySelected ? null : category,
        activeStyleCategories: alreadySelected ? [] : [category],
      }
    }
    const selected = state.activeStyleCategories.includes(category)
      ? state.activeStyleCategories.filter(item => item !== category)
      : [...state.activeStyleCategories, category]
    return {
      activeCategory: selected[0] ?? null,
      activeStyleCategories: selected,
    }
  }),
  selectStyleTag: (tag) => set((state) => {
    if (!tag) return { activeStyleTags: [] }
    if (!state.styleTagMultiSelect) {
      const alreadySelected = state.activeStyleTags.length === 1 && state.activeStyleTags[0] === tag
      return { activeStyleTags: alreadySelected ? [] : [tag] }
    }
    const selected = state.activeStyleTags.includes(tag)
      ? state.activeStyleTags.filter(item => item !== tag)
      : [...state.activeStyleTags, tag]
    return { activeStyleTags: selected }
  }),
  selectPresetCategory: (category) => set((state) => {
    if (!category) return { activePresetCategories: [] }
    if (!state.presetMultiSelect) {
      const alreadySelected = state.activePresetCategories.length === 1 && state.activePresetCategories[0] === category
      return { activePresetCategories: alreadySelected ? [] : [category] }
    }
    const selected = state.activePresetCategories.includes(category)
      ? state.activePresetCategories.filter(item => item !== category)
      : [...state.activePresetCategories, category]
    return { activePresetCategories: selected }
  }),
  selectLoraCategory: (category) => set((state) => {
    if (!category) return { activeLoraCategories: [] }
    if (!state.loraMultiSelect) {
      const alreadySelected = state.activeLoraCategories.length === 1 && state.activeLoraCategories[0] === category
      return { activeLoraCategories: alreadySelected ? [] : [category] }
    }
    const selected = state.activeLoraCategories.includes(category)
      ? state.activeLoraCategories.filter(item => item !== category)
      : [...state.activeLoraCategories, category]
    return { activeLoraCategories: selected }
  }),
  toggleStyleMultiSelect: () => set((state) => {
    const styleMultiSelect = !state.styleMultiSelect
    saveUiPreferences({ style_multi_select: styleMultiSelect })
    const activeStyleCategories = styleMultiSelect
      ? state.activeStyleCategories
      : state.activeStyleCategories.slice(0, 1)
    return {
      styleMultiSelect,
      activeCategory: activeStyleCategories[0] ?? null,
      activeStyleCategories,
    }
  }),
  toggleStyleTagMultiSelect: () => set((state) => {
    const styleTagMultiSelect = !state.styleTagMultiSelect
    saveUiPreferences({ style_tag_multi_select: styleTagMultiSelect })
    return {
      styleTagMultiSelect,
      activeStyleTags: styleTagMultiSelect
        ? state.activeStyleTags
        : state.activeStyleTags.slice(0, 1),
    }
  }),
  togglePresetMultiSelect: () => set((state) => {
    const presetMultiSelect = !state.presetMultiSelect
    saveUiPreferences({ preset_multi_select: presetMultiSelect })
    return {
      presetMultiSelect,
      activePresetCategories: presetMultiSelect
        ? state.activePresetCategories
        : state.activePresetCategories.slice(0, 1),
    }
  }),
  toggleLoraMultiSelect: () => set((state) => {
    const loraMultiSelect = !state.loraMultiSelect
    saveUiPreferences({ lora_multi_select: loraMultiSelect })
    return {
      loraMultiSelect,
      activeLoraCategories: loraMultiSelect
        ? state.activeLoraCategories
        : state.activeLoraCategories.slice(0, 1),
    }
  }),
  togglePresetBatchSelect: () => set((state) => ({
    presetBatchSelect: !state.presetBatchSelect,
    selectedPresetNames: state.presetBatchSelect ? [] : state.selectedPresetNames,
  })),
  toggleLoraBatchSelect: () => set((state) => ({
    loraBatchSelect: !state.loraBatchSelect,
    selectedLoraIds: state.loraBatchSelect ? [] : state.selectedLoraIds,
  })),
  togglePresetBatchItem: (name) => set((state) => ({
    selectedPresetNames: state.selectedPresetNames.includes(name)
      ? state.selectedPresetNames.filter(item => item !== name)
      : [...state.selectedPresetNames, name],
  })),
  toggleLoraBatchItem: (id) => set((state) => ({
    selectedLoraIds: state.selectedLoraIds.includes(id)
      ? state.selectedLoraIds.filter(item => item !== id)
      : [...state.selectedLoraIds, id],
  })),
  clearPresetBatchSelection: () => set({ selectedPresetNames: [] }),
  clearLoraBatchSelection: () => set({ selectedLoraIds: [] }),
  toggleStyleWildcardSelect: () => set((state) => ({
    styleWildcardSelect: !state.styleWildcardSelect,
    selectedWildcardStyleNames: state.styleWildcardSelect ? [] : state.selectedWildcardStyleNames,
  })),
  toggleWildcardStyle: (name) => set((state) => ({
    selectedWildcardStyleNames: state.selectedWildcardStyleNames.includes(name)
      ? state.selectedWildcardStyleNames.filter(item => item !== name)
      : [...state.selectedWildcardStyleNames, name],
  })),
  clearStyleWildcardSelection: () => set({ selectedWildcardStyleNames: [] }),
  finishStyleWildcardSelection: () => set({
    styleWildcardSelect: false,
    selectedWildcardStyleNames: [],
  }),
  setActiveSource: (activeSource) => {
    saveUiPreferences({ active_source: activeSource })
    set({ activeSource, selectedWildcardStyleNames: [] })
    sendToHost({ type: 'SG_SOURCE_CHANGE', source: activeSource })
  },
  toggleSilent: () => {
    const newVal = !get().silentMode
    if (!newVal) {
      set({ silentMode: newVal, selectedStyles: [] })
    } else {
      set({ silentMode: newVal })
    }
    window.parent.postMessage(
      { type: 'SG_TOGGLE_SILENT', tab: 'txt2img', value: newVal },
      '*'
    )
    window.parent.postMessage(
      { type: 'SG_TOGGLE_SILENT', tab: 'img2img', value: newVal },
      '*'
    )
  },
  toggleCompact: () => set((s) => {
    const compactMode = !s.compactMode
    saveUiPreferences({ compact_mode: compactMode })
    return { compactMode }
  }),
  toggleCollapse: (cat) => set((s) => {
    const next = new Set(s.collapsedCategories)
    if (next.has(cat)) next.delete(cat)
    else next.add(cat)
    return { collapsedCategories: next }
  }),
  collapseAll: () => {
    const { styles, activeSource } = get()
    const src = activeSource
      ? styles.filter(s => s.source_file === activeSource)
      : dedupeStylesByNameForAllSources(styles)
    const cats = [...new Set(src.map(s => s.category).filter(Boolean))]
    set({ collapsedCategories: new Set(cats) })
  },
  expandAll: () => set({ collapsedCategories: new Set() }),
  selectAllInCategory: (cat) => {
    const {
      styles, activeSource, selectedStyles, silentMode,
      styleWildcardSelect, selectedWildcardStyleNames,
    } = get()
    const src = activeSource
      ? styles.filter(s => s.source_file === activeSource)
      : dedupeStylesByNameForAllSources(styles)
    const catStyles = src.filter(s => categoryMatches(s.category, cat))
    if (styleWildcardSelect) {
      const categoryNames = [...new Set(catStyles.map(style => style.name))]
      const allSelected = categoryNames.every(name => selectedWildcardStyleNames.includes(name))
      if (allSelected) {
        const removeNames = new Set(categoryNames)
        set({
          selectedWildcardStyleNames: selectedWildcardStyleNames.filter(name => !removeNames.has(name)),
        })
      } else {
        const selectedNames = new Set(selectedWildcardStyleNames)
        categoryNames.forEach(name => selectedNames.add(name))
        set({ selectedWildcardStyleNames: [...selectedNames] })
      }
      return
    }
    if (!silentMode) {
      catStyles.forEach((style) => {
        get().addToRecent(style.name)
        get().incrementUsage(style.name)
        sendToHost({
          type: 'SG_APPLY',
          styleId: style.name,
          prompt: style.prompt,
          neg: style.negative_prompt,
          silent: false,
        })
      })
      return
    }
    const allSelected = catStyles.every(s =>
      selectedStyles.some(sel => sel.name === s.name)
    )

    if (allSelected) {
      const removeNames = new Set(catStyles.map(s => s.name))
      set({
        selectedStyles: selectedStyles.filter(s => !removeNames.has(s.name)),
      })
      catStyles.forEach((style) => {
        sendToHost({ type: 'SG_UNAPPLY', styleId: style.name })
      })
      return
    }

    const selectedNames = new Set(selectedStyles.map(s => s.name))
    const toAdd = catStyles.filter(s => !selectedNames.has(s.name))
    if (toAdd.length === 0) return

    set({ selectedStyles: [...selectedStyles, ...toAdd] })
    toAdd.forEach((style) => {
      get().addToRecent(style.name)
      sendToHost({
        type: 'SG_APPLY',
        styleId: style.name,
        prompt: style.prompt,
        neg: style.negative_prompt,
        silent: silentMode,
      })
    })
  },
  toggleFavorite: (name) => {
    const favs = new Set(get().favorites)
    if (favs.has(name)) favs.delete(name)
    else favs.add(name)
    saveUiPreferences({ favorites: [...favs] })
    set({ favorites: favs })
  },
  isFavorite: (name) => get().favorites.has(name),
  addToRecent: (name) => {
    const recent = [name, ...get().recentNames.filter(n => n !== name)]
      .slice(0, 10)
    saveUiPreferences({ recent_names: recent })
    set({ recentNames: recent })
  },

  toggleStyle: (style) => {
    const { selectedStyles, silentMode } = get()
    const isSelected = selectedStyles.some(s => s.name === style.name)

    if (!silentMode) {
      if (isSelected) {
        set({ selectedStyles: selectedStyles.filter(s => s.name !== style.name) })
      }
      get().addToRecent(style.name)
      get().incrementUsage(style.name)
      sendToHost({
        type: 'SG_APPLY',
        styleId: style.name,
        prompt: style.prompt,
        neg: style.negative_prompt,
        silent: false,
      })
      return
    }

    if (isSelected) {
      set({ selectedStyles: selectedStyles.filter(s => s.name !== style.name) })
      sendToHost({ type: 'SG_UNAPPLY', styleId: style.name })
    } else {
      set({ selectedStyles: [...selectedStyles, style] })
      get().addToRecent(style.name)
      get().incrementUsage(style.name)
      sendToHost({ 
        type: 'SG_APPLY', 
        styleId: style.name,
        prompt: style.prompt,
        neg: style.negative_prompt,
        silent: true,
      })
    }
  },
  setSelectedStyles: (styles: Style[]) => set({ selectedStyles: styles }),
  clearAll: () => {
    const { selectedStyles } = get()
    selectedStyles.forEach(s =>
      sendToHost({ type: 'SG_UNAPPLY', styleId: s.name })
    )
    set({ selectedStyles: [] })
  },
  showToast: (message, variant = 'info') => {
    const id = Date.now()
    set((s) => ({ toasts: [...s.toasts, { id, message, variant }] }))
    setTimeout(() => set((s) => ({
      toasts: s.toasts.filter(t => t.id !== id)
    })), 3000)
  },
  loadUsage: async () => {
    try {
      const r = await fetch('/style_grid/usage')
      const data = await r.json()
      set({ usageCounts: data || {} })
    } catch {
      // ignore usage load errors
    }
  },
  incrementUsage: (name: string) => {
    const counts = { ...get().usageCounts }
    counts[name] = (counts[name] || 0) + 1
    set({ usageCounts: counts })
    // Persist to backend
    fetch('/style_grid/usage/increment', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name })
    }).catch(() => {})
  },
  fetchPresets: async () => {
    const parse = (raw: unknown): Record<string, Preset> =>
      raw && typeof raw === 'object' && !Array.isArray(raw)
        ? raw as Record<string, Preset>
        : {}
    const applyPresets = (presets: Record<string, Preset>) => set((state) => {
      const availableCategories = new Set<string>()
      Object.values(presets).forEach((preset) => {
        const categories = getPresetCategories(preset)
        if (categories.length === 0) availableCategories.add('Uncategorized')
        categories.forEach(category => availableCategories.add(category))
      })
      return {
        presets,
        activePresetCategories: state.activePresetCategories.filter(category => availableCategories.has(category)),
        selectedPresetNames: state.selectedPresetNames.filter(name => Object.prototype.hasOwnProperty.call(presets, name)),
      }
    })
    try {
      let r = await fetch('/style_grid/presets/list')
      if (!r.ok) {
        r = await fetch('/style_grid/presets')
      }
      if (!r.ok) return
      const data = parse(await r.json())
      applyPresets(data)
    } catch {
      try {
        const r = await fetch('/style_grid/presets')
        if (!r.ok) return
        const data = parse(await r.json())
        applyPresets(data)
      } catch {
        // ignore
      }
    }
  },
  fetchLoras: async () => {
    try {
      const response = await fetch('/style_grid/loras')
      if (!response.ok) return
      const data = await response.json() as { loras?: unknown }
      const loras = Array.isArray(data.loras) ? data.loras as Lora[] : []
      set((state) => {
        const availableCategories = new Set<string>()
        loras.forEach((lora) => {
          const categories = Array.isArray(lora.categories) ? lora.categories : []
          if (categories.length === 0) availableCategories.add('Uncategorized')
          categories.forEach(category => availableCategories.add(category))
        })
        return {
          loras,
          activeLoraCategories: state.activeLoraCategories.filter(category => availableCategories.has(category)),
          selectedLoraIds: state.selectedLoraIds.filter(id => loras.some(lora => lora.id === id)),
        }
      })
    } catch {
      // Forge may still be starting or refreshing its model paths.
    }
  },
  setCategoryOrder: (order: string[]) => {
    saveUiPreferences({ category_order: order })
    set({ categoryOrder: order })
  },

  categories: () => {
    const { styles, activeSource, categoryOrder } = get()
    const filtered = activeSource
      ? styles.filter(s => s.source_file === activeSource)
      : styles
    const all = [...new Set(
      filtered.map(s => getTopLevelCategory(s.category)).filter(Boolean)
    )]

    // When specific source selected — always alphabetical
    // Saved category order only applies to All Sources view
    if (activeSource) {
      return all.sort()
    }

    // Only use saved order if it was saved for All Sources context
    // (contains most of the current categories)
    const allSorted = all.sort()
    if (categoryOrder.length === 0) return allSorted

    // Migrate any previously saved child-category order to one entry per family.
    const savedFamilies = [...new Set(categoryOrder.map(getTopLevelCategory))]
    const relevantOrder = savedFamilies.filter(c => all.includes(c))
    const coverage = relevantOrder.length / all.length

    // If saved order covers less than 80% of current categories — ignore it
    if (coverage < 0.8) return allSorted

    const rest = all.filter(c => !relevantOrder.includes(c)).sort()
    return [...relevantOrder, ...rest]
  },

  styleTags: () => {
    const { styles, activeSource } = get()
    const filtered = activeSource
      ? styles.filter(style => style.source_file === activeSource)
      : dedupeStylesByNameForAllSources(styles)
    return [...new Set(filtered.flatMap(style => style.organizer_tags || []))]
      .filter(Boolean)
      .sort((a, b) => a.localeCompare(b))
  }
}))
