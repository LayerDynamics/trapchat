import { useState, useRef, useCallback } from 'react'

const TYPING_THROTTLE_MS = 2000
const TYPING_EXPIRE_MS = 3500

export function useTypingIndicator({ clientRef, room, nickname }) {
  const [typingPeers, setTypingPeers] = useState(new Set())
  const typingTimersRef = useRef({})
  const lastTypingSentRef = useRef(0)

  const sendTypingIndicator = useCallback((typing) => {
    const client = clientRef.current
    if (!client || !room) return
    const now = Date.now()
    if (typing && now - lastTypingSentRef.current < TYPING_THROTTLE_MS) return
    lastTypingSentRef.current = now
    client.send('typing', room, JSON.stringify({ typing, nickname }))
  }, [clientRef, room, nickname])

  const handleTypingMessage = useCallback((data) => {
    try {
      const tp = typeof data.payload === 'string' ? JSON.parse(data.payload) : data.payload
      const senderId = data.id || 'unknown'
      const senderName = tp.nickname || senderId.slice(0, 8)
      if (tp.typing) {
        setTypingPeers(prev => new Set([...prev, senderName]))
        if (typingTimersRef.current[senderName]) {
          clearTimeout(typingTimersRef.current[senderName])
        }
        typingTimersRef.current[senderName] = setTimeout(() => {
          setTypingPeers(prev => {
            const next = new Set(prev)
            next.delete(senderName)
            return next
          })
          delete typingTimersRef.current[senderName]
        }, TYPING_EXPIRE_MS)
      } else {
        setTypingPeers(prev => {
          const next = new Set(prev)
          next.delete(senderName)
          return next
        })
        if (typingTimersRef.current[senderName]) {
          clearTimeout(typingTimersRef.current[senderName])
          delete typingTimersRef.current[senderName]
        }
      }
    } catch {
      // ignore malformed typing payload
    }
  }, [])

  const clearTyping = useCallback(() => {
    Object.values(typingTimersRef.current).forEach(clearTimeout)
    typingTimersRef.current = {}
    setTypingPeers(new Set())
  }, [])

  const typingText = typingPeers.size > 0
    ? typingPeers.size === 1
      ? `${[...typingPeers][0]} is typing...`
      : `${[...typingPeers].join(', ')} are typing...`
    : ''

  return { typingPeers, typingText, sendTypingIndicator, handleTypingMessage, clearTyping }
}
