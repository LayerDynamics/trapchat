import { useState, useRef, useCallback } from 'react'
import { sendMedia, sendCanvas, MediaAssembler } from '../lib/media.js'

export function useMediaTransfer({ clientRef, keyRef, room, appendMessage }) {
  const [uploadProgress, setUploadProgress] = useState(null)
  const [downloadProgress, setDownloadProgress] = useState(null)
  const assemblerRef = useRef(null)
  const fileInputRef = useRef(null)
  const canvasRef = useRef(null)

  const initAssembler = useCallback(() => {
    if (assemblerRef.current) assemblerRef.current.destroy()
    assemblerRef.current = new MediaAssembler({
      onProgress: (transferId, received, total) => {
        setDownloadProgress({ transferId, received, total })
        if (received === total) {
          setTimeout(() => setDownloadProgress(null), 500)
        }
      },
    })
  }, [])

  const destroyAssembler = useCallback(() => {
    if (assemblerRef.current) {
      assemblerRef.current.destroy()
      assemblerRef.current = null
    }
  }, [])

  const handleMediaChunk = useCallback(async (data) => {
    if (!assemblerRef.current) return
    const result = await assemblerRef.current.handleChunk(data, keyRef.current)
    if (!result) return
    if (result.error) {
      appendMessage({
        id: crypto.randomUUID(),
        text: result.message,
        time: new Date().toLocaleTimeString(),
        error: true,
      })
    } else if (result.complete) {
      appendMessage({
        id: crypto.randomUUID(),
        time: new Date().toLocaleTimeString(),
        media: {
          url: result.url,
          mimeType: result.mimeType,
          fileName: result.fileName,
          fileSize: result.fileSize,
        },
      })
    }
  }, [keyRef, appendMessage])

  const handleFileSelect = useCallback(async (e) => {
    const file = e.target.files?.[0]
    if (!file) return
    e.target.value = ''

    const client = clientRef.current
    try {
      setUploadProgress({ sent: 0, total: 1 })
      const result = await sendMedia(client, keyRef.current, room, file, (sent, total) => {
        setUploadProgress({ sent, total })
      })
      setUploadProgress(null)
      appendMessage({
        id: crypto.randomUUID(),
        time: new Date().toLocaleTimeString(),
        own: true,
        media: {
          url: URL.createObjectURL(file),
          mimeType: result.mimeType,
          fileName: result.fileName,
          fileSize: file.size,
        },
      })
    } catch (err) {
      setUploadProgress(null)
      appendMessage({
        id: crypto.randomUUID(),
        text: `[upload failed: ${err.message}]`,
        time: new Date().toLocaleTimeString(),
        own: true,
        error: true,
      })
    }
  }, [clientRef, keyRef, room, appendMessage])

  const handleCanvasShare = useCallback(async () => {
    const canvas = canvasRef.current
    if (!canvas) return

    const client = clientRef.current
    try {
      setUploadProgress({ sent: 0, total: 1 })
      const result = await sendCanvas(client, keyRef.current, room, canvas, (sent, total) => {
        setUploadProgress({ sent, total })
      })
      setUploadProgress(null)
      appendMessage({
        id: crypto.randomUUID(),
        time: new Date().toLocaleTimeString(),
        own: true,
        media: {
          url: canvas.toDataURL('image/png'),
          mimeType: result.mimeType,
          fileName: result.fileName,
          fileSize: result.fileSize,
        },
      })
    } catch (err) {
      setUploadProgress(null)
      appendMessage({
        id: crypto.randomUUID(),
        text: `[canvas share failed: ${err.message}]`,
        time: new Date().toLocaleTimeString(),
        own: true,
        error: true,
      })
    }
  }, [clientRef, keyRef, room, appendMessage])

  const resetProgress = useCallback(() => {
    setUploadProgress(null)
    setDownloadProgress(null)
  }, [])

  return {
    uploadProgress,
    downloadProgress,
    assemblerRef,
    fileInputRef,
    canvasRef,
    initAssembler,
    destroyAssembler,
    handleMediaChunk,
    handleFileSelect,
    handleCanvasShare,
    resetProgress,
  }
}
