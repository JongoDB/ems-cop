// Tests for the Generate Implant modal.
//
// We mock useTopology to control the provider list, and mock apiFetch
// directly to assert the URL/body posted by the underlying mutation.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import GenerateImplantModal from '../GenerateImplantModal'
import type { ProviderInfo, TopologyResponse } from '../../../lib/c2Topology'

// ─── Mocks ────────────────────────────────────────────────────────────

const mockApiFetch = vi.fn()
vi.mock('../../../lib/api', () => ({
  apiFetch: (...args: unknown[]) => mockApiFetch(...args),
}))

let mockProviders: ProviderInfo[] = []
vi.mock('../../../hooks/useTunnels', () => ({
  useTopology: (): { data: TopologyResponse | undefined } => ({
    data: { sessions: [], tunnels: [], providers: mockProviders },
  }),
}))

// ─── Helpers ──────────────────────────────────────────────────────────

function renderModal(props: Partial<React.ComponentProps<typeof GenerateImplantModal>> = {}) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  const defaults = {
    open: true,
    onClose: () => {},
  }
  return render(
    <QueryClientProvider client={client}>
      <GenerateImplantModal {...defaults} {...props} />
    </QueryClientProvider>
  )
}

beforeEach(() => {
  mockApiFetch.mockReset()
  mockProviders = []
})

// ─── Tests ────────────────────────────────────────────────────────────

describe('GenerateImplantModal', () => {
  it('renders the provider list and disables submit when none are connected', () => {
    mockProviders = [
      { name: 'sliver-prod', type: 'sliver', enabled: true, connected: false },
      { name: 'mythic-stage', type: 'mythic', enabled: true, connected: false },
    ]
    renderModal()

    // Provider option labels include the disconnected suffix.
    expect(screen.getByRole('option', { name: /sliver-prod/i })).toBeInTheDocument()
    expect(screen.getByText(/no connected providers/i)).toBeInTheDocument()

    const submit = screen.getByRole('button', { name: /generate implant/i })
    expect(submit).toBeDisabled()
  })

  it('renders providers with connection markers when at least one is connected', () => {
    mockProviders = [
      { name: 'sliver-prod', type: 'sliver', enabled: true, connected: true },
      { name: 'mythic-stage', type: 'mythic', enabled: true, connected: false },
    ]
    renderModal()
    expect(screen.getByRole('option', { name: /sliver-prod ✓/i })).toBeInTheDocument()
    expect(screen.getByRole('option', { name: /mythic-stage \(disconnected\)/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /generate implant/i })).not.toBeDisabled()
  })

  it('posts the right body and URL when submitted', async () => {
    mockProviders = [
      { name: 'sliver-prod', type: 'sliver', enabled: true, connected: true },
    ]
    mockApiFetch.mockResolvedValueOnce({ name: 'beacon.exe', size: 12345 })

    renderModal()

    // Fill the C2 URL
    const urlInput = screen.getByPlaceholderText(/sliver-server:8888|c2-server/i) as HTMLInputElement
    fireEvent.change(urlInput, { target: { value: 'mtls://10.0.0.5:8888' } })

    // Submit
    fireEvent.click(screen.getByRole('button', { name: /generate implant/i }))

    await waitFor(() => expect(mockApiFetch).toHaveBeenCalled())

    const [path, options] = mockApiFetch.mock.calls[0]
    expect(path).toBe('/c2/implants/generate?provider=sliver-prod')
    expect(options.method).toBe('POST')
    const body = JSON.parse(options.body as string)
    expect(body).toMatchObject({
      os: 'windows',
      arch: 'amd64',
      format: 'exe',
      transport: 'https',
      c2_url: 'mtls://10.0.0.5:8888',
      skip_symbols: true,
    })
  })

  it('shows the success state with the implant name and size', async () => {
    mockProviders = [
      { name: 'sliver-prod', type: 'sliver', enabled: true, connected: true },
    ]
    mockApiFetch.mockResolvedValueOnce({ name: 'beacon-x64.exe', size: 2_500_000 })

    renderModal()
    fireEvent.click(screen.getByRole('button', { name: /generate implant/i }))

    await waitFor(() =>
      expect(screen.getByText(/implant built/i)).toBeInTheDocument()
    )
    expect(screen.getByText('beacon-x64.exe')).toBeInTheDocument()
    // The size readout — ~2.4 MB. Match the formatted size + suffix together.
    expect(screen.getByText(/2\.4 MB · stored on C2 server/i)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /generate another/i })).toBeInTheDocument()
    // Two "close" buttons exist now (the X icon + the explicit Close CTA);
    // confirm via the visible text label rather than role to disambiguate.
    expect(screen.getByText('CLOSE')).toBeInTheDocument()
  })

  it('shows the API error message on a 4xx', async () => {
    mockProviders = [
      { name: 'sliver-prod', type: 'sliver', enabled: true, connected: true },
    ]
    mockApiFetch.mockRejectedValueOnce(new Error('build failed: cross-compile toolchain missing'))

    renderModal()
    fireEvent.click(screen.getByRole('button', { name: /generate implant/i }))

    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent(/cross-compile toolchain missing/i)
    )
    // Modal stays open — submit button is back.
    expect(screen.getByRole('button', { name: /generate implant/i })).toBeInTheDocument()
  })
})
