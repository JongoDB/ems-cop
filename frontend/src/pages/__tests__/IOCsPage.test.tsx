import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import IOCsPage from '../IOCsPage';

const mockApiFetch = vi.fn();
vi.mock('../../lib/api', () => ({
  apiFetch: (...args: unknown[]) => mockApiFetch(...args),
}));

vi.mock('lucide-react', () => ({
  Search: () => <svg data-testid="search-icon" />,
  ChevronLeft: () => <svg data-testid="chevron-left" />,
  ChevronRight: () => <svg data-testid="chevron-right" />,
  Plus: () => <svg data-testid="plus" />,
  X: () => <svg data-testid="x" />,
  Upload: () => <svg data-testid="upload" />,
  ToggleLeft: () => <svg data-testid="toggle-left" />,
  ToggleRight: () => <svg data-testid="toggle-right" />,
}));

// Mock IOCSearchBar to avoid duplicate elements
vi.mock('../../components/IOCSearchBar', () => ({
  default: ({ onSelect: _onSelect }: { onSelect?: unknown }) => <div data-testid="ioc-search-bar">IOC Search</div>,
}));

// Mock ClassificationSelect and ClassificationBadge
vi.mock('../../components/ClassificationSelect', () => ({
  default: () => <select data-testid="classification-select" />,
}));

vi.mock('../../components/ClassificationBadge', () => ({
  default: () => <span data-testid="classification-badge" />,
}));

function renderPage() {
  return render(
    <MemoryRouter>
      <IOCsPage />
    </MemoryRouter>
  );
}

describe('IOCsPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockApiFetch.mockResolvedValue({
      data: [
        {
          id: '1',
          ioc_type: 'ip',
          value: '192.168.1.1',
          threat_level: 'high',
          source: 'manual',
          tags: ['malware', 'c2'],
          is_active: true,
          first_seen: '2024-01-01T00:00:00Z',
          last_seen: '2024-01-15T00:00:00Z',
          created_at: '2024-01-01T00:00:00Z',
        },
      ],
      pagination: { total: 1 },
    });
  });

  it('renders the page title', async () => {
    renderPage();
    await waitFor(() => {
      expect(screen.getByText('IOCs')).toBeInTheDocument();
    });
  });

  it('renders IOC table with data', async () => {
    renderPage();
    await waitFor(() => {
      expect(screen.getByText('192.168.1.1')).toBeInTheDocument();
    });
  });

  it('renders ioc type badge', async () => {
    renderPage();
    await waitFor(() => {
      // 'ip' appears as the badge in the table row
      expect(screen.getByText('ip')).toBeInTheDocument();
    });
  });

  it('renders threat level badge', async () => {
    renderPage();
    await waitFor(() => {
      expect(screen.getByText('high')).toBeInTheDocument();
    });
  });

  it('renders active status', async () => {
    renderPage();
    await waitFor(() => {
      expect(screen.getByText('YES')).toBeInTheDocument();
    });
  });

  it('renders tags', async () => {
    renderPage();
    await waitFor(() => {
      expect(screen.getByText('malware')).toBeInTheDocument();
    });
  });

  it('renders table headers', async () => {
    renderPage();
    await waitFor(() => {
      expect(screen.getByText('VALUE')).toBeInTheDocument();
      expect(screen.getByText('FIRST SEEN')).toBeInTheDocument();
      expect(screen.getByText('LAST SEEN')).toBeInTheDocument();
      expect(screen.getByText('ACTIONS')).toBeInTheDocument();
      // TYPE, THREAT, ACTIVE appear both in headers and filter dropdowns
      expect(screen.getAllByText('TYPE').length).toBeGreaterThanOrEqual(1);
      expect(screen.getAllByText('ACTIVE').length).toBeGreaterThanOrEqual(1);
    });
  });

  it('renders create button', async () => {
    renderPage();
    await waitFor(() => {
      expect(screen.getByText('NEW IOC')).toBeInTheDocument();
    });
  });

  it('renders import button', async () => {
    renderPage();
    await waitFor(() => {
      expect(screen.getByText('IMPORT CSV')).toBeInTheDocument();
    });
  });

  it('shows no IOCs message when empty', async () => {
    mockApiFetch.mockResolvedValue({ data: [], pagination: { total: 0 } });
    renderPage();
    await waitFor(() => {
      expect(screen.getByText('No IOCs found')).toBeInTheDocument();
    });
  });
});
