import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import IncidentsPage from '../IncidentsPage';

const mockNavigate = vi.fn();
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom');
  return {
    ...actual,
    useNavigate: () => mockNavigate,
  };
});

const mockApiFetch = vi.fn();
vi.mock('../../lib/api', () => ({
  apiFetch: (...args: unknown[]) => mockApiFetch(...args),
}));

vi.mock('lucide-react', () => ({
  Search: () => <svg data-testid="search-icon" />,
  ChevronLeft: () => <svg data-testid="chevron-left" />,
  ChevronRight: () => <svg data-testid="chevron-right" />,
  Plus: () => <svg data-testid="plus" />,
  Clock: () => <svg data-testid="clock" />,
}));

function renderPage() {
  return render(
    <MemoryRouter>
      <IncidentsPage />
    </MemoryRouter>
  );
}

describe('IncidentsPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default mock: both incidents list and stats endpoints
    mockApiFetch.mockImplementation((path: string) => {
      if (path.includes('/incidents/stats')) {
        return Promise.resolve({
          total_open: 5,
          by_severity: { critical: 2, high: 3 },
          mttd_minutes: 15,
          mttr_minutes: 120,
        });
      }
      return Promise.resolve({
        data: [
          {
            id: '1',
            title: 'Test Incident',
            severity: 'critical',
            status: 'investigating',
            source: 'siem',
            mitre_techniques: ['T1059'],
            containment_status: 'partial',
            assignee_name: 'Analyst One',
            created_at: '2024-01-01T00:00:00Z',
          },
        ],
        pagination: { total: 1 },
      });
    });
  });

  it('renders the page title', async () => {
    renderPage();
    await waitFor(() => {
      expect(screen.getByText('INCIDENTS')).toBeInTheDocument();
    });
  });

  it('renders incidents table with data', async () => {
    renderPage();
    await waitFor(() => {
      expect(screen.getByText('Test Incident')).toBeInTheDocument();
    });
  });

  it('renders stats summary', async () => {
    renderPage();
    await waitFor(() => {
      expect(screen.getByText('OPEN INCIDENTS')).toBeInTheDocument();
      expect(screen.getByText('5')).toBeInTheDocument();
    });
  });

  it('renders MTTD and MTTR', async () => {
    renderPage();
    await waitFor(() => {
      expect(screen.getByText('MTTD')).toBeInTheDocument();
      expect(screen.getByText('15m')).toBeInTheDocument();
      expect(screen.getByText('MTTR')).toBeInTheDocument();
      expect(screen.getByText('2h 0m')).toBeInTheDocument();
    });
  });

  it('renders table headers', async () => {
    renderPage();
    await waitFor(() => {
      expect(screen.getByText('SEVERITY')).toBeInTheDocument();
      expect(screen.getByText('TITLE')).toBeInTheDocument();
      expect(screen.getByText('STATUS')).toBeInTheDocument();
      expect(screen.getByText('CONTAINMENT')).toBeInTheDocument();
      expect(screen.getByText('ASSIGNED')).toBeInTheDocument();
    });
  });

  it('renders severity badge for incidents', async () => {
    renderPage();
    await waitFor(() => {
      expect(screen.getByText('CRITICAL')).toBeInTheDocument();
    });
  });

  it('renders new incident button', async () => {
    renderPage();
    await waitFor(() => {
      expect(screen.getByText('NEW INCIDENT')).toBeInTheDocument();
    });
  });

  it('shows no incidents message when empty', async () => {
    mockApiFetch.mockImplementation((path: string) => {
      if (path.includes('/incidents/stats')) {
        return Promise.resolve({
          total_open: 0,
          by_severity: {},
          mttd_minutes: undefined,
          mttr_minutes: undefined,
        });
      }
      return Promise.resolve({ data: [], pagination: { total: 0 } });
    });
    renderPage();
    await waitFor(() => {
      expect(screen.getByText('No incidents found')).toBeInTheDocument();
    });
  });
});
