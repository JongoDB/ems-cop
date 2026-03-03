interface SeverityBadgeProps {
  severity: 'critical' | 'high' | 'medium' | 'low' | 'info'
  className?: string
}

const SEVERITY_STYLES: Record<string, string> = {
  critical: 'bg-red-600 text-white',
  high: 'bg-orange-500 text-white',
  medium: 'bg-yellow-500 text-black',
  low: 'bg-blue-500 text-white',
  info: 'bg-gray-500 text-white',
}

export default function SeverityBadge({ severity, className = '' }: SeverityBadgeProps) {
  const style = SEVERITY_STYLES[severity] || SEVERITY_STYLES.info

  return (
    <span
      className={`inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-mono font-semibold tracking-wider uppercase leading-none select-none whitespace-nowrap ${style} ${className}`}
      title={`Severity: ${severity}`}
    >
      {severity.toUpperCase()}
    </span>
  )
}
