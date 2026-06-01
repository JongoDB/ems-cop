import { describe, it, expect, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import CommandPalette from '../CommandPalette'
import { useAuthStore } from '../../stores/authStore'

function renderPalette(open = true) {
  return render(
    <MemoryRouter initialEntries={['/operations']}>
      <CommandPalette open={open} onOpenChange={() => {}} />
    </MemoryRouter>
  )
}

describe('CommandPalette', () => {
  beforeEach(() => {
    // Make sure the palette considers the user authenticated.
    useAuthStore.setState({
      user: {
        id: 'u1',
        username: 'tester',
        display_name: 'Tester',
        email: 't@t',
        roles: ['operator'],
      },
      accessToken: 'tok',
      isAuthenticated: true,
    })
  })

  it('renders nothing when closed', () => {
    const { container } = renderPalette(false)
    expect(container.firstChild).toBeNull()
  })

  it('renders core navigation commands when open', () => {
    renderPalette(true)
    expect(screen.getByRole('dialog', { name: /command palette/i })).toBeInTheDocument()
    expect(screen.getByText('Go to Operations')).toBeInTheDocument()
    expect(screen.getByText('Go to Tickets')).toBeInTheDocument()
    expect(screen.getByText('Go to Topology')).toBeInTheDocument()
    expect(screen.getByText('Go to Dashboards')).toBeInTheDocument()
    expect(screen.getByText('Logout')).toBeInTheDocument()
  })

  it('filters commands by search query', () => {
    renderPalette(true)
    const input = screen.getByLabelText(/command palette search/i)
    fireEvent.change(input, { target: { value: 'topology' } })
    expect(screen.getByText('Go to Topology')).toBeInTheDocument()
    expect(screen.queryByText('Go to Tickets')).not.toBeInTheDocument()
  })

  it('shows empty message when no commands match', () => {
    renderPalette(true)
    const input = screen.getByLabelText(/command palette search/i)
    fireEvent.change(input, { target: { value: 'zzznomatchzzz' } })
    expect(screen.getByText(/No commands match/i)).toBeInTheDocument()
  })

  it('returns null when not authenticated', () => {
    useAuthStore.setState({ user: null, accessToken: null, isAuthenticated: false })
    const { container } = renderPalette(true)
    expect(container.firstChild).toBeNull()
  })
})
