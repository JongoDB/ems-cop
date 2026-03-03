import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import PlaybookProgress from '../PlaybookProgress';

const mockApiFetch = vi.fn();
vi.mock('../../lib/api', () => ({
  apiFetch: (...args: unknown[]) => mockApiFetch(...args),
}));

vi.mock('lucide-react', () => ({
  CheckCircle: () => <svg data-testid="check-circle" />,
  XCircle: () => <svg data-testid="x-circle" />,
  Circle: () => <svg data-testid="circle" />,
  Loader: () => <svg data-testid="loader" />,
}));

describe('PlaybookProgress', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('shows loading state', () => {
    mockApiFetch.mockReturnValue(new Promise(() => {}));
    render(<PlaybookProgress executionId="exec-1" />);
    expect(screen.getByText('Loading playbook...')).toBeInTheDocument();
  });

  it('shows not found when execution fails', async () => {
    mockApiFetch.mockRejectedValue(new Error('Not found'));
    render(<PlaybookProgress executionId="exec-1" />);
    await waitFor(() => {
      expect(screen.getByText('Playbook execution not found')).toBeInTheDocument();
    });
  });

  it('renders stages', async () => {
    mockApiFetch.mockResolvedValue({
      id: 'exec-1',
      playbook_id: 'pb-1',
      stages: [
        { name: 'Detect', status: 'completed' },
        { name: 'Contain', status: 'running' },
        { name: 'Eradicate', status: 'pending' },
      ],
      status: 'running',
      started_at: '2024-01-01T00:00:00Z',
    });
    render(<PlaybookProgress executionId="exec-1" />);
    await waitFor(() => {
      expect(screen.getByText('Detect')).toBeInTheDocument();
      expect(screen.getByText('Contain')).toBeInTheDocument();
      expect(screen.getByText('Eradicate')).toBeInTheDocument();
    });
  });
});
