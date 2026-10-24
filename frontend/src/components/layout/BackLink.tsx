import { ArrowLeft } from 'lucide-react'
import { Link } from 'react-router-dom'

export function BackLink({ to, label }: { to: string; label: string }) {
  return (
    <Link to={to} className="back-link">
      <ArrowLeft size={16} aria-hidden="true" />
      <span>返回{label}</span>
    </Link>
  )
}
