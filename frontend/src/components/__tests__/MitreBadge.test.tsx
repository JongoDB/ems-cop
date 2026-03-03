import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import MitreBadge from '../MitreBadge';

describe('MitreBadge', () => {
  it('renders technique IDs', () => {
    render(<MitreBadge techniques={['T1566', 'T1059']} />);
    expect(screen.getByText('T1566')).toBeInTheDocument();
    expect(screen.getByText('T1059')).toBeInTheDocument();
  });

  it('renders nothing when techniques is empty', () => {
    const { container } = render(<MitreBadge techniques={[]} />);
    expect(container.innerHTML).toBe('');
  });

  it('creates correct link for a technique', () => {
    render(<MitreBadge techniques={['T1566']} />);
    const link = screen.getByText('T1566');
    expect(link.tagName).toBe('A');
    expect(link).toHaveAttribute('href', 'https://attack.mitre.org/techniques/T1566/');
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
  });

  it('creates correct link for a sub-technique (dots to slashes)', () => {
    render(<MitreBadge techniques={['T1566.001']} />);
    const link = screen.getByText('T1566.001');
    expect(link).toHaveAttribute('href', 'https://attack.mitre.org/techniques/T1566/001/');
  });

  it('applies purple styling classes', () => {
    render(<MitreBadge techniques={['T1059']} />);
    const link = screen.getByText('T1059');
    expect(link.className).toContain('bg-purple-100');
    expect(link.className).toContain('text-purple-800');
  });

  it('includes title attribute', () => {
    render(<MitreBadge techniques={['T1059']} />);
    const link = screen.getByText('T1059');
    expect(link).toHaveAttribute('title', 'MITRE ATT&CK: T1059');
  });

  it('applies custom className', () => {
    const { container } = render(<MitreBadge techniques={['T1566']} className="test-class" />);
    expect(container.firstChild).toHaveClass('test-class');
  });

  it('renders multiple techniques', () => {
    render(<MitreBadge techniques={['T1566', 'T1059', 'T1071.001']} />);
    expect(screen.getByText('T1566')).toBeInTheDocument();
    expect(screen.getByText('T1059')).toBeInTheDocument();
    expect(screen.getByText('T1071.001')).toBeInTheDocument();
  });
});
