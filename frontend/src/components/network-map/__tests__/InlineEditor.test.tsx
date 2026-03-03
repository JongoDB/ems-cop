import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { InlineText } from '../InlineEditor';

// Mock lucide-react
vi.mock('lucide-react', () => ({
  Pencil: ({ size }: { size: number }) => (
    <svg data-testid="pencil-icon" width={size} height={size} />
  ),
}));

describe('InlineText', () => {
  const mockOnSave = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    mockOnSave.mockResolvedValue(undefined);
  });

  it('renders current value as text', () => {
    render(<InlineText value="Hello World" onSave={mockOnSave} />);

    expect(screen.getByText('Hello World')).toBeInTheDocument();
  });

  it('renders placeholder when value is empty', () => {
    render(<InlineText value="" onSave={mockOnSave} placeholder="Enter value" />);

    expect(screen.getByText('Enter value')).toBeInTheDocument();
  });

  it('renders default "empty" placeholder when value is empty and no placeholder given', () => {
    render(<InlineText value="" onSave={mockOnSave} />);

    expect(screen.getByText('empty')).toBeInTheDocument();
  });

  it('shows pencil icon (hidden by default, visible on hover)', () => {
    render(<InlineText value="Test" onSave={mockOnSave} />);

    expect(screen.getByTestId('pencil-icon')).toBeInTheDocument();
  });

  it('does not show pencil icon when disabled', () => {
    render(<InlineText value="Test" onSave={mockOnSave} disabled />);

    expect(screen.queryByTestId('pencil-icon')).not.toBeInTheDocument();
  });

  it('switches to edit mode on click', async () => {
    const user = userEvent.setup();
    render(<InlineText value="Test Value" onSave={mockOnSave} />);

    await user.click(screen.getByText('Test Value'));

    // Should now show an input with the value
    const input = screen.getByDisplayValue('Test Value');
    expect(input).toBeInTheDocument();
    expect(input.tagName).toBe('INPUT');
  });

  it('does not switch to edit mode when disabled', async () => {
    const user = userEvent.setup();
    render(<InlineText value="Test Value" onSave={mockOnSave} disabled />);

    await user.click(screen.getByText('Test Value'));

    // Should still show text, not input
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    expect(screen.getByText('Test Value')).toBeInTheDocument();
  });

  it('calls onSave with new value on Enter key', async () => {
    const user = userEvent.setup();
    render(<InlineText value="Original" onSave={mockOnSave} />);

    await user.click(screen.getByText('Original'));

    const input = screen.getByDisplayValue('Original');
    await user.clear(input);
    await user.type(input, 'Updated');
    await user.keyboard('{Enter}');

    await waitFor(() => {
      expect(mockOnSave).toHaveBeenCalledWith('Updated');
    });
  });

  it('calls onSave with new value on blur', async () => {
    const user = userEvent.setup();
    render(
      <div>
        <InlineText value="Original" onSave={mockOnSave} />
        <button>Other</button>
      </div>
    );

    await user.click(screen.getByText('Original'));

    const input = screen.getByDisplayValue('Original');
    await user.clear(input);
    await user.type(input, 'Blurred');
    await user.click(screen.getByText('Other'));

    await waitFor(() => {
      expect(mockOnSave).toHaveBeenCalledWith('Blurred');
    });
  });

  it('cancels edit on Escape key without calling onSave', async () => {
    const user = userEvent.setup();
    render(<InlineText value="Original" onSave={mockOnSave} />);

    await user.click(screen.getByText('Original'));

    const input = screen.getByDisplayValue('Original');
    await user.clear(input);
    await user.type(input, 'Changed');
    await user.keyboard('{Escape}');

    expect(mockOnSave).not.toHaveBeenCalled();
    // Should return to text display with original value
    expect(screen.getByText('Original')).toBeInTheDocument();
  });

  it('does not call onSave when value is unchanged', async () => {
    const user = userEvent.setup();
    render(<InlineText value="Same" onSave={mockOnSave} />);

    await user.click(screen.getByText('Same'));

    const input = screen.getByDisplayValue('Same');
    await user.keyboard('{Enter}');

    expect(mockOnSave).not.toHaveBeenCalled();
  });

  it('does not call onSave when trimmed value is empty', async () => {
    const user = userEvent.setup();
    render(<InlineText value="Test" onSave={mockOnSave} />);

    await user.click(screen.getByText('Test'));

    const input = screen.getByDisplayValue('Test');
    await user.clear(input);
    await user.type(input, '   ');
    await user.keyboard('{Enter}');

    expect(mockOnSave).not.toHaveBeenCalled();
  });

  it('trims whitespace before saving', async () => {
    const user = userEvent.setup();
    render(<InlineText value="Original" onSave={mockOnSave} />);

    await user.click(screen.getByText('Original'));

    const input = screen.getByDisplayValue('Original');
    await user.clear(input);
    await user.type(input, '  Trimmed Value  ');
    await user.keyboard('{Enter}');

    await waitFor(() => {
      expect(mockOnSave).toHaveBeenCalledWith('Trimmed Value');
    });
  });

  it('returns to text display after successful save', async () => {
    const user = userEvent.setup();
    render(<InlineText value="Before" onSave={mockOnSave} />);

    await user.click(screen.getByText('Before'));

    const input = screen.getByDisplayValue('Before');
    await user.clear(input);
    await user.type(input, 'After');
    await user.keyboard('{Enter}');

    await waitFor(() => {
      expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    });
  });

  it('stays in edit mode when onSave throws', async () => {
    const user = userEvent.setup();
    mockOnSave.mockRejectedValueOnce(new Error('Save failed'));

    render(<InlineText value="Original" onSave={mockOnSave} />);

    await user.click(screen.getByText('Original'));

    const input = screen.getByDisplayValue('Original');
    await user.clear(input);
    await user.type(input, 'WillFail');
    await user.keyboard('{Enter}');

    await waitFor(() => {
      expect(mockOnSave).toHaveBeenCalledWith('WillFail');
    });

    // Should still be in edit mode (input visible)
    await waitFor(() => {
      expect(screen.getByDisplayValue('WillFail')).toBeInTheDocument();
    });
  });
});
