import { useEffect, useState } from 'react'
import { Reorder } from 'framer-motion'
import { BookMarked, Boxes, Clock3, Heart, LayoutGrid, Settings } from 'lucide-react'
import { onHostMessage, sendToHost } from '../bridge'
import { categoryMatches, getCategoryColor, getPresetCategories, selectFilteredStyles, useStylesStore } from '../store/stylesStore'
import { LibraryMenu, type LibraryViewProps } from './LibraryToolbar'

export function Sidebar(viewProps: LibraryViewProps) {
  const {
    activeCategory, activeStyleCategories, activeStyleTags, activePresetCategories, activeLoraCategories,
    styleMultiSelect, styleTagMultiSelect, presetMultiSelect, loraMultiSelect,
    setCategory, selectStyleCategory, selectStyleTag, selectPresetCategory, selectLoraCategory,
    toggleStyleMultiSelect, toggleStyleTagMultiSelect, togglePresetMultiSelect, toggleLoraMultiSelect,
    presetBatchSelect, loraBatchSelect, selectedPresetNames, selectedLoraIds,
    togglePresetBatchSelect, toggleLoraBatchSelect, clearPresetBatchSelection, clearLoraBatchSelection,
    styleWildcardSelect, selectedWildcardStyleNames, toggleStyleWildcardSelect, clearStyleWildcardSelection,
    categories, styleTags, styles, activeSource, favorites, recentNames, presets, loras, setCategoryOrder,
  } = useStylesStore()
  const [catMenu, setCatMenu] = useState<{
    x: number
    y: number
    cat: string
    kind: 'style' | 'styleTag' | 'preset' | 'lora'
  } | null>(null)
  const cats = categories()
  const visible = selectFilteredStyles(styles, '', null, activeSource, favorites, recentNames, presets)
  const isPresetView = activeCategory === 'presets'
  const isLoraView = activeCategory === 'loras'
  const isStyleView = !isPresetView && !isLoraView
  const batchSelect = isStyleView ? styleWildcardSelect : isPresetView ? presetBatchSelect : loraBatchSelect
  const batchCount = isStyleView
    ? selectedWildcardStyleNames.length
    : isPresetView ? selectedPresetNames.length : selectedLoraIds.length
  const selectedStyleRefs = selectedWildcardStyleNames.flatMap(name => {
    const style = visible.find(item => item.name === name)
    return style ? [{
      name: style.name,
      source: style.source_file,
      category: style.category,
      organizer_tags: style.organizer_tags || [],
    }] : []
  })
  const tags = styleTags()
  const styleTagCounts = visible.reduce((counts, style) => {
    const organizerTags = style.organizer_tags || []
    organizerTags.forEach(tag => counts.set(tag, (counts.get(tag) || 0) + 1))
    return counts
  }, new Map<string, number>())
  const presetCategoryCounts = Object.values(presets).reduce((counts, preset) => {
    const assignedCategories = getPresetCategories(preset)
    const visibleCategories = assignedCategories.length ? assignedCategories : ['Uncategorized']
    visibleCategories.forEach(category => {
      counts.set(category, (counts.get(category) || 0) + 1)
    })
    return counts
  }, new Map<string, number>())
  const presetCategories = [...presetCategoryCounts.keys()].sort((a, b) => {
    if (a === 'Uncategorized') return 1
    if (b === 'Uncategorized') return -1
    return a.localeCompare(b)
  })
  const loraCategoryCounts = loras.reduce((counts, lora) => {
    const assignedCategories = Array.isArray(lora.categories) ? lora.categories : []
    const visibleCategories = assignedCategories.length ? assignedCategories : ['Uncategorized']
    visibleCategories.forEach(category => counts.set(category, (counts.get(category) || 0) + 1))
    return counts
  }, new Map<string, number>())
  const loraCategories = [...loraCategoryCounts.keys()].sort((a, b) => {
    if (a === 'Uncategorized') return 1
    if (b === 'Uncategorized') return -1
    return a.localeCompare(b)
  })
  const libraryItems = [
    { id: null, label: 'Styles', icon: LayoutGrid, count: visible.length },
    { id: 'loras', label: 'LoRA', icon: Boxes, count: loras.length },
    { id: 'presets', label: 'Presets', icon: BookMarked, count: Object.keys(presets).length },
    { id: '★ Favorites', label: 'Favorites', icon: Heart, count: visible.filter(s => favorites.has(s.name)).length },
    { id: '🕑 Recent', label: 'Recent', icon: Clock3, count: visible.filter(s => recentNames.includes(s.name)).length },
  ]

  useEffect(() => {
    void useStylesStore.getState().fetchPresets()
    void useStylesStore.getState().fetchLoras()
    return onHostMessage(msg => {
      if (msg.type === 'SG_PRESETS_UPDATED') void useStylesStore.getState().fetchPresets()
      if (msg.type === 'SG_LORAS_UPDATED') void useStylesStore.getState().fetchLoras()
    })
  }, [])

  return (
    <nav className="sg-library-nav" aria-label="Library navigation">
      <div className="sg-nav-heading">Library</div>
      <div className="sg-nav-library-items">
        {libraryItems.map(({ id, label, icon: Icon, count }) => (
          <button key={label} type="button" className="sg-nav-item" aria-current={activeCategory === id ? 'page' : undefined}
            onClick={() => {
              if (id === 'loras' && activeCategory === 'loras') {
                selectLoraCategory(null)
              }
              setCategory(id)
              if (id === 'loras') void useStylesStore.getState().fetchLoras()
            }}>
            <Icon size={18} aria-hidden="true" /><span>{label}</span><span className="sg-nav-count">{count}</span>
          </button>
        ))}
      </div>
      <div className="sg-nav-heading sg-categories-heading">
        <span>{isPresetView ? 'Preset Categories' : isLoraView ? 'LoRA Tags' : 'Categories'}</span>
        <div className="sg-categories-heading-actions">
          <label
            className="sg-multi-select-toggle"
            title={isStyleView ? 'Show styles from any selected category' : 'Require every selected category or tag'}
          >
            <input
              type="checkbox"
              checked={isStyleView ? styleMultiSelect : isPresetView ? presetMultiSelect : loraMultiSelect}
              onChange={isStyleView
                ? toggleStyleMultiSelect
                : isPresetView ? togglePresetMultiSelect : toggleLoraMultiSelect}
              aria-label={`Enable multiple ${isLoraView ? 'LoRA tag' : 'category'} selection`}
            />
            <span>{isLoraView ? 'Multi-tag select' : 'Multi-category select'}</span>
          </label>
        </div>
      </div>
      {(isStyleView || isPresetView || isLoraView) && (
        <div className="sg-batch-select-panel">
          <label className="sg-batch-select-toggle">
            <input
              type="checkbox"
              checked={batchSelect}
              onChange={isStyleView
                ? toggleStyleWildcardSelect
                : isPresetView ? togglePresetBatchSelect : toggleLoraBatchSelect}
            />
            <span>Select for batch editing</span>
          </label>
          {batchSelect && (
            <div className="sg-batch-select-actions">
              {isStyleView ? <>
                <button
                  type="button"
                  className="sg-batch-primary"
                  disabled={batchCount === 0}
                  onClick={() => sendToHost({ type: 'SG_BATCH_EDIT_STYLE_CATEGORIES', styles: selectedStyleRefs })}
                >
                  Edit category ({batchCount})
                </button>
                <button
                  type="button"
                  className="sg-batch-primary"
                  disabled={batchCount === 0}
                  onClick={() => sendToHost({ type: 'SG_BATCH_EDIT_STYLE_TAGS', styles: selectedStyleRefs })}
                >
                  Edit tags ({batchCount})
                </button>
                <button
                  type="button"
                  className="sg-batch-secondary"
                  disabled={batchCount < 2}
                  title={batchCount < 2 ? 'Select at least two styles' : undefined}
                  onClick={() => sendToHost({ type: 'SG_CREATE_TEMP_WILDCARD', styleNames: selectedWildcardStyleNames })}
                >
                  Create wildcard
                </button>
              </> : (
                <button
                  type="button"
                  className="sg-batch-primary"
                  disabled={batchCount === 0}
                  onClick={() => sendToHost(isPresetView
                    ? { type: 'SG_BATCH_EDIT_PRESET_CATEGORIES', names: selectedPresetNames }
                    : { type: 'SG_BATCH_EDIT_LORA_CATEGORIES', ids: selectedLoraIds })}
                >
                  {isPresetView ? 'Edit categories' : 'Edit tags'} ({batchCount})
                </button>
              )}
              {batchCount > 0 && (
                <button
                  type="button"
                  className="sg-batch-clear"
                  onClick={isStyleView
                    ? clearStyleWildcardSelection
                    : isPresetView ? clearPresetBatchSelection : clearLoraBatchSelection}
                >
                  Clear
                </button>
              )}
            </div>
          )}
        </div>
      )}
      <div className="sg-nav-categories">
        {isPresetView ? presetCategories.map(category => (
          <button key={category} type="button" className="sg-nav-item sg-category-item" title={category}
            aria-label={category} aria-current={activePresetCategories.includes(category) ? 'page' : undefined}
            onClick={() => selectPresetCategory(category)}
            onContextMenu={e => {
              e.preventDefault()
              if (category === 'Uncategorized') return
              setCatMenu({
                x: Math.min(e.clientX, window.innerWidth - 240),
                y: Math.min(e.clientY, window.innerHeight - 90),
                cat: category,
                kind: 'preset',
              })
            }}>
            <span className="sg-category-dot" style={{ backgroundColor: getCategoryColor(`preset:${category}`) }} />
            <span className="sg-category-label"><span>{category}</span></span>
            <span className="sg-nav-count">{presetCategoryCounts.get(category)}</span>
          </button>
        )) : isLoraView ? loraCategories.map(category => (
          <button key={category} type="button" className="sg-nav-item sg-category-item" title={category}
            aria-label={category} aria-current={activeLoraCategories.includes(category) ? 'page' : undefined}
            onClick={() => selectLoraCategory(category)}
            onContextMenu={e => {
              e.preventDefault()
              if (category === 'Uncategorized') return
              setCatMenu({
                x: Math.min(e.clientX, window.innerWidth - 240),
                y: Math.min(e.clientY, window.innerHeight - 90),
                cat: category,
                kind: 'lora',
              })
            }}>
            <span className="sg-category-dot" style={{ backgroundColor: getCategoryColor(`lora:${category}`) }} />
            <span className="sg-category-label"><span>{category}</span></span>
            <span className="sg-nav-count">{loraCategoryCounts.get(category)}</span>
          </button>
        )) : <Reorder.Group axis="y" values={cats} onReorder={setCategoryOrder} as="div">
          {cats.map(cat => {
            return (
              <Reorder.Item key={cat} value={cat} as="div" whileDrag={{ scale: 1.02, opacity: 0.9 }}>
                <button type="button" className="sg-nav-item sg-category-item" title={cat}
                  aria-label={cat} aria-current={activeStyleCategories.includes(cat) ? 'page' : undefined}
                  onClick={() => selectStyleCategory(cat)}
                  onContextMenu={e => {
                    e.preventDefault()
                    setCatMenu({
                      x: Math.min(e.clientX, window.innerWidth - 240),
                      y: Math.min(e.clientY, window.innerHeight - 180),
                      cat,
                      kind: 'style',
                    })
                  }}>
                  <span className="sg-category-dot" style={{ backgroundColor: getCategoryColor(cat) }} />
                  <span className="sg-category-label"><span>{cat}</span></span>
                  <span className="sg-nav-count">{visible.filter(s => categoryMatches(s.category, cat)).length}</span>
                </button>
              </Reorder.Item>
            )
          })}
        </Reorder.Group>}
      </div>
      {isStyleView && tags.length > 0 && <>
        <div className="sg-nav-heading sg-categories-heading">
          <span>Style Tags</span>
          <div className="sg-categories-heading-actions">
            <label className="sg-multi-select-toggle" title="Require every selected Style tag">
              <input
                type="checkbox"
                checked={styleTagMultiSelect}
                onChange={toggleStyleTagMultiSelect}
                aria-label="Enable multiple Style tag selection"
              />
              <span>Multi-tag select</span>
            </label>
          </div>
        </div>
        <div className="sg-nav-categories">
          {tags.map(tag => (
            <button key={tag} type="button" className="sg-nav-item sg-category-item" title={tag}
              aria-label={tag} aria-current={activeStyleTags.includes(tag) ? 'page' : undefined}
              onClick={() => selectStyleTag(tag)}
              onContextMenu={e => {
                e.preventDefault()
                setCatMenu({
                  x: Math.min(e.clientX, window.innerWidth - 240),
                  y: Math.min(e.clientY, window.innerHeight - 90),
                  cat: tag,
                  kind: 'styleTag',
                })
              }}>
              <span className="sg-category-dot" style={{ backgroundColor: getCategoryColor(`style-tag:${tag}`) }} />
              <span className="sg-category-label"><span>{tag}</span></span>
              <span className="sg-nav-count">{styleTagCounts.get(tag)}</span>
            </button>
          ))}
        </div>
      </>}
      <div className="sg-nav-footer">
        <LibraryMenu {...viewProps}><button type="button" className="sg-nav-item"><Settings size={18} /><span>Settings</span></button></LibraryMenu>
      </div>
      {catMenu && <>
        <div className="fixed inset-0 z-[9998]" onClick={() => setCatMenu(null)} onContextMenu={e => { e.preventDefault(); setCatMenu(null) }} />
        <div className="sg-library-menu fixed z-[9999]" style={{ left: catMenu.x, top: catMenu.y }}>
          {catMenu.kind === 'style' ? <>
          <button className="sg-menu-item" onClick={() => {
            sendToHost({ type: 'SG_RENAME_STYLE_CATEGORY', category: catMenu.cat, scope: 'family' })
            setCatMenu(null)
          }}>Rename category family...</button>
          <button className="sg-menu-item" onClick={() => { useStylesStore.getState().selectAllInCategory(catMenu.cat); setCatMenu(null) }}>
            {styleWildcardSelect ? 'Select family for batch actions' : 'Add all styles in family'}
          </button>
          <button className="sg-menu-item" onClick={() => { sendToHost({ type: 'SG_WILDCARD_CATEGORY', category: catMenu.cat }); setCatMenu(null) }}>Add family as wildcard</button>
          <button className="sg-menu-item" onClick={() => {
            sendToHost({ type: 'SG_GENERATE_CATEGORY_PREVIEWS', category: catMenu.cat, missingCount: 0, ...(activeSource ? { source: activeSource } : {}) })
            setCatMenu(null)
          }}>Generate family previews…</button>
          </> : catMenu.kind === 'styleTag' ? (
            <button className="sg-menu-item" onClick={() => {
              sendToHost({ type: 'SG_RENAME_STYLE_TAG', tag: catMenu.cat })
              setCatMenu(null)
            }}>
              Rename Style tag...
            </button>
          ) : (
            <button className="sg-menu-item" onClick={() => {
              sendToHost(catMenu.kind === 'preset'
                ? { type: 'SG_RENAME_PRESET_CATEGORY', category: catMenu.cat }
                : { type: 'SG_RENAME_LORA_CATEGORY', category: catMenu.cat })
              setCatMenu(null)
            }}>
              Rename {catMenu.kind === 'preset' ? 'category' : 'tag'}…
            </button>
          )}
        </div>
      </>}
    </nav>
  )
}
