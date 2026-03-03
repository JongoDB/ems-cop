import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import LoginPage from '../LoginPage';

// Track navigations
const mockNavigate = vi.fn();

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom');
  return {
    ...actual,
    useNavigate: () => mockNavigate,
  };
});

// Mock the auth store
const mockSetAuth = vi.fn();
vi.mock('../../stores/authStore', () => ({
  useAuthStore: (selector: (s: Record<string, unknown>) => unknown) =>
    selector({ setAuth: mockSetAuth }),
}));

// Mock the api module
const mockApiFetch = vi.fn();
const mockSetAccessToken = vi.fn();
vi.mock('../../lib/api', () => ({
  apiFetch: (...args: unknown[]) => mockApiFetch(...args),
  setAccessToken: (...args: unknown[]) => mockSetAccessToken(...args),
}));

// Mock lucide-react Shield icon
vi.mock('lucide-react', () => ({
  Shield: () => <svg data-testid="shield-icon" />,
}));

// Mock version
vi.mock('../../version', () => ({
  APP_VERSION: 'v0.0.0-test',
}));

function renderLoginPage() {
  return render(
    <MemoryRouter>
      <LoginPage />
    </MemoryRouter>
  );
}

describe('LoginPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders the login form with username and password fields', () => {
    renderLoginPage();

    expect(screen.getByLabelText(/OPERATOR ID/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/PASSPHRASE/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /AUTHENTICATE/i })).toBeInTheDocument();
  });

  it('renders the EMS-COP title', () => {
    renderLoginPage();

    expect(screen.getByText('EMS-COP')).toBeInTheDocument();
    expect(screen.getByText('COMMON OPERATING PICTURE')).toBeInTheDocument();
  });

  it('renders both inputs as required', () => {
    renderLoginPage();

    const usernameInput = screen.getByLabelText(/OPERATOR ID/i);
    const passwordInput = screen.getByLabelText(/PASSPHRASE/i);

    expect(usernameInput).toBeRequired();
    expect(passwordInput).toBeRequired();
  });

  it('allows typing in username and password fields', async () => {
    const user = userEvent.setup();
    renderLoginPage();

    const usernameInput = screen.getByLabelText(/OPERATOR ID/i);
    const passwordInput = screen.getByLabelText(/PASSPHRASE/i);

    await user.type(usernameInput, 'admin');
    await user.type(passwordInput, 'changeme');

    expect(usernameInput).toHaveValue('admin');
    expect(passwordInput).toHaveValue('changeme');
  });

  it('calls apiFetch on form submit with credentials', async () => {
    const user = userEvent.setup();
    mockApiFetch.mockResolvedValueOnce({
      access_token: 'tok-123',
      refresh_token: 'ref-456',
      user: {
        id: 'u1',
        username: 'admin',
        display_name: 'Admin',
        email: 'admin@test.com',
        roles: ['admin'],
      },
    });

    renderLoginPage();

    await user.type(screen.getByLabelText(/OPERATOR ID/i), 'admin');
    await user.type(screen.getByLabelText(/PASSPHRASE/i), 'changeme');
    await user.click(screen.getByRole('button', { name: /AUTHENTICATE/i }));

    await waitFor(() => {
      expect(mockApiFetch).toHaveBeenCalledWith('/auth/login', {
        method: 'POST',
        body: JSON.stringify({ username: 'admin', password: 'changeme' }),
      });
    });
  });

  it('calls setAuth and navigates on successful login', async () => {
    const user = userEvent.setup();
    const mockUser = {
      id: 'u1',
      username: 'admin',
      display_name: 'Admin',
      email: 'admin@test.com',
      roles: ['admin'],
    };
    mockApiFetch.mockResolvedValueOnce({
      access_token: 'tok-123',
      refresh_token: 'ref-456',
      user: mockUser,
    });

    renderLoginPage();

    await user.type(screen.getByLabelText(/OPERATOR ID/i), 'admin');
    await user.type(screen.getByLabelText(/PASSPHRASE/i), 'changeme');
    await user.click(screen.getByRole('button', { name: /AUTHENTICATE/i }));

    await waitFor(() => {
      expect(mockSetAccessToken).toHaveBeenCalledWith('tok-123');
      expect(mockSetAuth).toHaveBeenCalledWith(mockUser, 'tok-123', 'ref-456');
      expect(mockNavigate).toHaveBeenCalledWith('/');
    });
  });

  it('shows error message on failed login', async () => {
    const user = userEvent.setup();
    mockApiFetch.mockRejectedValueOnce(new Error('Invalid credentials'));

    renderLoginPage();

    await user.type(screen.getByLabelText(/OPERATOR ID/i), 'admin');
    await user.type(screen.getByLabelText(/PASSPHRASE/i), 'wrong');
    await user.click(screen.getByRole('button', { name: /AUTHENTICATE/i }));

    await waitFor(() => {
      expect(screen.getByText('Invalid credentials')).toBeInTheDocument();
    });
  });

  it('shows AUTHENTICATING... text while submitting', async () => {
    const user = userEvent.setup();
    // Create a promise that we control
    let resolveLogin: (value: unknown) => void;
    mockApiFetch.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveLogin = resolve;
      })
    );

    renderLoginPage();

    await user.type(screen.getByLabelText(/OPERATOR ID/i), 'admin');
    await user.type(screen.getByLabelText(/PASSPHRASE/i), 'changeme');
    await user.click(screen.getByRole('button', { name: /AUTHENTICATE/i }));

    expect(screen.getByText('AUTHENTICATING...')).toBeInTheDocument();

    // Resolve to clean up
    resolveLogin!({
      access_token: 'tok',
      refresh_token: 'ref',
      user: { id: '1', username: 'a', display_name: 'A', email: 'a@a.com', roles: [] },
    });

    await waitFor(() => {
      expect(screen.queryByText('AUTHENTICATING...')).not.toBeInTheDocument();
    });
  });

  it('disables inputs while submitting', async () => {
    const user = userEvent.setup();
    let resolveLogin: (value: unknown) => void;
    mockApiFetch.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveLogin = resolve;
      })
    );

    renderLoginPage();

    await user.type(screen.getByLabelText(/OPERATOR ID/i), 'admin');
    await user.type(screen.getByLabelText(/PASSPHRASE/i), 'changeme');
    await user.click(screen.getByRole('button', { name: /AUTHENTICATE/i }));

    // After clicking, the form is submitting so inputs should be disabled
    await waitFor(() => {
      expect(screen.getByLabelText(/OPERATOR ID/i)).toBeDisabled();
      expect(screen.getByLabelText(/PASSPHRASE/i)).toBeDisabled();
    });

    resolveLogin!({
      access_token: 'tok',
      refresh_token: 'ref',
      user: { id: '1', username: 'a', display_name: 'A', email: 'a@a.com', roles: [] },
    });

    await waitFor(() => {
      expect(screen.getByLabelText(/OPERATOR ID/i)).not.toBeDisabled();
    });
  });

  it('renders the version string', () => {
    renderLoginPage();

    expect(screen.getByText('v0.0.0-test')).toBeInTheDocument();
  });
});
