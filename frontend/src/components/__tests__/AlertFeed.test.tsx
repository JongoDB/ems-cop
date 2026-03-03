import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import AlertFeed from '../AlertFeed';

const mockApiFetch = vi.fn();
vi.mock('../../lib/api', () => ({
  apiFetch: (...args: unknown[]) => mockApiFetch(...args),
}));

vi.mock('../../hooks/useSocket', () => ({
  useSocket: () => ({ events: [], connected: false }),
}));

vi.mock('lucide-react', () => ({
  ChevronDown: () => <svg data-testid="chevron-down" />,
  ChevronUp: () => <svg data-testid="chevron-up" />,
}));

describe('AlertFeed', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('shows loading state', () => {
    mockApiFetch.mockReturnValue(new Promise(() => {}));
    render(<AlertFeed />);
    expect(screen.getByText('Loading alerts...')).toBeInTheDocument();
  });

  it('shows empty state', async () => {
    mockApiFetch.mockResolvedValue({ data: [] });
    render(<AlertFeed />);
    await waitFor(() => {
      expect(screen.getByText('No alerts')).toBeInTheDocument();
    });
  });

  it('renders alerts', async () => {
    mockApiFetch.mockResolvedValue({
      data: [
        {
          id: '1',
          title: 'Suspicious Login',
          severity: 'high',
          source_system: 'siem',
          status: 'new',
          mitre_techniques: ['T1078'],
          created_at: '2024-01-01T12:00:00Z',
        },
      ],
    });
    render(<AlertFeed />);
    await waitFor(() => {
      expect(screen.getByText('Suspicious Login')).toBeInTheDocument();
      expect(screen.getByText('HIGH')).toBeInTheDocument();
      expect(screen.getByText('siem')).toBeInTheDocument();
      expect(screen.getByText('T1078')).toBeInTheDocument();
    });
  });
});
