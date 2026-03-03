import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import SeverityBadge from '../SeverityBadge';

describe('SeverityBadge', () => {
  it('renders the severity text', () => {
    render(<SeverityBadge severity="critical" />);
    expect(screen.getByText('CRITICAL')).toBeInTheDocument();
  });

  it('renders all severity levels', () => {
    const severities = ['critical', 'high', 'medium', 'low', 'info'] as const;

    for (const severity of severities) {
      const { unmount } = render(<SeverityBadge severity={severity} />);
      expect(screen.getByText(severity.toUpperCase())).toBeInTheDocument();
      unmount();
    }
  });

  it('applies correct background class for critical', () => {
    render(<SeverityBadge severity="critical" />);
    const badge = screen.getByText('CRITICAL');
    expect(badge.className).toContain('bg-red-600');
    expect(badge.className).toContain('text-white');
  });

  it('applies correct background class for high', () => {
    render(<SeverityBadge severity="high" />);
    const badge = screen.getByText('HIGH');
    expect(badge.className).toContain('bg-orange-500');
    expect(badge.className).toContain('text-white');
  });

  it('applies correct background class for medium', () => {
    render(<SeverityBadge severity="medium" />);
    const badge = screen.getByText('MEDIUM');
    expect(badge.className).toContain('bg-yellow-500');
    expect(badge.className).toContain('text-black');
  });

  it('applies correct background class for low', () => {
    render(<SeverityBadge severity="low" />);
    const badge = screen.getByText('LOW');
    expect(badge.className).toContain('bg-blue-500');
    expect(badge.className).toContain('text-white');
  });

  it('applies correct background class for info', () => {
    render(<SeverityBadge severity="info" />);
    const badge = screen.getByText('INFO');
    expect(badge.className).toContain('bg-gray-500');
    expect(badge.className).toContain('text-white');
  });

  it('includes title attribute', () => {
    render(<SeverityBadge severity="high" />);
    const badge = screen.getByText('HIGH');
    expect(badge).toHaveAttribute('title', 'Severity: high');
  });

  it('applies custom className', () => {
    render(<SeverityBadge severity="low" className="my-custom" />);
    const badge = screen.getByText('LOW');
    expect(badge.className).toContain('my-custom');
  });
});
