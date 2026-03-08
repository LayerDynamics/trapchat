import { useRef, useCallback } from 'react'
import { PeerMesh } from '../lib/webrtc.js'

export function useWebRTCMesh({ clientRef, updateRoomState, setRemoteStreams }) {
  const peerMeshRef = useRef(new Map()) // room -> PeerMesh
  const prevPeerCountRef = useRef(new Map()) // room -> prevCount

  const makeSignalSender = useCallback((room, remotePeerId) => {
    return (signalPayload) => {
      const msg = JSON.stringify({
        id: crypto.randomUUID(), type: 'signal', room,
        to: remotePeerId, payload: JSON.stringify(signalPayload), timestamp: Date.now(),
      })
      const client = clientRef.current
      if (client?.connected) client.sendRaw(msg)
    }
  }, [clientRef])

  const createMesh = useCallback((room) => {
    const mesh = new PeerMesh({
      onMessage: (pid, d) => {
        try {
          const client = clientRef.current
          if (client) client.emitP2P('message', { ...JSON.parse(d), room })
        } catch { /* ignore parse errors */ }
      },
      onConnected: () => updateRoomState(room, (s) => ({ ...s, isP2P: true })),
      onDisconnected: () => updateRoomState(room, (s) => ({ ...s, isP2P: false })),
      onTrack: (pid, stream) => {
        setRemoteStreams(prev => new Map(prev).set(pid, stream))
      },
    })
    peerMeshRef.current.set(room, mesh)
    return mesh
  }, [clientRef, updateRoomState, setRemoteStreams])

  const handlePresenceMesh = useCallback(async (room, count, peers, selfId) => {
    const prevCount = prevPeerCountRef.current.get(room) || 0
    prevPeerCountRef.current.set(room, count)

    if (count === 2 && prevCount !== 2) {
      const pids = peers ? Object.keys(peers) : []
      const remotePid = pids.find(pid => pid !== selfId)
      if (selfId && remotePid && selfId < remotePid) {
        setTimeout(async () => {
          if (peerMeshRef.current.has(room)) return
          const mesh = createMesh(room)
          try {
            await mesh.addPeer(remotePid, makeSignalSender(room, remotePid), true)
          } catch (err) {
            console.error('WebRTC offer failed:', err)
            peerMeshRef.current.delete(room)
          }
        }, 500)
      }
    } else if (count !== 2 && peerMeshRef.current.has(room)) {
      peerMeshRef.current.get(room).closeAll()
      peerMeshRef.current.delete(room)
      updateRoomState(room, (s) => ({ ...s, isP2P: false }))
    }
  }, [createMesh, makeSignalSender, updateRoomState])

  const handleSignal = useCallback(async (data, msgRoom) => {
    const signalData = typeof data.payload === 'string' ? JSON.parse(data.payload) : data.payload
    const room = msgRoom

    let mesh = peerMeshRef.current.get(room)
    if (!mesh) {
      mesh = createMesh(room)
    }

    if (signalData.signalType === 'offer') {
      await mesh.addPeer(data.id, makeSignalSender(room, data.id), false)
      await mesh.handleSignal(data.id, signalData)
    } else {
      await mesh.handleSignal(data.id, signalData)
    }
  }, [createMesh, makeSignalSender])

  const cleanupRoom = useCallback((room) => {
    const mesh = peerMeshRef.current.get(room)
    if (mesh) {
      mesh.closeAll()
      peerMeshRef.current.delete(room)
    }
    prevPeerCountRef.current.delete(room)
  }, [])

  const cleanupAll = useCallback(() => {
    for (const mesh of peerMeshRef.current.values()) {
      mesh.closeAll()
    }
    peerMeshRef.current.clear()
    prevPeerCountRef.current.clear()
  }, [])

  return {
    peerMeshRef, makeSignalSender,
    handlePresenceMesh, handleSignal,
    cleanupRoom, cleanupAll,
  }
}
