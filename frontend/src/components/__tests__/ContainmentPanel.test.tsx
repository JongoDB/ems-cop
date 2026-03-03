import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import ContainmentPanel from '../ContainmentPanel';

const mockApiFetch = vi.fn();
vi.mock('../../lib/api', () => ({
  apiFetch: (...args: unknown[]) => mockApiFetch(...args),
}));

vi.mock('lucide-react', () => ({
  Shield: () => <svg data-testid="shield-icon" />,
  RotateCcw: () => <svg data-testid="rotate-icon" />,
  Play: () => <svg data-testid="play-icon" />,
}));

describe('ContainmentPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders the title', async () => {
    mockApiFetch.mockResolvedValue({ data: [] });
    render(<ContainmentPanel incidentId="inc-1" />);
    expect(screen.getByText('CONTAINMENT ACTIONS')).toBeInTheDocument();
  });

  it('renders the action type selector', async () => {
    mockApiFetch.mockResolvedValue({ data: [] });
    render(<ContainmentPanel incidentId="inc-1" />);
    expect(screen.getByText('ACTION TYPE')).toBeInTheDocument();
  });

  it('renders the execute button', async () => {
    mockApiFetch.mockResolvedValue({ data: [] });
    render(<ContainmentPanel incidentId="inc-1" />);
    expect(screen.getByText('EXECUTE')).toBeInTheDocument();
  });

  it('shows empty state when no actions exist', async () => {
    mockApiFetch.mockResolvedValue({ data: [] });
    render(<ContainmentPanel incidentId="inc-1" />);
    await waitFor(() => {
      expect(screen.getByText('No containment actions yet')).toBeInTheDocument();
    });
  });

  it('renders existing actions', async () => {
    mockApiFetch.mockResolvedValue({
      data: [
        {
          id: 'act-1',
          action_type: 'block_ip',
          target: { ip: '10.0.0.1' },
          status: 'completed',
          executed_at: '2024-01-01T00:00:00Z',
          rolled_back_at: null,
        },
      ],
    });
    render(<ContainmentPanel incidentId="inc-1" />);
    await waitFor(() => {
      expect(screen.getByText('Block IP')).toBeInTheDocument();
    });
  });
});
