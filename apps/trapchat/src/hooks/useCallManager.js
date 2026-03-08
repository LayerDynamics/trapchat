import { useState, useRef, useCallback, useEffect } from 'react'

async function requestMediaPermissions(type) {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error('Media devices not available. Ensure you are using HTTPS or localhost.')
  }
  try {
    return await navigator.mediaDevices.getUserMedia({
      audio: true,
      video: type === 'video',
    })
  } catch (err) {
    if (err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError') {
      throw new Error(
        type === 'video'
          ? 'Camera and microphone access was denied. Click the lock icon in your address bar to allow access, then try again.'
          : 'Microphone access was denied. Click the lock icon in your address bar to allow access, then try again.'
      )
    } else if (err.name === 'NotFoundError' || err.name === 'DevicesNotFoundError') {
      throw new Error(
        type === 'video'
          ? 'No camera or microphone found. Please connect a device and try again.'
          : 'No microphone found. Please connect one and try again.'
      )
    } else if (err.name === 'NotReadableError' || err.name === 'TrackStartError') {
      throw new Error('Your media device is already in use by another application.')
    }
    throw err
  }
}

export function useCallManager({ clientRef, activeRoom }) {
  // Bridge ref — set by parent after useWebRTCMesh initializes
  const peerMeshBridgeRef = useRef(null)
  const getPeerMeshRef = () => peerMeshBridgeRef.current?.current || new Map()
  const [callActive, setCallActive] = useState(false)
  const [callType, setCallType] = useState(null)
  const [localStream, setLocalStream] = useState(null)
  const [remoteStreams, setRemoteStreams] = useState(new Map())
  const [callMuted, setCallMuted] = useState(false)
  const [callVideoOff, setCallVideoOff] = useState(false)
  const localVideoRef = useRef(null)

  useEffect(() => {
    if (localVideoRef.current && localStream) {
      localVideoRef.current.srcObject = localStream
    }
  }, [localStream])

  const startCall = useCallback(async (type) => {
    if (callActive || !activeRoom) return
    try {
      const stream = await requestMediaPermissions(type)
      setLocalStream(stream)
      setCallActive(true)
      setCallType(type)

      const client = clientRef.current
      if (client?.connected) {
        client.send('call_offer', activeRoom, JSON.stringify({ callType: type }))
      }

      const mesh = getPeerMeshRef().get(activeRoom)
      if (mesh) {
        await mesh.broadcastStream(stream)
      }
    } catch (err) {
      console.error('Failed to start call:', err)
      alert(err.message || 'Failed to start call')
    }
  }, [callActive, activeRoom, clientRef])

  const endCall = useCallback(() => {
    if (localStream) {
      localStream.getTracks().forEach(t => t.stop())
      setLocalStream(null)
    }

    for (const mesh of getPeerMeshRef().values()) {
      mesh.removeAllStreams()
    }

    const client = clientRef.current
    if (client?.connected && activeRoom) {
      client.send('call_end', activeRoom, null)
    }

    for (const stream of remoteStreams.values()) {
      stream.getTracks().forEach(t => t.stop())
    }

    setCallActive(false)
    setCallType(null)
    setRemoteStreams(new Map())
    setCallMuted(false)
    setCallVideoOff(false)
  }, [localStream, activeRoom, remoteStreams, clientRef])

  const handleIncomingCall = useCallback(async (fromPeerId, room, payloadStr) => {
    let type = 'audio'
    try {
      const p = typeof payloadStr === 'string' ? JSON.parse(payloadStr) : payloadStr
      type = p?.callType || 'audio'
    } catch { /* ignore malformed payload */ }

    if (Notification.permission === 'granted') {
      try {
        new Notification('Incoming call', {
          body: `${type === 'video' ? 'Video' : 'Voice'} call in ${room}`,
          tag: 'incoming-call',
        })
      } catch { /* notifications may fail in some contexts */ }
    }

    try {
      const stream = await requestMediaPermissions(type)
      setLocalStream(stream)
      setCallActive(true)
      setCallType(type)

      const mesh = getPeerMeshRef().get(room)
      if (mesh) {
        await mesh.broadcastStream(stream)
      }

      const client = clientRef.current
      if (client?.connected) {
        client.send('call_answer', room, JSON.stringify({ callType: type }))
      }
    } catch (err) {
      console.error('Failed to get media for call:', err)
      alert(err.message || 'Failed to answer call — check your device permissions')
    }
  }, [clientRef])

  const toggleMute = useCallback(() => {
    if (localStream) {
      const audioTrack = localStream.getAudioTracks()[0]
      if (audioTrack) {
        audioTrack.enabled = !audioTrack.enabled
        setCallMuted(!audioTrack.enabled)
      }
    }
  }, [localStream])

  const toggleVideo = useCallback(() => {
    if (localStream) {
      const videoTrack = localStream.getVideoTracks()[0]
      if (videoTrack) {
        videoTrack.enabled = !videoTrack.enabled
        setCallVideoOff(!videoTrack.enabled)
      }
    }
  }, [localStream])

  return {
    callActive, callType, localStream, remoteStreams, setRemoteStreams,
    callMuted, callVideoOff, localVideoRef,
    startCall, endCall, handleIncomingCall,
    toggleMute, toggleVideo, peerMeshBridgeRef,
  }
}
