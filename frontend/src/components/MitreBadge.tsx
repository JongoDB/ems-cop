interface MitreBadgeProps {
  techniques: string[]
  className?: string
}

function techniqueUrl(id: string): string {
  // Sub-techniques like T1566.001 → /techniques/T1566/001/
  const parts = id.split('.')
  const path = parts.join('/')
  return `https://attack.mitre.org/techniques/${path}/`
}

export default function MitreBadge({ techniques, className = '' }: MitreBadgeProps) {
  if (!techniques || techniques.length === 0) return null

  return (
    <span className={`inline-flex flex-wrap gap-1 ${className}`}>
      {techniques.map((t) => (
        <a
          key={t}
          href={techniqueUrl(t)}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-mono font-semibold bg-purple-100 text-purple-800 hover:bg-purple-200 transition-colors no-underline whitespace-nowrap"
          title={`MITRE ATT&CK: ${t}`}
        >
          {t}
        </a>
      ))}
    </span>
  )
}
