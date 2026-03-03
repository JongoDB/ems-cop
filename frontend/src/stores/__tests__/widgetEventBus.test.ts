import { describe, it, expect, beforeEach } from 'vitest';
import { useWidgetEventBus } from '../widgetEventBus';

describe('widgetEventBus', () => {
  beforeEach(() => {
    useWidgetEventBus.setState({
      selectedSessionId: null,
      pendingCommand: null,
      pendingTicketNavigation: null,
      pendingEndpointNavigation: null,
      selectedVncTarget: null,
    });
  });

  describe('session selection (C2 Panel -> Terminal)', () => {
    it('has null selectedSessionId initially', () => {
      expect(useWidgetEventBus.getState().selectedSessionId).toBeNull();
    });

    it('selectSession sets the session ID', () => {
      useWidgetEventBus.getState().selectSession('session-abc');

      expect(useWidgetEventBus.getState().selectedSessionId).toBe('session-abc');
    });

    it('clearSession resets to null', () => {
      useWidgetEventBus.getState().selectSession('session-abc');
      useWidgetEventBus.getState().clearSession();

      expect(useWidgetEventBus.getState().selectedSessionId).toBeNull();
    });

    it('selectSession overwrites previous selection', () => {
      useWidgetEventBus.getState().selectSession('session-1');
      useWidgetEventBus.getState().selectSession('session-2');

      expect(useWidgetEventBus.getState().selectedSessionId).toBe('session-2');
    });
  });

  describe('command execution (Command Palette -> Terminal)', () => {
    it('has null pendingCommand initially', () => {
      expect(useWidgetEventBus.getState().pendingCommand).toBeNull();
    });

    it('executeCommand sets the pending command', () => {
      useWidgetEventBus.getState().executeCommand('ls -la');

      expect(useWidgetEventBus.getState().pendingCommand).toBe('ls -la');
    });

    it('consumeCommand returns and clears the pending command', () => {
      useWidgetEventBus.getState().executeCommand('whoami');

      const cmd = useWidgetEventBus.getState().consumeCommand();

      expect(cmd).toBe('whoami');
      expect(useWidgetEventBus.getState().pendingCommand).toBeNull();
    });

    it('consumeCommand returns null when no pending command', () => {
      const cmd = useWidgetEventBus.getState().consumeCommand();

      expect(cmd).toBeNull();
    });

    it('consumeCommand is idempotent (second call returns null)', () => {
      useWidgetEventBus.getState().executeCommand('pwd');

      useWidgetEventBus.getState().consumeCommand();
      const second = useWidgetEventBus.getState().consumeCommand();

      expect(second).toBeNull();
    });
  });

  describe('ticket navigation (Ticket Queue -> router)', () => {
    it('has null pendingTicketNavigation initially', () => {
      expect(useWidgetEventBus.getState().pendingTicketNavigation).toBeNull();
    });

    it('navigateToTicket sets pending ticket navigation', () => {
      useWidgetEventBus.getState().navigateToTicket('ticket-42');

      expect(useWidgetEventBus.getState().pendingTicketNavigation).toBe('ticket-42');
    });

    it('consumeTicketNavigation returns and clears', () => {
      useWidgetEventBus.getState().navigateToTicket('ticket-42');

      const id = useWidgetEventBus.getState().consumeTicketNavigation();

      expect(id).toBe('ticket-42');
      expect(useWidgetEventBus.getState().pendingTicketNavigation).toBeNull();
    });

    it('consumeTicketNavigation returns null when nothing pending', () => {
      expect(useWidgetEventBus.getState().consumeTicketNavigation()).toBeNull();
    });
  });

  describe('endpoint navigation (Endpoint Table -> router)', () => {
    it('has null pendingEndpointNavigation initially', () => {
      expect(useWidgetEventBus.getState().pendingEndpointNavigation).toBeNull();
    });

    it('navigateToEndpoint sets pending endpoint navigation', () => {
      useWidgetEventBus.getState().navigateToEndpoint('ep-99');

      expect(useWidgetEventBus.getState().pendingEndpointNavigation).toBe('ep-99');
    });

    it('consumeEndpointNavigation returns and clears', () => {
      useWidgetEventBus.getState().navigateToEndpoint('ep-99');

      const id = useWidgetEventBus.getState().consumeEndpointNavigation();

      expect(id).toBe('ep-99');
      expect(useWidgetEventBus.getState().pendingEndpointNavigation).toBeNull();
    });

    it('consumeEndpointNavigation returns null when nothing pending', () => {
      expect(useWidgetEventBus.getState().consumeEndpointNavigation()).toBeNull();
    });
  });

  describe('VNC target selection', () => {
    it('has null selectedVncTarget initially', () => {
      expect(useWidgetEventBus.getState().selectedVncTarget).toBeNull();
    });

    it('selectVncTarget sets host and port', () => {
      useWidgetEventBus.getState().selectVncTarget('10.101.1.10', 5900);

      expect(useWidgetEventBus.getState().selectedVncTarget).toEqual({
        host: '10.101.1.10',
        port: 5900,
      });
    });

    it('clearVncTarget resets to null', () => {
      useWidgetEventBus.getState().selectVncTarget('10.101.1.10', 5900);
      useWidgetEventBus.getState().clearVncTarget();

      expect(useWidgetEventBus.getState().selectedVncTarget).toBeNull();
    });
  });

  describe('cross-domain isolation', () => {
    it('session and command events do not interfere', () => {
      useWidgetEventBus.getState().selectSession('session-1');
      useWidgetEventBus.getState().executeCommand('ls');

      expect(useWidgetEventBus.getState().selectedSessionId).toBe('session-1');
      expect(useWidgetEventBus.getState().pendingCommand).toBe('ls');

      // Consuming command should not affect session
      useWidgetEventBus.getState().consumeCommand();
      expect(useWidgetEventBus.getState().selectedSessionId).toBe('session-1');
      expect(useWidgetEventBus.getState().pendingCommand).toBeNull();
    });

    it('ticket and endpoint navigations are independent', () => {
      useWidgetEventBus.getState().navigateToTicket('t-1');
      useWidgetEventBus.getState().navigateToEndpoint('e-1');

      expect(useWidgetEventBus.getState().consumeTicketNavigation()).toBe('t-1');
      expect(useWidgetEventBus.getState().pendingEndpointNavigation).toBe('e-1');

      expect(useWidgetEventBus.getState().consumeEndpointNavigation()).toBe('e-1');
    });
  });
});
