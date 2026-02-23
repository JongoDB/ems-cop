import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuthStore } from '../stores/authStore'
import { apiFetch, setAccessToken } from '../lib/api'
import { Shield } from 'lucide-react'

export default function LoginPage() {
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [isSubmitting, setIsSubmitting] = useState(false)
  const setAuth = useAuthStore((s) => s.setAuth)
  const navigate = useNavigate()

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError('')
    setIsSubmitting(true)
    try {
      const data = await apiFetch<{
        access_token: string
        refresh_token: string
        user: { id: string; username: string; display_name: string; email: string; roles: string[] }
      }>('/auth/login', {
        method: 'POST',
        body: JSON.stringify({ username, password }),
      })
      setAccessToken(data.access_token)
      setAuth(data.user, data.access_token, data.refresh_token)
      navigate('/')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Login failed')
    } finally {
      setIsSubmitting(false)
    }
  }

  return (
    <div className="login-page">
      {/* Scanline overlay */}
      <div className="scanline-overlay" />

      <div className="login-container">
        <div className="login-header">
          <Shield className="login-icon" size={32} strokeWidth={1.5} />
          <h1 className="login-title">EMS-COP</h1>
          <p className="login-subtitle">COMMON OPERATING PICTURE</p>
          <div className="login-divider" />
        </div>

        <form onSubmit={handleSubmit} className="login-form">
          <div className="form-group">
            <label htmlFor="username" className="form-label">
              OPERATOR ID
            </label>
            <input
              id="username"
              type="text"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              className="form-input"
              placeholder="username"
              autoComplete="username"
              required
              disabled={isSubmitting}
            />
          </div>

          <div className="form-group">
            <label htmlFor="password" className="form-label">
              PASSPHRASE
            </label>
            <input
              id="password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="form-input"
              placeholder="••••••••"
              autoComplete="current-password"
              required
              disabled={isSubmitting}
            />
          </div>

          {error && (
            <div className="form-error">
              <span className="error-indicator">!</span>
              {error}
            </div>
          )}

          <button type="submit" className="login-button" disabled={isSubmitting}>
            {isSubmitting ? 'AUTHENTICATING...' : 'AUTHENTICATE'}
          </button>
        </form>

        <p className="login-footer">CLASSIFICATION: UNCLASSIFIED // FOR EXERCISE USE ONLY</p>
      </div>
    </div>
  )
}
