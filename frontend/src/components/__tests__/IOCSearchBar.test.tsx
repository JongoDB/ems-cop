import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import IOCSearchBar from '../IOCSearchBar';

const mockApiFetch = vi.fn();
vi.mock('../../lib/api', () => ({
  apiFetch: (...args: unknown[]) => mockApiFetch(...args),
}));

vi.mock('lucide-react', () => ({
  Search: () => <svg data-testid="search-icon" />,
}));

describe('IOCSearchBar', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders search input', () => {
    render(<IOCSearchBar />);
    expect(screen.getByPlaceholderText('Search IOCs (min 3 chars)...')).toBeInTheDocument();
  });

  it('renders type filter dropdown', () => {
    render(<IOCSearchBar />);
    expect(screen.getByText('All Types')).toBeInTheDocument();
  });

  it('renders with custom className', () => {
    const { container } = render(<IOCSearchBar className="test-class" />);
    expect(container.firstChild).toHaveClass('test-class');
  });

  it('renders all IOC type options', () => {
    render(<IOCSearchBar />);
    expect(screen.getByText('IP Address')).toBeInTheDocument();
    expect(screen.getByText('Domain')).toBeInTheDocument();
    expect(screen.getByText('Hash (MD5)')).toBeInTheDocument();
    expect(screen.getByText('Hash (SHA256)')).toBeInTheDocument();
    expect(screen.getByText('URL')).toBeInTheDocument();
    expect(screen.getByText('Email')).toBeInTheDocument();
  });
});
