import type { ReactNode } from 'react'
import { BackLink } from './BackLink'

export function SettingsPage({
  title,
  description,
  backTo,
  backLabel,
  account = false,
  children,
}: {
  title: string
  description: string
  backTo: string
  backLabel: string
  account?: boolean
  children: ReactNode
}) {
  return (
    <div className={account ? 'account-page' : 'settings-page'} data-motion-owned="true">
      <BackLink to={backTo} label={backLabel} />
      <header className="settings-page-heading">
        <h1>{title}</h1>
        <p>{description}</p>
      </header>
      {children}
    </div>
  )
}
