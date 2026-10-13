import { useState, type ReactNode } from 'react'
import { DropdownMenu } from 'radix-ui'
import {
  Archive, ArrowDownUp, BookMarked, Check, Columns3, Dice5, Ellipsis,
  Eye, FolderDown, Github, Maximize2, Minimize2, Plus, RefreshCw, Settings2, Trash2, Upload, X,
} from 'lucide-react'
import { sendToHost } from '../bridge'
import { useStylesStore } from '../store/stylesStore'
import { SearchBar } from './SearchBar'
import { SourceFilter } from './SourceFilter'
import { PixelBagIcon } from './PixelBagIcon'

const PUBLIC_REPOSITORY_URL = 'https://github.com/worryaboutstuff/Forgeventory'

export interface LibraryViewProps {
  grouped: boolean
  setGrouped: (value: boolean) => void
  isFullscreen: boolean
  toggleFullscreen: () => void
}

export function LibraryMenu({ children, grouped, setGrouped, isFullscreen, toggleFullscreen }: LibraryViewProps & { children: ReactNode }) {
  const { compactMode, toggleCompact, silentMode, toggleSilent, collapsedCategories, collapseAll, expandAll } = useStylesStore()
  const [loraReloading, setLoraReloading] = useState(false)

  const reloadLoras = async () => {
    if (loraReloading) return
    setLoraReloading(true)
    try {
      const response = await fetch('/style_grid/loras/refresh', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      })
      const result = await response.json() as { ok?: boolean; count?: number; error?: string }
      if (!response.ok || result.error || result.ok === false) {
        throw new Error(result.error || `HTTP ${response.status}`)
      }
      await useStylesStore.getState().fetchLoras()
      useStylesStore.getState().showToast(`Reloaded ${result.count ?? 0} LoRAs`, 'success')
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      useStylesStore.getState().showToast(`LoRA reload failed: ${message}`, 'error')
    } finally {
      setLoraReloading(false)
    }
  }

  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>{children}</DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content className="sg-library-menu" sideOffset={8} collisionPadding={12}>
          <DropdownMenu.Label className="sg-menu-label">Display</DropdownMenu.Label>
          <DropdownMenu.CheckboxItem className="sg-menu-item" checked={compactMode} onCheckedChange={toggleCompact}>
            <Columns3 size={16} /> Compact cards
            <DropdownMenu.ItemIndicator className="sg-menu-check"><Check size={15} /></DropdownMenu.ItemIndicator>
          </DropdownMenu.CheckboxItem>
          <DropdownMenu.CheckboxItem className="sg-menu-item" checked={grouped} onCheckedChange={setGrouped}>
            <Settings2 size={16} /> Group by category
            <DropdownMenu.ItemIndicator className="sg-menu-check"><Check size={15} /></DropdownMenu.ItemIndicator>
          </DropdownMenu.CheckboxItem>
          {grouped && <DropdownMenu.Item className="sg-menu-item" onSelect={() => collapsedCategories.size ? expandAll() : collapseAll()}>
            <ArrowDownUp size={16} /> {collapsedCategories.size ? 'Expand categories' : 'Collapse categories'}
          </DropdownMenu.Item>}
          <DropdownMenu.Item className="sg-menu-item" onSelect={toggleFullscreen}>
            {isFullscreen ? <Minimize2 size={16} /> : <Maximize2 size={16} />}
            {isFullscreen ? 'Exit fullscreen' : 'Fullscreen'}
          </DropdownMenu.Item>
          <DropdownMenu.Separator className="sg-menu-separator" />
          <DropdownMenu.Label className="sg-menu-label">Library tools</DropdownMenu.Label>
          <DropdownMenu.Item className="sg-menu-item" disabled={loraReloading} onSelect={() => { void reloadLoras() }}>
            <RefreshCw size={16} className={loraReloading ? 'sg-spin' : undefined} />
            {loraReloading ? 'Refreshing LoRAs…' : 'Refresh LoRA library'}
          </DropdownMenu.Item>
          <DropdownMenu.Item className="sg-menu-item" onSelect={() => sendToHost({ type: 'SG_BACKUP' })}><Archive size={16} /> Back up CSV</DropdownMenu.Item>
          <DropdownMenu.Item className="sg-menu-item" onSelect={() => sendToHost({ type: 'SG_OPEN_LORA_FOLDER' })}><FolderDown size={16} /> Open LoRA folder</DropdownMenu.Item>
          <DropdownMenu.Item className="sg-menu-item" onSelect={() => sendToHost({ type: 'SG_IMPORT_SHARED_ITEM' })}><Upload size={16} /> Import shared item...</DropdownMenu.Item>
          <DropdownMenu.Item className="sg-menu-item" onSelect={() => sendToHost({ type: 'SG_IMPORT_EXPORT' })}><FolderDown size={16} /> Full library import / export</DropdownMenu.Item>
          <DropdownMenu.CheckboxItem className="sg-menu-item" checked={silentMode} onCheckedChange={toggleSilent}>
            <Eye size={16} /> Silent mode
            <DropdownMenu.ItemIndicator className="sg-menu-check"><Check size={15} /></DropdownMenu.ItemIndicator>
          </DropdownMenu.CheckboxItem>
          <DropdownMenu.Item className="sg-menu-item" onSelect={() => {
            useStylesStore.getState().clearAll()
            sendToHost({ type: 'SG_CLEAR_ALL' })
          }}><Trash2 size={16} /> Clear selection</DropdownMenu.Item>
          <DropdownMenu.Separator className="sg-menu-separator" />
          <DropdownMenu.Item asChild>
            <a className="sg-menu-item" href={PUBLIC_REPOSITORY_URL} target="_blank" rel="noopener noreferrer">
              <Github size={16} /> Forgeventory on GitHub
            </a>
          </DropdownMenu.Item>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  )
}

export function LibraryToolbar(props: LibraryViewProps) {
  const { tab, silentMode } = useStylesStore()
  return (
    <header className="sg-library-toolbar">
      <div className="sg-library-brand" title={`Forgeventory · ${tab}${silentMode ? ' · Silent mode' : ''}`}>
        <PixelBagIcon size={24} /><span>Forgeventory</span>
        {silentMode && <Eye size={14} aria-label="Silent mode enabled" />}
      </div>
      <SourceFilter />
      <div className="sg-library-search"><SearchBar /></div>
      <div className="sg-toolbar-actions">
        <button type="button" className="sg-new-style" title="Save current prompt as a style" onClick={() => {
          const { activeSource, showToast } = useStylesStore.getState()
          if (activeSource) sendToHost({ type: 'SG_NEW_STYLE', sourceFile: activeSource })
          else showToast('Select a CSV source before creating a style', 'info')
        }}><Plus size={18} /><span>Save as Style</span></button>
        <button
          type="button"
          className="sg-manage-presets"
          title="Manage presets"
          onClick={() => sendToHost({ type: 'SG_PRESETS' })}
        ><BookMarked size={18} /><span>Manage Presets</span></button>
      </div>
      <button type="button" className="sg-icon-button" title="Random style" aria-label="Random style" onClick={() => sendToHost({ type: 'SG_RANDOM' })}><Dice5 size={18} /></button>
      <LibraryMenu {...props}><button type="button" className="sg-icon-button" title="Library tools" aria-label="Library tools"><Ellipsis size={20} /></button></LibraryMenu>
      <button type="button" className="sg-icon-button sg-close-button" title="Close Forgeventory" aria-label="Close Forgeventory" onClick={() => sendToHost({ type: 'SG_CLOSE_REQUEST' })}><X size={18} /></button>
    </header>
  )
}
