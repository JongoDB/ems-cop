import { useState, useCallback } from 'react'
import { apiFetch } from '../lib/api'
import { Search } from 'lucide-react'

export interface IOC {
  id: string
  ioc_type: string
  value: string
  threat_level: string
  source: string
  tags: string[]
  is_active: boolean
  first_seen: string
  last_seen: string
}

interface IOCSearchBarProps {
  onSelect?: (ioc: IOC) => void
  className?: string
}

const IOC_TYPES = [
  { value: '', label: 'All Types' },
  { value: 'ip', label: 'IP Address' },
  { value: 'domain', label: 'Domain' },
  { value: 'hash_md5', label: 'Hash (MD5)' },
  { value: 'hash_sha1', label: 'Hash (SHA1)' },
  { value: 'hash_sha256', label: 'Hash (SHA256)' },
  { value: 'url', label: 'URL' },
  { value: 'email', label: 'Email' },
]

export default function IOCSearchBar({ onSelect, className = '' }: IOCSearchBarProps) {
  const [query, setQuery] = useState('')
  const [iocType, setIocType] = useState('')
  const [results, setResults] = useState<IOC[]>([])
  const [showResults, setShowResults] = useState(false)
  const [searching, setSearching] = useState(false)

  const handleSearch = useCallback(async (searchQuery: string, searchType: string) => {
    if (!searchQuery.trim()) {
      setResults([])
      setShowResults(false)
      return
    }

    setSearching(true)
    try {
      const res = await apiFetch<{ data: IOC[] }>('/endpoints/iocs/search', {
        method: 'POST',
        body: JSON.stringify({
          value: searchQuery,
          ioc_type: searchType || undefined,
        }),
      })
      setResults(res.data || [])
      setShowResults(true)
    } catch {
      setResults([])
    } finally {
      setSearching(false)
    }
  }, [])

  const handleInputChange = (value: string) => {
    setQuery(value)
    if (value.length >= 3) {
      handleSearch(value, iocType)
    } else {
      setResults([])
      setShowResults(false)
    }
  }

  const handleSelect = (ioc: IOC) => {
    onSelect?.(ioc)
    setShowResults(false)
    setQuery('')
  }

  return (
    <div className={className} style={{ position: 'relative' }}>
      <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
        <select
          value={iocType}
          onChange={(e) => {
            setIocType(e.target.value)
            if (query.length >= 3) handleSearch(query, e.target.value)
          }}
          className="filter-select"
          style={{ fontSize: 11, padding: '4px 8px', minWidth: 100 }}
        >
          {IOC_TYPES.map(({ value, label }) => (
            <option key={value} value={value}>{label}</option>
          ))}
        </select>
        <div className="search-box" style={{ flex: 1 }}>
          <Search size={14} />
          <input
            type="text"
            value={query}
            onChange={(e) => handleInputChange(e.target.value)}
            onFocus={() => { if (results.length > 0) setShowResults(true) }}
            onBlur={() => setTimeout(() => setShowResults(false), 200)}
            className="search-input"
            placeholder="Search IOCs (min 3 chars)..."
            style={{ fontSize: 11 }}
          />
          {searching && (
            <span style={{ fontSize: 9, color: 'var(--color-text-muted)', fontFamily: 'var(--font-mono)' }}>
              ...
            </span>
          )}
        </div>
      </div>

      {showResults && results.length > 0 && (
        <div style={{
          position: 'absolute',
          top: '100%',
          left: 0,
          right: 0,
          zIndex: 50,
          background: 'var(--color-bg-elevated)',
          border: '1px solid var(--color-border)',
          borderRadius: 'var(--radius)',
          maxHeight: 240,
          overflow: 'auto',
          marginTop: 2,
        }}>
          {results.map((ioc) => (
            <div
              key={ioc.id}
              onClick={() => handleSelect(ioc)}
              style={{
                padding: '6px 10px',
                cursor: 'pointer',
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                fontSize: 11,
                borderBottom: '1px solid var(--color-border)',
              }}
              onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = 'var(--color-bg-primary)' }}
              onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = '' }}
            >
              <span style={{
                fontFamily: 'var(--font-mono)',
                fontSize: 9,
                padding: '1px 4px',
                background: 'var(--color-bg-primary)',
                borderRadius: 'var(--radius)',
                color: 'var(--color-text-muted)',
                whiteSpace: 'nowrap',
              }}>
                {ioc.ioc_type}
              </span>
              <span style={{
                flex: 1,
                fontFamily: 'var(--font-mono)',
                color: 'var(--color-text-bright)',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}>
                {ioc.value}
              </span>
              <span style={{
                fontFamily: 'var(--font-mono)',
                fontSize: 9,
                color: ioc.threat_level === 'critical' ? '#ef4444' : ioc.threat_level === 'high' ? '#f97316' : 'var(--color-text-muted)',
              }}>
                {ioc.threat_level}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
