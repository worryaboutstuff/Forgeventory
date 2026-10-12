import { useEffect, useState } from 'react'
import { onHostMessage, type Style } from '../bridge'
import { useStylesStore } from '../store/stylesStore'
import { BookMarked, FileText, Image } from 'lucide-react'

interface Props {
  style: Style
  /** Preset cards use private local thumbnails and fall back to a preset icon. */
  presetName?: string
}

export function ThumbnailPreview({ style, presetName }: Props) {
  const [imgOk, setImgOk] = useState(false)
  const [instantSrc, setInstantSrc] = useState<string | null>(null)
  const [localVersion, setLocalVersion] = useState(
    localStorage.getItem(`${presetName ? 'sg_preset_thumb_v_' : 'sg_thumb_v_'}${style.name}`) || '1'
  )
  const activeSource = useStylesStore((s) => s.activeSource)
  const sourceForThumb = style.source_file || activeSource || ''
  const thumbUrl = presetName
    ? `/style_grid/preset-thumbnail?name=${encodeURIComponent(presetName)}&v=${localVersion}`
    : `/style_grid/thumbnail?name=${encodeURIComponent(style.name)}${
        sourceForThumb ? `&source=${encodeURIComponent(sourceForThumb)}` : ''
      }&v=${localVersion}`

  useEffect(() => {
    const unsub = onHostMessage((msg) => {
      if (
        msg.type === 'SG_THUMB_DONE' &&
        msg.styleId === style.name &&
        (msg.preset === true) === Boolean(presetName)
      ) {
        const version = String(msg.version)
        localStorage.setItem(`${presetName ? 'sg_preset_thumb_v_' : 'sg_thumb_v_'}${style.name}`, version)
        setInstantSrc(msg.imageData || null)
        setLocalVersion(version)
        setImgOk(false)
      }
    })
    return unsub
  }, [presetName, style.name])

  return (
    <div className="sg-card-preview">
      <div className="absolute inset-0 flex flex-col gap-2 items-center justify-center text-xs text-sg-muted">
        {presetName
          ? (style.prompt ? <><FileText size={34} /><span>Saved prompt</span></> : <BookMarked size={34} />)
          : <><Image size={27} strokeWidth={1.2} aria-hidden="true" /><span>No preview</span></>}
      </div>
      <img
        src={instantSrc || thumbUrl}
        alt={`${style.name} preview`}
        loading="lazy"
        className={`absolute inset-0 h-full w-full object-cover transition-opacity ${
          imgOk ? 'opacity-100' : 'opacity-0'
        }`}
        onLoad={() => setImgOk(true)}
        onError={() => {
          if (instantSrc) setInstantSrc(null)
          setImgOk(false)
        }}
      />
    </div>
  )
}
