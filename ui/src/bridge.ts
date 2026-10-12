/** Messages sent from Forge host script to the React iframe. */
export type HostMessage =
  | { type: 'SG_CLEAR_SELECTION' }
  | { type: 'SG_INIT';           tab: Tab; styles: Style[] }
  | { type: 'SG_HOST_TAB';       tab: Tab }
  | { type: 'SG_STYLES_UPDATE';  styles: Style[] }
  | { type: 'SG_TOAST'; message: string; variant: 'success' | 'error' | 'info' }
  | { type: 'SG_STYLE_APPLIED'; style: Style }
  | { type: 'SG_THUMB_DONE';     styleId: string; version: number; preset?: boolean; imageData?: string }
  | { type: 'SG_THUMB_PROGRESS'; status: string; styleId: string; progress?: number }
  | { type: 'SG_PROMPT_CHANGED'; prompt: string; neg: string }
  | { type: 'SG_TEMP_WILDCARD_CREATED'; token: string; count: number }
  | { type: 'SG_STYLE_CATEGORIES_UPDATED' }
  | { type: 'SG_CLOSE' }
  | { type: 'SG_PRESETS_UPDATED' }
  | { type: 'SG_LORAS_UPDATED'; clearSelection?: boolean }

/** Messages sent from the React iframe back to Forge host script. */
export type FrameMessage =
  | { type: 'SG_READY' }
  | { type: 'SG_APPLY';         styleId: string; prompt: string; neg: string; silent?: boolean }
  | { type: 'SG_UNAPPLY';       styleId: string }
  | { type: 'SG_EDIT_STYLE';      styleId: string }
  | { type: 'SG_REPLACE_STYLE_PROMPTS'; styleId: string; source?: string }
  | { type: 'SG_DUPLICATE_STYLE'; styleId: string }
  | { type: 'SG_MOVE_TO_CATEGORY'; styleId: string }
  | { type: 'SG_BATCH_EDIT_STYLE_CATEGORIES'; styles: { name: string; source: string; category: string }[] }
  | { type: 'SG_BATCH_EDIT_STYLE_TAGS'; styles: { name: string; source: string; organizer_tags: string[] }[] }
  | { type: 'SG_RENAME_STYLE_CATEGORY'; category: string; scope: 'exact' | 'family' }
  | { type: 'SG_RENAME_STYLE_TAG'; tag: string }
  | { type: 'SG_GENERATE_PREVIEW'; styleId: string }
  | { type: 'SG_UPLOAD_PREVIEW';   styleId: string; preset?: boolean }
  | { type: 'SG_WILDCARD_CATEGORY'; category: string }
  | { type: 'SG_CREATE_TEMP_WILDCARD'; styleNames: string[] }
  | { type: 'SG_GENERATE_CATEGORY_PREVIEWS'; category: string; missingCount: number; source?: string }
  | { type: 'SG_REORDER_STYLES'; styleIds: string[] }
  | { type: 'SG_DELETE_STYLE';  styleId: string }
  | { type: 'SG_CLOSE_REQUEST' }
  | { type: 'SG_RANDOM' }
  | { type: 'SG_PRESETS' }
  | { type: 'SG_LOAD_PRESET'; name: string }
  | { type: 'SG_EDIT_PRESET_CATEGORIES'; name: string; categories: string[] }
  | { type: 'SG_BATCH_EDIT_PRESET_CATEGORIES'; names: string[] }
  | { type: 'SG_RENAME_PRESET_CATEGORY'; category: string }
  | { type: 'SG_RENAME_PRESET'; name: string }
  | { type: 'SG_REPLACE_PRESET_PROMPTS'; name: string }
  | { type: 'SG_DUPLICATE_PRESET'; name: string }
  | { type: 'SG_DELETE_PRESET'; name: string }
  | { type: 'SG_APPLY_LORA'; id: string; name: string; token: string; prompt: string; negativePrompt: string }
  | { type: 'SG_EDIT_LORA_METADATA'; name: string }
  | { type: 'SG_RENAME_LORA'; id: string; name: string }
  | { type: 'SG_BATCH_EDIT_LORA_CATEGORIES'; ids: string[] }
  | { type: 'SG_RENAME_LORA_CATEGORY'; category: string }
  | { type: 'SG_BACKUP' }
  | { type: 'SG_OPEN_LORA_FOLDER' }
  | { type: 'SG_IMPORT_EXPORT' }
  | { type: 'SG_NEW_STYLE'; sourceFile?: string }
  | { type: 'SG_CSV_EDITOR' }
  | { type: 'SG_CLEAR_ALL' }
  | { type: 'SG_SOURCE_CHANGE'; source: string | null }
  | { type: 'SG_TOGGLE_SILENT'; tab: Tab; value: boolean }

// ── Shared types ──────────────────────────────────────────────
export type Tab = 'txt2img' | 'img2img'

export interface Preset {
  styles: string[]
  created: string
  /** Exact positive prompt text, inserted by templates or restored by scenes. */
  prompt?: string
  /** Exact negative prompt restored with a saved scene. */
  negative_prompt?: string
  /** Scene presets replace both prompt boxes; unset legacy templates still insert. */
  mode?: 'scene'
  description?: string
  pinned?: boolean
  /** User-defined groups such as Model, Subject, Krea, or Z-Image. */
  categories?: string[]
  /** Legacy single-category value retained for compatibility. */
  category?: string
}

export interface Lora {
  id: string
  name: string
  token: string
  prompt: string
  activation_text: string
  negative_prompt: string
  preferred_weight: number
  effective_weight: number
  relative_path: string
  root: string
  categories: string[]
  has_preview: boolean
  preview_version: number
}

export interface Style {
  name:              string
  prompt:            string
  negative_prompt:   string
  description:       string
  category:          string
  organizer_tags:    string[]
  source_file:       string
  has_thumbnail:     boolean
}

/** Posts one typed bridge message to the Forge host window. */
export function sendToHost(msg: FrameMessage): void {
  window.parent.postMessage(msg, '*')
}

/**
 * Subscribes to host postMessage events and returns an unsubscribe cleanup.
 */
export function onHostMessage(
  handler: (msg: HostMessage) => void
): () => void {
  const listener = (e: MessageEvent) => {
    if (e.data && typeof e.data.type === 'string') handler(e.data)
  }
  window.addEventListener('message', listener)
  return () => window.removeEventListener('message', listener)
}
