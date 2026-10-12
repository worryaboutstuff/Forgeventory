import { useStylesStore } from '../store/stylesStore'

export function SourceFilter() {
  const { sources, activeSource, setActiveSource } = useStylesStore()
  if (sources.length === 0) return null
  const labelOf = (src: string) => {
    const normalized = src.replace(/\\/g, '/')
    const base = normalized.split('/').pop() || src
    return base.replace(/\.csv$/i, '')
  }
  const currentLabel = activeSource ? labelOf(activeSource) : 'All Sources'

  return (
    <select
      value={activeSource ?? ''}
      onChange={e => setActiveSource(e.target.value || null)}
      className="sg-source-select"
      aria-label="Source"
      title={currentLabel}
    >
      <option value="">All Sources</option>
      {sources.map(src => (
        <option key={src} value={src} title={src}>
          {labelOf(src)}
        </option>
      ))}
    </select>
  )
}
