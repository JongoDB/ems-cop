import { Shield, ShieldAlert, ShieldCheck } from 'lucide-react'

export type Classification = 'UNCLASS' | 'CUI' | 'SECRET'

interface ClassificationBadgeProps {
  classification?: Classification | string | null
  size?: 'sm' | 'md' | 'lg'
}

const CLASSIFICATION_CONFIG: Record<Classification, {
  label: string
  bg: string
  text: string
  border: string
  icon: typeof Shield
}> = {
  UNCLASS: {
    label: 'UNCLASS',
    bg: 'bg-green-900/50',
    text: 'text-green-300',
    border: 'border-green-600',
    icon: ShieldCheck,
  },
  CUI: {
    label: 'CUI',
    bg: 'bg-amber-900/50',
    text: 'text-amber-300',
    border: 'border-amber-500',
    icon: Shield,
  },
  SECRET: {
    label: 'SECRET',
    bg: 'bg-red-900/50',
    text: 'text-red-300',
    border: 'border-red-500',
    icon: ShieldAlert,
  },
}

const SIZE_CLASSES: Record<'sm' | 'md' | 'lg', {
  padding: string
  text: string
  icon: number
  gap: string
}> = {
  sm: { padding: 'px-1.5 py-0.5', text: 'text-[9px]', icon: 10, gap: 'gap-1' },
  md: { padding: 'px-2 py-0.5', text: 'text-[10px]', icon: 12, gap: 'gap-1' },
  lg: { padding: 'px-2.5 py-1', text: 'text-[11px]', icon: 14, gap: 'gap-1.5' },
}

function normalizeClassification(value?: string | null): Classification {
  if (!value) return 'UNCLASS'
  const upper = value.toUpperCase()
  if (upper === 'CUI') return 'CUI'
  if (upper === 'SECRET') return 'SECRET'
  return 'UNCLASS'
}

export default function ClassificationBadge({
  classification,
  size = 'md',
}: ClassificationBadgeProps) {
  const level = normalizeClassification(classification)
  const config = CLASSIFICATION_CONFIG[level]
  const sizeConfig = SIZE_CLASSES[size]
  const Icon = config.icon

  return (
    <span
      className={`
        inline-flex items-center ${sizeConfig.gap}
        ${sizeConfig.padding} ${sizeConfig.text}
        ${config.bg} ${config.text} ${config.border}
        border rounded font-mono font-semibold tracking-wider
        select-none whitespace-nowrap uppercase leading-none
      `}
      title={`Classification: ${config.label}`}
    >
      <Icon size={sizeConfig.icon} />
      {config.label}
    </span>
  )
}
