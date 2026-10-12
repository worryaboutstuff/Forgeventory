import { useMemo, useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { useShallow } from 'zustand/react/shallow'
import { sendToHost, type Style } from '../bridge'
import {
  getCategoryColor,
  getPresetCategories,
  selectFilteredStyles,
  styleRowKey,
  useStylesStore,
} from '../store/stylesStore'
import { StyleCard } from './StyleCard'
import { LoraCard } from './LoraCard'

function matchesAllCategories(categories: string[], selectedCategories: string[]): boolean {
  return selectedCategories.every(category =>
    category === 'Uncategorized'
      ? categories.length === 0
      : categories.includes(category)
  )
}

export function StyleGrid({ windowed = false, grouped = false }: { windowed?: boolean; grouped?: boolean }) {
  const {
    styles, search, activeCategory, activeStyleCategories, activeStyleTags, activePresetCategories, activeLoraCategories, activeSource,
    favorites, recentNames, presets, loras,
    compactMode, silentMode, collapsedCategories, toggleCollapse,
    selectedStyles, selectAllInCategory, styleWildcardSelect, selectedWildcardStyleNames,
  } = useStylesStore(
    useShallow(s => ({
      styles: s.styles,
      search: s.search,
      activeCategory: s.activeCategory,
      activeStyleCategories: s.activeStyleCategories,
      activeStyleTags: s.activeStyleTags,
      activePresetCategories: s.activePresetCategories,
      activeLoraCategories: s.activeLoraCategories,
      activeSource: s.activeSource,
      favorites: s.favorites,
      recentNames: s.recentNames,
      presets: s.presets,
      loras: s.loras,
      compactMode: s.compactMode,
      silentMode: s.silentMode,
      collapsedCategories: s.collapsedCategories,
      toggleCollapse: s.toggleCollapse,
      selectedStyles: s.selectedStyles,
      selectAllInCategory: s.selectAllInCategory,
      styleWildcardSelect: s.styleWildcardSelect,
      selectedWildcardStyleNames: s.selectedWildcardStyleNames,
    }))
  )
  const [catMenu, setCatMenu] = useState<{
    x: number
    y: number
    cat: string
    missingCount: number
  } | null>(null)

  const filtered = useMemo(
    () => selectFilteredStyles(
      styles,
      search,
      activeCategory,
      activeSource,
      favorites,
      recentNames,
      presets,
      activeStyleCategories,
      activeStyleTags,
    ),
    [styles, search, activeCategory, activeSource, favorites, recentNames, presets, activeStyleCategories, activeStyleTags]
  )

  if (activeCategory === 'loras') {
    const term = search.trim().toLowerCase()
    const filteredLoras = loras.filter(lora => {
      const categories = Array.isArray(lora.categories) ? lora.categories : []
      const matchesCategory = matchesAllCategories(categories, activeLoraCategories)
      if (!matchesCategory) return false
      const searchable = `${lora.name} ${lora.relative_path} ${lora.root} ${categories.join(' ')}`
      return !term || searchable.toLowerCase().includes(term)
    })

    if (loras.length === 0) {
      return (
        <div className="flex flex-col items-center justify-center gap-2 px-4 py-16 text-center">
          <p className="text-sg-muted text-sm">No LoRAs found</p>
          <p className="max-w-sm text-sg-muted/70 text-xs leading-relaxed">
            Add model files to a configured Forge LoRA folder, then reopen this view.
          </p>
        </div>
      )
    }

    if (filteredLoras.length === 0) {
      return <div className="flex items-center justify-center h-32 text-sg-muted text-sm">No LoRAs match the current filters</div>
    }

    return (
      <div className={`sg-card-grid ${compactMode ? 'sg-compact-cards' : ''}`}>
        {filteredLoras.map(lora => <LoraCard key={lora.id} lora={lora} />)}
      </div>
    )
  }

  if (activeCategory === 'presets') {
    const allPresetNames = Object.keys(presets)
    if (allPresetNames.length === 0) {
      return (
        <div className="flex flex-col items-center justify-center gap-2 px-4 py-16 text-center">
          <p className="text-sg-muted text-sm">No presets saved yet</p>
          <p className="max-w-sm text-sg-muted/70 text-xs leading-relaxed">
            Open <span className="text-sg-text/90">Manage Presets</span> in the toolbar, then use{' '}
            <span className="text-sg-text/90">Save scene</span> in the Style Presets dialog.
          </p>
        </div>
      )
    }

    const term = search.trim().toLowerCase()
    const presetNames = allPresetNames
      .filter(name => {
        const preset = presets[name]
        const categories = getPresetCategories(preset)
        const matchesPresetCategory = matchesAllCategories(categories, activePresetCategories)
        if (!matchesPresetCategory) return false
        const searchableText = `${name} ${categories.join(' ') || 'Uncategorized'} ${preset.description || ''}`
        return !term || searchableText.toLowerCase().includes(term)
      })
      .sort((a, b) => {
        const pinOrder = Number(presets[b].pinned === true) - Number(presets[a].pinned === true)
        if (pinOrder) return pinOrder
        const dateOrder = String(presets[b].created || '').localeCompare(String(presets[a].created || ''))
        return dateOrder || a.localeCompare(b)
      })

    if (presetNames.length === 0) {
      return (
        <div className="flex items-center justify-center h-32 text-sg-muted text-sm">
          No presets match the current filters
        </div>
      )
    }

    return (
      <div className={`sg-card-grid ${compactMode ? 'sg-compact-cards' : ''}`}>
        {presetNames.map((name) => {
          const preset = presets[name]
          const categories = getPresetCategories(preset)
          const style: Style = {
            name,
            prompt: preset.prompt || '',
            negative_prompt: '',
            description: preset.description || '',
            category: categories.join(', ') || 'Uncategorized',
            organizer_tags: [],
            source_file: '',
            has_thumbnail: false,
          }
          return (
            <StyleCard
              key={`preset:${name}`}
              style={style}
              windowed={windowed}
              presetName={name}
              presetCategories={categories}
            />
          )
        })}
      </div>
    )
  }

  if (filtered.length === 0) {
    return (
      <div className="flex items-center justify-center h-32 text-sg-muted text-sm">
        No styles found
      </div>
    )
  }

  // Default to a continuous grid; category grouping remains an optional view.
  if (!grouped) {
    return (
      <div className={`sg-card-grid ${compactMode ? 'sg-compact-cards' : ''}`} style={{ contentVisibility: 'auto' }}>
        {filtered.map(style => (
          <StyleCard key={styleRowKey(style)} style={style} windowed={windowed} />
        ))}
      </div>
    )
  }

  // Group filtered results by their full child categories.
  const groups = filtered.reduce((acc, style) => {
    const cat = style.category || 'OTHER'
    if (!acc[cat]) acc[cat] = []
    acc[cat].push(style)
    return acc
  }, {} as Record<string, typeof filtered>)

  const sortedGroups = Object.entries(groups).sort(([a], [b]) =>
    a.localeCompare(b)
  )

  return (
    <div className="space-y-4">
      {sortedGroups.map(([cat, catStyles]) => {
        const isCollapsed = collapsedCategories.has(cat)
        const color = getCategoryColor(cat)
        const allSelected = styleWildcardSelect
          ? catStyles.every(style => selectedWildcardStyleNames.includes(style.name))
          : silentMode && catStyles.every(style => selectedStyles.some(sel => sel.name === style.name))

        return (
          <div key={cat}>
            {/* Category header */}
            <div
              className="flex items-center gap-2 mb-2 sticky top-0 bg-sg-bg/95 backdrop-blur-sm py-1 z-10 cursor-pointer hover:bg-sg-surface/30 rounded-md transition-colors -mx-1 px-1"
              title="Right-click for options"
              onClick={() => toggleCollapse(cat)}
              onContextMenu={(e) => {
                e.preventDefault()
                e.stopPropagation()
                const missing = catStyles.filter(s =>
                  !localStorage.getItem(`sg_thumb_v_${s.name}`)
                ).length
                setCatMenu({ x: e.clientX, y: e.clientY, cat, missingCount: missing })
              }}
            >
              <span className="text-sg-muted">
                {isCollapsed ? '▶' : '▼'}
              </span>
              <span className="sg-category-dot" style={{ backgroundColor: color }} />
              <span
                className="text-xs font-bold tracking-wider uppercase"
                style={{ color: '#dce3ee' }}
              >
                {cat}
              </span>
              <span className="text-xs text-sg-muted/60">
                ({catStyles.length})
              </span>
              <div className="flex-1" />
              <button
                onClick={e => { e.stopPropagation(); selectAllInCategory(cat) }}
                className="text-xs text-sg-muted hover:text-sg-accent transition-colors px-2 py-0.5 rounded hover:bg-sg-accent/10"
              >
                {styleWildcardSelect
                  ? (allSelected ? 'Remove All' : 'Select All')
                  : silentMode ? (allSelected ? 'Deselect All' : 'Select All') : 'Add All'}
              </button>
            </div>

            {/* Cards */}
            <AnimatePresence>
              {!isCollapsed && (
                <motion.div
                  initial={{ height: 0, opacity: 0 }}
                  animate={{ height: 'auto', opacity: 1 }}
                  exit={{ height: 0, opacity: 0 }}
                  transition={{ duration: 0.15 }}
                  className="overflow-hidden"
                >
                  <div className={`sg-card-grid ${compactMode ? 'sg-compact-cards' : ''}`} style={{ contentVisibility: 'auto' }}>
                    {catStyles.map(style => (
                      <StyleCard key={styleRowKey(style)} style={style} windowed={windowed} />
                    ))}
                  </div>
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        )
      })}
      {catMenu && (
        <>
          <div
            className="fixed inset-0 z-[9998]"
            onClick={() => setCatMenu(null)}
          />
          <div
            className="fixed z-[9999] bg-[#0f172a] border border-sg-border rounded-lg shadow-xl py-1 min-w-52"
            style={{ left: catMenu.x, top: catMenu.y }}
          >
            <button
              className="w-full text-left px-3 py-1.5 text-sm text-white hover:bg-sg-accent/20 transition-colors"
              onClick={() => {
                sendToHost({
                  type: 'SG_RENAME_STYLE_CATEGORY',
                  category: catMenu.cat,
                  scope: 'exact'
                })
                setCatMenu(null)
              }}
            >
              Rename category...
            </button>
            <button
              className="w-full text-left px-3 py-1.5 text-sm text-white hover:bg-sg-accent/20 transition-colors"
              onClick={() => {
                sendToHost({
                  type: 'SG_WILDCARD_CATEGORY',
                  category: catMenu.cat
                })
                setCatMenu(null)
              }}
            >
              🎲 Add category as wildcard
            </button>
            {catMenu.missingCount > 0 && (
              <button
                className="w-full text-left px-3 py-1.5 text-sm text-white hover:bg-sg-accent/20 transition-colors"
                onClick={() => {
                  const rawSrc =
                    useStylesStore.getState().activeSource ??
                    (typeof localStorage !== 'undefined' ? localStorage.getItem('sg_v2_last_source') : null)
                  sendToHost({
                    type: 'SG_GENERATE_CATEGORY_PREVIEWS',
                    category: catMenu.cat,
                    missingCount: catMenu.missingCount,
                    ...(rawSrc ? { source: rawSrc } : {}),
                  })
                  setCatMenu(null)
                }}
              >
                🎨 Generate previews ({catMenu.missingCount} missing)
              </button>
            )}
          </div>
        </>
      )}
    </div>
  )
}
