export interface UiPreferences {
  compact_mode: boolean
  group_by_category: boolean
  favorites: string[]
  recent_names: string[]
  active_source: string | null
  category_order: string[]
  style_multi_select: boolean
  style_tag_multi_select: boolean
  preset_multi_select: boolean
  lora_multi_select: boolean
}

interface PreferencesResponse {
  initialized: boolean
  preferences: UiPreferences
}

export const PREFERENCE_STORAGE_KEYS = {
  compactMode: 'sg_v2_compact_mode',
  groupByCategory: 'sg_v2_group_categories',
  favorites: 'sg_v2_favorites',
  recentNames: 'sg_v2_recent',
  activeSource: 'sg_v2_last_source',
  categoryOrder: 'sg_v2_category_order',
  categoryOrderSource: 'sg_v2_category_order_source',
  styleMultiSelect: 'sg_v2_style_multi_select',
  styleTagMultiSelect: 'sg_v2_style_tag_multi_select',
  presetMultiSelect: 'sg_v2_preset_multi_select',
  loraMultiSelect: 'sg_v2_lora_multi_select',
} as const

const preferenceStorageKeySet = new Set<string>(Object.values(PREFERENCE_STORAGE_KEYS))

const DEFAULT_UI_PREFERENCES: UiPreferences = {
  compact_mode: false,
  group_by_category: false,
  favorites: [],
  recent_names: [],
  active_source: null,
  category_order: [],
  style_multi_select: false,
  style_tag_multi_select: false,
  preset_multi_select: false,
  lora_multi_select: false,
}

function readBoolean(key: string): boolean {
  return localStorage.getItem(key) === 'true'
}

function readStringArray(key: string): string[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(key) || '[]')
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : []
  } catch {
    return []
  }
}

function normalizePreferences(value: unknown): UiPreferences {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { ...DEFAULT_UI_PREFERENCES }
  }
  const raw = value as Partial<UiPreferences>
  return {
    compact_mode: typeof raw.compact_mode === 'boolean' ? raw.compact_mode : false,
    group_by_category: typeof raw.group_by_category === 'boolean' ? raw.group_by_category : false,
    favorites: Array.isArray(raw.favorites)
      ? raw.favorites.filter((item): item is string => typeof item === 'string')
      : [],
    recent_names: Array.isArray(raw.recent_names)
      ? raw.recent_names.filter((item): item is string => typeof item === 'string').slice(0, 10)
      : [],
    active_source: typeof raw.active_source === 'string' ? raw.active_source : null,
    category_order: Array.isArray(raw.category_order)
      ? raw.category_order.filter((item): item is string => typeof item === 'string')
      : [],
    style_multi_select: typeof raw.style_multi_select === 'boolean'
      ? raw.style_multi_select
      : false,
    style_tag_multi_select: typeof raw.style_tag_multi_select === 'boolean'
      ? raw.style_tag_multi_select
      : false,
    preset_multi_select: typeof raw.preset_multi_select === 'boolean'
      ? raw.preset_multi_select
      : false,
    lora_multi_select: typeof raw.lora_multi_select === 'boolean'
      ? raw.lora_multi_select
      : false,
  }
}

/** Read the browser copy used for instant rendering and first-run migration. */
export function readCachedUiPreferences(): UiPreferences {
  return {
    compact_mode: readBoolean(PREFERENCE_STORAGE_KEYS.compactMode),
    group_by_category: readBoolean(PREFERENCE_STORAGE_KEYS.groupByCategory),
    favorites: readStringArray(PREFERENCE_STORAGE_KEYS.favorites),
    recent_names: readStringArray(PREFERENCE_STORAGE_KEYS.recentNames).slice(0, 10),
    active_source: localStorage.getItem(PREFERENCE_STORAGE_KEYS.activeSource),
    category_order: readStringArray(PREFERENCE_STORAGE_KEYS.categoryOrder),
    style_multi_select: readBoolean(PREFERENCE_STORAGE_KEYS.styleMultiSelect),
    style_tag_multi_select: readBoolean(PREFERENCE_STORAGE_KEYS.styleTagMultiSelect),
    preset_multi_select: readBoolean(PREFERENCE_STORAGE_KEYS.presetMultiSelect),
    lora_multi_select: readBoolean(PREFERENCE_STORAGE_KEYS.loraMultiSelect),
  }
}

/** Keep a browser cache so both Forge iframes update immediately. */
export function cacheUiPreferences(preferences: UiPreferences): void {
  localStorage.setItem(PREFERENCE_STORAGE_KEYS.compactMode, String(preferences.compact_mode))
  localStorage.setItem(PREFERENCE_STORAGE_KEYS.groupByCategory, String(preferences.group_by_category))
  localStorage.setItem(PREFERENCE_STORAGE_KEYS.favorites, JSON.stringify(preferences.favorites))
  localStorage.setItem(PREFERENCE_STORAGE_KEYS.recentNames, JSON.stringify(preferences.recent_names))
  localStorage.setItem(PREFERENCE_STORAGE_KEYS.categoryOrder, JSON.stringify(preferences.category_order))
  localStorage.setItem(PREFERENCE_STORAGE_KEYS.categoryOrderSource, 'all')
  localStorage.setItem(PREFERENCE_STORAGE_KEYS.styleMultiSelect, String(preferences.style_multi_select))
  localStorage.setItem(PREFERENCE_STORAGE_KEYS.styleTagMultiSelect, String(preferences.style_tag_multi_select))
  localStorage.setItem(PREFERENCE_STORAGE_KEYS.presetMultiSelect, String(preferences.preset_multi_select))
  localStorage.setItem(PREFERENCE_STORAGE_KEYS.loraMultiSelect, String(preferences.lora_multi_select))
  if (preferences.active_source) {
    localStorage.setItem(PREFERENCE_STORAGE_KEYS.activeSource, preferences.active_source)
  } else {
    localStorage.removeItem(PREFERENCE_STORAGE_KEYS.activeSource)
  }
}

export function isPreferenceStorageKey(key: string | null): boolean {
  return key === null || preferenceStorageKeySet.has(key)
}

async function postPreferences(patch: Partial<UiPreferences>): Promise<UiPreferences> {
  const response = await fetch('/style_grid/preferences', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
    keepalive: true,
  })
  if (!response.ok) throw new Error(`Preference save failed: HTTP ${response.status}`)
  const data = await response.json() as { preferences?: unknown }
  return normalizePreferences(data.preferences)
}

/** Load the extension file, migrating existing browser values on first use. */
export async function fetchUiPreferences(): Promise<UiPreferences> {
  const response = await fetch('/style_grid/preferences')
  if (!response.ok) throw new Error(`Preference load failed: HTTP ${response.status}`)
  const data = await response.json() as Partial<PreferencesResponse>
  const preferences = data.initialized
    ? normalizePreferences(data.preferences)
    : await postPreferences(readCachedUiPreferences())
  cacheUiPreferences(preferences)
  return preferences
}

let preferenceSaveQueue: Promise<unknown> = Promise.resolve()

/** Cache immediately, then serialize patches so rapid interactions cannot overwrite newer state. */
export function saveUiPreferences(patch: Partial<UiPreferences>): void {
  cacheUiPreferences(normalizePreferences({ ...readCachedUiPreferences(), ...patch }))
  preferenceSaveQueue = preferenceSaveQueue
    .catch(() => undefined)
    .then(() => postPreferences(patch))
    .catch(() => undefined)
}
