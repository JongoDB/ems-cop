import { useEffect } from 'react'
import { useSocketStore } from '../stores/socketStore'

export function useSocket(topic: string) {
  const subscribe = useSocketStore(s => s.subscribe)
  const unsubscribe = useSocketStore(s => s.unsubscribe)
  const connected = useSocketStore(s => s.connected)
  const events = useSocketStore(s => s.getEvents(topic))

  useEffect(() => {
    subscribe(topic)
    return () => unsubscribe(topic)
  }, [topic, subscribe, unsubscribe])

  return { events, connected }
}
