import { useEffect, useId, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { errorMessage } from '../../lib/types'
import { createDialog } from '../../native/ui/dialog.js'
import { animatePresence, motionTiming } from '../../native/ui/motion.js'

interface ConfirmDialogProps {
  title: string
  description: string
  confirmLabel: string
  cancelLabel: string
  onConfirm: () => Promise<void>
  onClose: (confirmed: boolean) => void
}

export function ConfirmDialog({
  title,
  description,
  confirmLabel,
  cancelLabel,
  onConfirm,
  onClose,
}: ConfirmDialogProps) {
  const id = useId()
  const dialog = useRef<HTMLDialogElement>(null)
  const surface = useRef<HTMLDivElement>(null)
  const cancel = useRef<HTMLButtonElement>(null)
  const callbacks = useRef({ onConfirm, onClose })
  callbacks.current = { onConfirm, onClose }
  const actions = useRef({ cancel: () => {}, confirm: () => {} })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    let active = true
    let pending = false
    let closing = false
    const node = dialog.current!
    const panel = surface.current!
    const modal = createDialog(node, { onRequestClose: () => void close(false) })
    async function close(confirmed: boolean) {
      if (!active || closing || (!confirmed && pending)) return
      closing = true
      modal.beginClose()
      await Promise.all([
        animatePresence(node, false, {
          className: 'overlay-presence',
          duration: motionTiming.backdrop,
          hidden: false,
        }),
        animatePresence(panel, false, {
          className: 'dialog-presence',
          duration: motionTiming.dialog,
          hidden: false,
        }),
      ])
      if (!active) return
      modal.finish()
      callbacks.current.onClose(confirmed)
    }
    async function confirm() {
      if (!active || pending || closing) return
      pending = true
      setBusy(true)
      setError('')
      try {
        await callbacks.current.onConfirm()
        if (active) await close(true)
      } catch (failure) {
        if (!active) return
        pending = false
        setBusy(false)
        setError(errorMessage(failure))
      }
    }
    actions.current = { cancel: () => void close(false), confirm: () => void confirm() }
    modal.open()
    cancel.current?.focus({ preventScroll: true })
    void animatePresence(node, true, { className: 'overlay-presence', duration: motionTiming.backdrop })
    void animatePresence(panel, true, { className: 'dialog-presence', duration: motionTiming.dialog })
    return () => {
      active = false
      actions.current = { cancel: () => {}, confirm: () => {} }
      modal.dispose({ restoreFocus: false })
    }
  }, [])

  return createPortal(
    <dialog
      ref={dialog}
      className="confirm-overlay"
      role="alertdialog"
      aria-modal="true"
      aria-labelledby={`${id}-title`}
      aria-describedby={`${id}-description`}
      aria-busy={busy}
      onClick={(event) => event.stopPropagation()}
    >
      <div ref={surface} className="confirm-dialog">
        <h2 id={`${id}-title`}>{title}</h2>
        <p id={`${id}-description`}>{description}</p>
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        <div className="confirm-actions">
          <button
            ref={cancel}
            className="btn-ghost"
            type="button"
            disabled={busy}
            onClick={() => actions.current.cancel()}
          >
            {cancelLabel}
          </button>
          <button
            className="btn confirm-destructive"
            type="button"
            disabled={busy}
            onClick={() => actions.current.confirm()}
          >
            {busy ? '正在丢弃…' : confirmLabel}
          </button>
        </div>
      </div>
    </dialog>,
    document.body,
  )
}
