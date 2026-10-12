import { memo, useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { motion } from 'framer-motion'
import { Boxes, Check } from 'lucide-react'
import type { Lora } from '../bridge'
import { sendToHost } from '../bridge'
import { useStylesStore } from '../store/stylesStore'

const Portal = ({ children }: { children: React.ReactNode }) =>
  createPortal(children, document.body)

function promptHasLora(prompt: string, name: string): boolean {
  const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`<lora:\\s*${escapedName}\\s*:[^>\\r\\n]*>`, 'i').test(prompt)
}

export const LoraCard = memo(function LoraCard({ lora }: { lora: Lora }) {
  const { loraBatchSelect, selectedLoraIds, toggleLoraBatchItem, hostPrompt } = useStylesStore()
  const [menuPos, setMenuPos] = useState<{ x: number, y: number } | null>(null)
  const [imageLoaded, setImageLoaded] = useState(false)
  const isBatchSelected = selectedLoraIds.includes(lora.id)
  const isApplied = promptHasLora(hostPrompt, lora.name)
  const renameDisabled = selectedLoraIds.length > 1
  const tagCount = Array.isArray(lora.categories) ? lora.categories.length : 0
  const previewUrl = `/style_grid/lora-preview?id=${encodeURIComponent(lora.id)}&v=${lora.preview_version || 0}`

  const addToPrompt = () => sendToHost({
    type: 'SG_APPLY_LORA',
    id: lora.id,
    name: lora.name,
    token: lora.token,
    prompt: lora.prompt,
    negativePrompt: lora.negative_prompt,
  })
  const activate = () => {
    if (loraBatchSelect) {
      toggleLoraBatchItem(lora.id)
      return
    }
    addToPrompt()
  }

  useEffect(() => {
    if (!menuPos) return
    const blockContextMenu = (event: MouseEvent) => {
      event.preventDefault()
      event.stopPropagation()
    }
    window.addEventListener('contextmenu', blockContextMenu, true)
    return () => window.removeEventListener('contextmenu', blockContextMenu, true)
  }, [menuPos])

  return (
    <>
      <motion.div
        data-sg-card="true"
        title={`${lora.name}\n${lora.relative_path}`}
        initial={{ opacity: 0, scale: 0.95 }}
        animate={{ opacity: 1, scale: 1 }}
        exit={{ opacity: 0, scale: 0.95 }}
        transition={{ duration: 0.1 }}
        whileHover={{ scale: 1.02 }}
        whileTap={{ scale: 0.98 }}
        onContextMenu={(event) => {
          event.preventDefault()
          event.stopPropagation()
          setMenuPos({
            x: Math.min(event.clientX, window.innerWidth - 230),
            y: Math.min(event.clientY, window.innerHeight - 180),
          })
        }}
        role="button"
        tabIndex={0}
        aria-label={loraBatchSelect
          ? `Select LoRA ${lora.name}`
          : `${isApplied ? 'Remove' : 'Add'} LoRA ${lora.name}`}
        aria-pressed={loraBatchSelect ? isBatchSelected : isApplied}
        onClick={activate}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault()
            activate()
          }
        }}
        className={`sg-style-card sg-lora-card ${isApplied ? 'sg-lora-applied' : ''}`}
      >
        <div className="sg-card-preview">
          <div className="absolute inset-0 flex flex-col gap-2 items-center justify-center text-xs text-sg-muted">
            <Boxes size={34} strokeWidth={1.2} aria-hidden="true" />
            <span>No sidecar</span>
          </div>
          {lora.has_preview && (
            <img
              src={previewUrl}
              alt={`${lora.name} preview`}
              loading="lazy"
              className={`absolute inset-0 h-full w-full object-cover transition-opacity ${
                imageLoaded ? 'opacity-100' : 'opacity-0'
              }`}
              onLoad={() => setImageLoaded(true)}
              onError={() => setImageLoaded(false)}
            />
          )}
        </div>
        <div className="sg-card-label">
          <span>{lora.name}</span>
          <small className="sg-card-category-count">{tagCount} {tagCount === 1 ? 'tag' : 'tags'}</small>
        </div>
        {isApplied && !loraBatchSelect && <span className="sg-lora-active-dot" aria-hidden="true" />}
        {loraBatchSelect && isBatchSelected && <span className="sg-card-badge sg-card-selected"><Check size={15} /></span>}
      </motion.div>

      {menuPos && (
        <Portal>
          <div
            className="fixed z-[9999] bg-sg-surface border border-sg-border rounded-lg shadow-xl py-1 min-w-52"
            style={{ left: menuPos.x, top: menuPos.y }}
            onContextMenu={(event) => event.preventDefault()}
          >
            <button className="sg-menu-item w-full text-sg-text" onClick={() => { addToPrompt(); setMenuPos(null) }}>
              {isApplied ? 'Remove from prompt' : 'Add to prompt'}
            </button>
            <button
              className="sg-menu-item w-full text-sg-text"
              onClick={() => {
                sendToHost({ type: 'SG_EDIT_LORA_METADATA', name: lora.name })
                setMenuPos(null)
              }}
            >
              Edit Forge metadata…
            </button>
            <button
              className="sg-menu-item w-full text-sg-text"
              disabled={renameDisabled}
              title={renameDisabled ? 'Rename is unavailable while multiple LoRAs are selected.' : undefined}
              onClick={() => {
                if (renameDisabled) return
                sendToHost({ type: 'SG_RENAME_LORA', id: lora.id, name: lora.name })
                setMenuPos(null)
              }}
            >
              Rename LoRA…
            </button>
            <button
              className="sg-menu-item w-full text-sg-text"
              onClick={() => {
                sendToHost({
                  type: 'SG_BATCH_EDIT_LORA_CATEGORIES',
                  ids: [lora.id],
                })
                setMenuPos(null)
              }}
            >
              Edit tags…
            </button>
            <div className="sg-menu-separator" />
            <button
              className="sg-menu-item w-full text-sg-text"
              onClick={() => { void navigator.clipboard.writeText(lora.token); setMenuPos(null) }}
            >
              Copy LoRA token
            </button>
          </div>
          <div
            className="fixed inset-0 z-[9998]"
            onClick={() => setMenuPos(null)}
            onContextMenu={(event) => { event.preventDefault(); setMenuPos(null) }}
          />
        </Portal>
      )}
    </>
  )
})
