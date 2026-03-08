import { useEffect, useRef } from 'react'

export default function AudioVisualizer({ stream, color = '#22c55e', height = 40, label }) {
  const canvasRef = useRef(null)
  const colorRef = useRef(color)
  colorRef.current = color

  useEffect(() => {
    if (!stream) return

    let audioCtx
    try {
      audioCtx = new AudioContext()
    } catch (err) {
      console.warn('AudioVisualizer: failed to create AudioContext', err)
      return
    }
    if (audioCtx.state === 'suspended') audioCtx.resume()

    const source = audioCtx.createMediaStreamSource(stream)
    const analyser = audioCtx.createAnalyser()
    analyser.fftSize = 256
    source.connect(analyser)
    // intentionally NOT connecting to audioCtx.destination to avoid echo

    const bufferLength = analyser.frequencyBinCount
    const dataArray = new Uint8Array(bufferLength)
    let rafId
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')

    const draw = () => {
      rafId = requestAnimationFrame(draw)
      if (!canvasRef.current) return
      const rect = canvas.getBoundingClientRect()
      const dpr = window.devicePixelRatio || 1
      const displayW = Math.round(rect.width * dpr)
      const displayH = Math.round(rect.height * dpr)
      if (canvas.width !== displayW || canvas.height !== displayH) {
        canvas.width = displayW
        canvas.height = displayH
        ctx.scale(dpr, dpr)
      }
      const w = rect.width
      const h = rect.height

      analyser.getByteFrequencyData(dataArray)
      ctx.clearRect(0, 0, w, h)

      const barCount = Math.min(bufferLength, 64)
      const barWidth = w / barCount
      for (let i = 0; i < barCount; i++) {
        const barHeight = (dataArray[i] / 255) * h
        ctx.fillStyle = colorRef.current
        ctx.fillRect(i * barWidth, h - barHeight, barWidth - 1, barHeight)
      }
    }

    draw()

    return () => {
      cancelAnimationFrame(rafId)
      source.disconnect()
      audioCtx.close()
    }
  }, [stream])

  return (
    <div className="audio-visualizer">
      {label && <span className="visualizer-label">{label}</span>}
      <canvas
        ref={canvasRef}
        style={{ width: '100%', height }}
        className="visualizer-canvas"
      />
    </div>
  )
}
