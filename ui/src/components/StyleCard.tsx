import { memo, useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { motion } from 'framer-motion'
import { Check, Heart } from 'lucide-react'
import type { Style } from '../bridge'
import { useStylesStore } from '../store/stylesStore'
import { sendToHost } from '../bridge'
import { ThumbnailPreview } from './ThumbnailPreview'

interface Props {
  style: Style
  windowed?: boolean
  /** When set, card acts as a saved preset: click loads preset; no selection/thumbnail menu behavior. */
  presetName?: string
  /** User-defined preset groups shown in the preset library. */
  presetCategories?: string[]
}

const Portal = ({ children }: { children: React.ReactNode }) =>
  createPortal(children, document.body)

export const StyleCard = memo(function StyleCard({ style, presetName, presetCategories = [] }: Props) {
  const {
    selectedStyles, toggleStyle, isFavorite, toggleFavorite, styles, activeSource, silentMode,
    presetBatchSelect, selectedPresetNames, togglePresetBatchItem,
    styleWildcardSelect, selectedWildcardStyleNames, toggleWildcardStyle,
  } = useStylesStore()
  const [menuPos, setMenuPos] = useState<{ x: number, y: number } | null>(null)
  const [pickerPos, setPickerPos] = useState<{ x: number, y: number } | null>(null)
  const isStyleSelected = !presetName && silentMode && selectedStyles.some(s => s.name === style.name)
  const isWildcardSelected = !presetName && selectedWildcardStyleNames.includes(style.name)
  const isPresetBatchSelected = Boolean(presetName && selectedPresetNames.includes(presetName))
  const fav = isFavorite(style.name)
  const duplicates = styles.filter(s => s.name === style.name)
  const hasMultipleSources = duplicates.length > 1
  const sourceLabels = duplicates.map((dup) =>
    ((dup.source_file || 'Unknown').split(/[\\/]/).pop() || 'Unknown')
      .replace(/\.csv$/i, '')
  )
  const maxSourceLabelLen = sourceLabels.reduce((max, label) => Math.max(max, label.length), 0)
  const pickerWidthCh = Math.min(48, Math.max(18, maxSourceLabelLen + 4))

  const displayName = style.name.includes('_')
    ? style.name.split('_').slice(1).join(' ')
    : style.name
  const activateCard = (target: HTMLElement) => {
    if (presetName) {
      if (presetBatchSelect) {
        togglePresetBatchItem(presetName)
        return
      }
      sendToHost({ type: 'SG_LOAD_PRESET', name: presetName })
      return
    }
    if (styleWildcardSelect) {
      toggleWildcardStyle(style.name)
      return
    }
    if (hasMultipleSources && !activeSource && !isStyleSelected) {
      const rect = target.getBoundingClientRect()
      const left = Math.min(rect.right + 8, window.innerWidth - 280)
      const top = Math.max(8, rect.top)
      setPickerPos({ x: left, y: top })
      return
    }
    toggleStyle(style)
  }

  useEffect(() => {
    if (!menuPos) return
    const blockNativeContextMenu = (e: MouseEvent) => {
      e.preventDefault()
      e.stopPropagation()
    }
    const blockRightMouseDown = (e: MouseEvent) => {
      if (e.button === 2) {
        e.preventDefault()
        e.stopPropagation()
      }
    }

    window.addEventListener('contextmenu', blockNativeContextMenu, true)
    document.addEventListener('contextmenu', blockNativeContextMenu, true)
    window.addEventListener('mousedown', blockRightMouseDown, true)
    document.addEventListener('mousedown', blockRightMouseDown, true)

    return () => {
      window.removeEventListener('contextmenu', blockNativeContextMenu, true)
      document.removeEventListener('contextmenu', blockNativeContextMenu, true)
      window.removeEventListener('mousedown', blockRightMouseDown, true)
      document.removeEventListener('mousedown', blockRightMouseDown, true)
    }
  }, [menuPos])

  return (
    <>
      <motion.div
          data-sg-card="true"
          title={presetName ? style.description || undefined : style.name}
          initial={{ opacity: 0, scale: 0.95 }}
          animate={{ opacity: 1, scale: 1 }}
          exit={{ opacity: 0, scale: 0.95 }}
          transition={{ duration: 0.1 }}
          whileHover={{ scale: 1.02 }}
          whileTap={{ scale: 0.98 }}
          onContextMenu={(e) => {
            e.preventDefault()
            e.stopPropagation()
            setMenuPos({ x: e.clientX, y: e.clientY })
          }}
          role="button"
          tabIndex={0}
          aria-label={style.name}
          aria-pressed={presetName
            ? (presetBatchSelect ? isPresetBatchSelected : undefined)
            : (styleWildcardSelect ? isWildcardSelected : (silentMode ? isStyleSelected : undefined))}
          onClick={e => activateCard(e.currentTarget)}
          onKeyDown={e => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault()
              activateCard(e.currentTarget)
            }
          }}
          className={`sg-style-card ${presetName ? 'sg-preset-card' : ''}`}
        >
          <ThumbnailPreview style={style} presetName={presetName} />
          <div className="sg-card-label">
            <span>{displayName}</span>
            {presetName && (
              <small className="sg-card-category-count">
                {presetCategories.length} {presetCategories.length === 1 ? 'category' : 'categories'}
              </small>
            )}
            {!presetName && style.organizer_tags?.length > 0 && (
              <small className="sg-card-category-count">
                {style.organizer_tags.length} {style.organizer_tags.length === 1 ? 'tag' : 'tags'}
              </small>
            )}
          </div>
          {presetName && presetBatchSelect && isPresetBatchSelected && <span className="sg-card-badge sg-card-selected"><Check size={15} /></span>}
          {!presetName && styleWildcardSelect && isWildcardSelected && <span className="sg-card-badge sg-card-selected"><Check size={15} /></span>}
          {!presetName && !styleWildcardSelect && silentMode && isStyleSelected && <span className="sg-card-badge sg-card-selected"><Check size={15} /></span>}
          {!presetName && fav && <span className="sg-card-badge sg-card-favorite"><Heart size={13} fill="currentColor" /></span>}
      </motion.div>

      {menuPos && (
        <Portal>
          <div
            className="fixed z-[9999] bg-sg-surface border border-sg-border rounded-lg shadow-xl py-1 min-w-48"
            style={{ left: menuPos.x, top: menuPos.y }}
            onMouseLeave={() => setMenuPos(null)}
            onContextMenu={(e) => e.preventDefault()}
          >
            {presetName ? (<>
              <button
                className="w-full text-left px-3 py-1.5 text-sm text-sg-text hover:bg-sg-accent/20 transition-colors"
                onClick={() => { sendToHost({ type: 'SG_LOAD_PRESET', name: presetName }); setMenuPos(null) }}
              >
                Load preset
              </button>
              <div className="h-px my-1 bg-sg-border" />
              <button
                className="w-full text-left px-3 py-1.5 text-sm text-sg-text hover:bg-sg-accent/20 transition-colors"
                onClick={() => { navigator.clipboard.writeText(style.prompt); setMenuPos(null) }}
              >
                Copy prompt
              </button>
              <button
                className="w-full text-left px-3 py-1.5 text-sm text-sg-text hover:bg-sg-accent/20 transition-colors"
                onClick={() => { sendToHost({ type: 'SG_REPLACE_PRESET_PROMPTS', name: presetName }); setMenuPos(null) }}
              >
                Replace from prompt box…
              </button>
              <button
                className="w-full text-left px-3 py-1.5 text-sm text-sg-text hover:bg-sg-accent/20 transition-colors"
                onClick={() => { sendToHost({ type: 'SG_RENAME_PRESET', name: presetName }); setMenuPos(null) }}
              >
                Rename preset…
              </button>
              <button
                className="w-full text-left px-3 py-1.5 text-sm text-sg-text hover:bg-sg-accent/20 transition-colors"
                onClick={() => { sendToHost({ type: 'SG_DUPLICATE_PRESET', name: presetName }); setMenuPos(null) }}
              >
                Duplicate
              </button>
              <button
                className="w-full text-left px-3 py-1.5 text-sm text-sg-text hover:bg-sg-accent/20 transition-colors"
                onClick={() => { sendToHost({ type: 'SG_EXPORT_PRESET_ITEM', name: presetName, source: activeSource || undefined }); setMenuPos(null) }}
              >
                Export...
              </button>
              <button
                className="w-full text-left px-3 py-1.5 text-sm text-sg-text hover:bg-sg-accent/20 transition-colors"
                onClick={() => {
                  sendToHost({
                    type: 'SG_EDIT_PRESET_CATEGORIES',
                    name: presetName,
                    categories: presetCategories,
                  })
                  setMenuPos(null)
                }}
              >
                Edit categories…
              </button>
              <div className="h-px my-1 bg-sg-border" />
              <button
                className="w-full text-left px-3 py-1.5 text-sm text-sg-text hover:bg-sg-accent/20 transition-colors"
                onClick={() => { sendToHost({ type: 'SG_UPLOAD_PREVIEW', styleId: presetName, preset: true }); setMenuPos(null) }}
              >
                Assign image…
              </button>
              <div className="h-px my-1 bg-sg-border" />
              <button
                className="w-full text-left px-3 py-1.5 text-sm text-red-400 hover:bg-red-500/20 transition-colors"
                onClick={() => { sendToHost({ type: 'SG_DELETE_PRESET', name: presetName }); setMenuPos(null) }}
              >
                Delete
              </button>
            </>) : <>
            <button
              className="w-full text-left px-3 py-1.5 text-sm text-sg-text hover:bg-sg-accent/20 transition-colors"
              onClick={() => {
                if (styleWildcardSelect) toggleWildcardStyle(style.name)
                else toggleStyle(style)
                setMenuPos(null)
              }}
            >
              {styleWildcardSelect
                ? (isWildcardSelected ? 'Remove from batch selection' : 'Add to batch selection')
                : (silentMode ? (isStyleSelected ? '✕ Deselect' : '✓ Select') : '＋ Add to prompt')}
            </button>
            <button
              className="w-full text-left px-3 py-1.5 text-sm text-sg-text hover:bg-sg-accent/20 transition-colors"
              onClick={() => { toggleFavorite(style.name); setMenuPos(null) }}
            >
              {fav ? '★ Remove from Favorites' : '☆ Add to Favorites'}
            </button>
            <button
              className="w-full text-left px-3 py-1.5 text-sm text-sg-text hover:bg-sg-accent/20 transition-colors"
              onClick={() => {
                sendToHost({
                  type: 'SG_BATCH_EDIT_STYLE_TAGS',
                  styles: [{
                    name: style.name,
                    source: style.source_file,
                    organizer_tags: style.organizer_tags || [],
                  }],
                })
                setMenuPos(null)
              }}
            >
              Edit tags...
            </button>
            <div className="h-px my-1 bg-sg-border" />
            <button
              className="w-full text-left px-3 py-1.5 text-sm text-sg-text hover:bg-sg-accent/20 transition-colors"
              onClick={() => { navigator.clipboard.writeText(style.prompt); setMenuPos(null) }}
            >
              📋 Copy prompt
            </button>
            <button
              className="w-full text-left px-3 py-1.5 text-sm text-sg-text hover:bg-sg-accent/20 transition-colors"
              onClick={() => { sendToHost({ type: 'SG_EDIT_STYLE', styleId: style.name }); setMenuPos(null) }}
            >
              ✏️ Edit
            </button>
            <button
              className="w-full text-left px-3 py-1.5 text-sm text-sg-text hover:bg-sg-accent/20 transition-colors"
              onClick={() => {
                sendToHost({
                  type: 'SG_REPLACE_STYLE_PROMPTS',
                  styleId: style.name,
                  source: style.source_file || undefined,
                })
                setMenuPos(null)
              }}
            >
              Replace from prompt box…
            </button>
            <button
              className="w-full text-left px-3 py-1.5 text-sm text-sg-text hover:bg-sg-accent/20 transition-colors"
              onClick={() => { sendToHost({ type: 'SG_DUPLICATE_STYLE', styleId: style.name }); setMenuPos(null) }}
            >
              📄 Duplicate
            </button>
            <button
              className="w-full text-left px-3 py-1.5 text-sm text-sg-text hover:bg-sg-accent/20 transition-colors"
              onClick={() => { sendToHost({ type: 'SG_EXPORT_STYLE_ITEM', styleId: style.name, source: style.source_file || undefined }); setMenuPos(null) }}
            >
              Export...
            </button>
            <button
              className="w-full text-left px-3 py-1.5 text-sm text-sg-text hover:bg-sg-accent/20 transition-colors"
              onClick={() => { sendToHost({ type: 'SG_MOVE_TO_CATEGORY', styleId: style.name }); setMenuPos(null) }}
            >
              📂 Move to category...
            </button>
            <div className="h-px my-1 bg-sg-border" />
            <button
              className="w-full text-left px-3 py-1.5 text-sm text-sg-text hover:bg-sg-accent/20 transition-colors"
              onClick={() => { sendToHost({ type: 'SG_GENERATE_PREVIEW', styleId: style.name }); setMenuPos(null) }}
            >
              🎨 Generate preview (SD)
            </button>
            <button
              className="w-full text-left px-3 py-1.5 text-sm text-sg-text hover:bg-sg-accent/20 transition-colors"
              onClick={() => { sendToHost({ type: 'SG_UPLOAD_PREVIEW', styleId: style.name }); setMenuPos(null) }}
            >
              🖼️ Upload preview image
            </button>
            <div className="h-px my-1 bg-sg-border" />
            <button
              className="w-full text-left px-3 py-1.5 text-sm text-red-400 hover:bg-red-500/20 transition-colors"
              onClick={() => { sendToHost({ type: 'SG_DELETE_STYLE', styleId: style.name }); setMenuPos(null) }}
            >
              🗑️ Delete
            </button>
            </>}
          </div>
          <div
            className="fixed inset-0 z-[9998]"
            onClick={() => setMenuPos(null)}
            onContextMenu={(e) => e.preventDefault()}
          />
        </Portal>
      )}

      {pickerPos && (
        <Portal>
          <div
            className="fixed z-[10005] bg-sg-surface border border-sg-border rounded-lg shadow-xl py-1"
            onClick={(e) => e.stopPropagation()}
            onMouseDown={(e) => e.stopPropagation()}
            style={{
              left: pickerPos.x,
              top: pickerPos.y,
              width: `${pickerWidthCh}ch`,
              minWidth: '18ch',
              maxWidth: '48ch',
            }}
          >
            {duplicates.map((dup, idx) => {
              const sourceLabel = sourceLabels[idx] || 'Unknown'
              return (
                <button
                  key={`${dup.source_file || 'unknown'}-${idx}`}
                  className="w-full text-left px-3 py-1.5 text-sm text-sg-text hover:bg-sg-accent/20 transition-colors"
                  onMouseDown={(e) => {
                    e.preventDefault()
                    e.stopPropagation()
                    toggleStyle(dup)
                    setPickerPos(null)
                  }}
                >
                  <div className="font-medium truncate">{sourceLabel}</div>
                </button>
              )
            })}
          </div>
          <div
            className="fixed inset-0 z-[10004]"
            onMouseDown={() => setPickerPos(null)}
          />
        </Portal>
      )}
    </>
  )
})
