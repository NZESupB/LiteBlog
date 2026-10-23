import { useState, useRef, useEffect, type ChangeEvent } from 'react'
import { Clock } from 'lucide-react'
import { normalizeTime } from '../../lib/time-utils'

interface TimePickerProps {
  name?: string
  id?: string
  value?: string
  defaultValue?: string
  disabled?: boolean
  required?: boolean
  ariaLabel?: string
  onChange?: (val: string) => void
}

const PRESET_TIMES = ['02:00', '03:00', '03:30', '04:00', '05:00']

export function TimePicker({
  name = 'time',
  id,
  defaultValue = '03:30',
  value: controlledValue,
  disabled = false,
  required = false,
  ariaLabel,
  onChange,
}: TimePickerProps) {
  const [internalValue, setInternalValue] = useState(() => normalizeTime(controlledValue ?? defaultValue))
  const [open, setOpen] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const [editingText, setEditingText] = useState<string | null>(null)

  const isControlled = controlledValue !== undefined
  const currentValue = isControlled ? normalizeTime(controlledValue) : internalValue
  const displayValue = editingText !== null ? editingText : currentValue
  const [hour, minute] = currentValue.split(':')
  const emitChange = (nextValue: string) => {
    const normalized = normalizeTime(nextValue)
    if (!isControlled) setInternalValue(normalized)
    onChange?.(normalized)
    if (inputRef.current) {
      inputRef.current.value = normalized
    }
  }

  // 监听外部点击关闭弹层
  useEffect(() => {
    if (!open) return
    const onOutside = (e: MouseEvent) => {
      if (!containerRef.current?.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOpen(false)
        inputRef.current?.focus({ preventScroll: true })
      }
    }
    document.addEventListener('mousedown', onOutside)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onOutside)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  const handleInputChange = (e: ChangeEvent<HTMLInputElement>) => {
    const raw = e.target.value
    setEditingText(raw)
    if (!isControlled) setInternalValue(raw)
    onChange?.(raw)
  }

  const handleInputBlur = () => {
    const normalized = normalizeTime(editingText ?? currentValue)
    setEditingText(null)
    emitChange(normalized)
  }

  return (
    <div className="time-picker-root" ref={containerRef}>
      <div className={`time-picker-control${open ? ' is-open' : ''}${disabled ? ' is-disabled' : ''}`}>
        <span
          className="time-picker-prefix"
          aria-hidden="true"
          onClick={() => !disabled && setOpen((prev) => !prev)}
        >
          <Clock className="icon" size={16} />
        </span>
        <input
          ref={inputRef}
          id={id}
          name={name}
          type="text"
          className="time-picker-input"
          value={displayValue}
          disabled={disabled}
          required={required}
          aria-label={ariaLabel}
          pattern="^([01]?\d|2[0-3]):[0-5]\d$"
          placeholder="03:30"
          autoComplete="off"
          onChange={handleInputChange}
          onBlur={handleInputBlur}
          onClick={() => !disabled && setOpen(true)}
        />
        <button
          type="button"
          className="time-picker-toggle"
          aria-label="选择时间"
          aria-expanded={open}
          disabled={disabled}
          onClick={() => setOpen((prev) => !prev)}
        >
          {open ? '收起' : '选择'}
        </button>
      </div>

      {open && (
        <div className="time-picker-popover" role="dialog" aria-label="选择时间弹层">
          <div className="time-picker-presets">
            <span className="presets-title">推荐时段</span>
            <div className="presets-list">
              {PRESET_TIMES.map((preset) => (
                <button
                  key={preset}
                  type="button"
                  className={`preset-chip${currentValue === preset ? ' active' : ''}`}
                  onClick={() => {
                    emitChange(preset)
                    setOpen(false)
                  }}
                >
                  {preset}
                </button>
              ))}
            </div>
          </div>

          <div className="time-picker-columns">
            <div className="time-col">
              <div className="col-header">时 (00-23)</div>
              <div className="col-cells">
                {Array.from({ length: 24 }).map((_, i) => {
                  const h = String(i).padStart(2, '0')
                  return (
                    <button
                      key={h}
                      type="button"
                      className={`time-cell${hour === h ? ' selected' : ''}`}
                      aria-pressed={hour === h}
                      onClick={() => emitChange(`${h}:${minute || '00'}`)}
                    >
                      {h}
                    </button>
                  )
                })}
              </div>
            </div>

            <div className="time-col">
              <div className="col-header">分 (00-55)</div>
              <div className="col-cells">
                {Array.from({ length: 12 }).map((_, i) => {
                  const m = String(i * 5).padStart(2, '0')
                  return (
                    <button
                      key={m}
                      type="button"
                      className={`time-cell${minute === m ? ' selected' : ''}`}
                      aria-pressed={minute === m}
                      onClick={() => {
                        emitChange(`${hour || '03'}:${m}`)
                        setOpen(false)
                      }}
                    >
                      {m}
                    </button>
                  )
                })}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
