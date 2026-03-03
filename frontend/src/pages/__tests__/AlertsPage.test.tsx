import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import AlertsPage from '../AlertsPage';

// Mock apiFetch
const mockApiFetch = vi.fn();
vi.mock('../../lib/api', () => ({
  apiFetch: (...args: unknown[]) => mockApiFetch(...args),
}));

// Mock useSocket
vi.mock('../../hooks/useSocket', () => ({
  useSocket: () => ({ events: [], connected: false }),
}));

// Mock lucide-react
vi.mock('lucide-react', () => ({
  Search: () => <svg data-testid="search-icon" />,
  ChevronLeft: () => <svg data-testid="chevron-left" />,
  ChevronRight: () => <svg data-testid="chevron-right" />,
  ChevronDown: () => <svg data-testid="chevron-down" />,
  ChevronUp: () => <svg data-testid="chevron-up" />,
  CheckSquare: () => <svg data-testid="check-square" />,
  AlertTriangle: () => <svg data-testid="alert-triangle" />,
}));

// Mock AlertFeed to avoid duplicate content
vi.mock('../../components/AlertFeed', () => ({
  default: () => <div data-testid="alert-feed">Alert Feed</div>,
}));

function renderPage() {
  return render(
    <MemoryRouter>
      <AlertsPage />
    </MemoryRouter>
  );
}

describe('AlertsPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockApiFetch.mockResolvedValue({
      data: [
        {
          id: '1',
          title: 'Test Alert',
          severity: 'high',
          source_system: 'siem',
          status: 'new',
          mitre_techniques: ['T1566'],
          created_at: '2024-01-01T00:00:00Z',
        },
      ],
      pagination: { total: 1 },
    });
  });

  it('renders the page title', async () => {
    renderPage();
    await waitFor(() => {
      expect(screen.getByText('ALERTS')).toBeInTheDocument();
    });
  });

  it('renders alerts table with data', async () => {
    renderPage();
    await waitFor(() => {
      expect(screen.getByText('Test Alert')).toBeInTheDocument();
    });
  });

  it('renders severity badges', async () => {
    renderPage();
    await waitFor(() => {
      expect(screen.getByText('HIGH')).toBeInTheDocument();
    });
  });

  it('renders MITRE technique badges', async () => {
    renderPage();
    await waitFor(() => {
      expect(screen.getByText('T1566')).toBeInTheDocument();
    });
  });

  it('shows loading state initially', () => {
    mockApiFetch.mockReturnValue(new Promise(() => {})); // never resolves
    renderPage();
    expect(screen.getByText('Loading...')).toBeInTheDocument();
  });

  it('renders table headers', async () => {
    renderPage();
    await waitFor(() => {
      expect(screen.getByText('SEVERITY')).toBeInTheDocument();
      expect(screen.getByText('TITLE')).toBeInTheDocument();
      expect(screen.getByText('SOURCE')).toBeInTheDocument();
      expect(screen.getByText('STATUS')).toBeInTheDocument();
      expect(screen.getByText('MITRE')).toBeInTheDocument();
      expect(screen.getByText('CREATED')).toBeInTheDocument();
    });
  });

  it('renders live feed toggle', async () => {
    renderPage();
    await waitFor(() => {
      expect(screen.getByText('LIVE FEED')).toBeInTheDocument();
    });
  });

  it('shows no alerts message when empty', async () => {
    mockApiFetch.mockResolvedValue({ data: [], pagination: { total: 0 } });
    renderPage();
    await waitFor(() => {
      expect(screen.getByText('No alerts found')).toBeInTheDocument();
    });
  });
});
