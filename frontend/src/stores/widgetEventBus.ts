import { create } from 'zustand'

interface WidgetEventBus {
  // C2 Panel → Terminal: select a session
  selectedSessionId: string | null
  selectSession: (sessionId: string) => void
  clearSession: () => void

  // Command Palette → Terminal: execute a command
  pendingCommand: string | null
  executeCommand: (command: string) => void
  consumeCommand: () => string | null

  // Ticket Queue → router
  pendingTicketNavigation: string | null
  navigateToTicket: (ticketId: string) => void
  consumeTicketNavigation: () => string | null

  // Endpoint Table → router
  pendingEndpointNavigation: string | null
  navigateToEndpoint: (endpointId: string) => void
  consumeEndpointNavigation: () => string | null
}

export const useWidgetEventBus = create<WidgetEventBus>((set, get) => ({
  selectedSessionId: null,
  selectSession: (sessionId) => set({ selectedSessionId: sessionId }),
  clearSession: () => set({ selectedSessionId: null }),

  pendingCommand: null,
  executeCommand: (command) => set({ pendingCommand: command }),
  consumeCommand: () => {
    const cmd = get().pendingCommand
    if (cmd) set({ pendingCommand: null })
    return cmd
  },

  pendingTicketNavigation: null,
  navigateToTicket: (ticketId) => set({ pendingTicketNavigation: ticketId }),
  consumeTicketNavigation: () => {
    const id = get().pendingTicketNavigation
    if (id) set({ pendingTicketNavigation: null })
    return id
  },

  pendingEndpointNavigation: null,
  navigateToEndpoint: (endpointId) => set({ pendingEndpointNavigation: endpointId }),
  consumeEndpointNavigation: () => {
    const id = get().pendingEndpointNavigation
    if (id) set({ pendingEndpointNavigation: null })
    return id
  },
}))
