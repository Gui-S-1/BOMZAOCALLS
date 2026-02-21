import { useEffect, useMemo, useRef, useState, useCallback } from 'react'
import { supabase } from './supabase'

const ALLOWED_USERS = {
  kaziin: { password: 'bomzao123', displayName: 'kaziin' },
  gui: { password: 'bomzao321', displayName: 'gui' }
}

const SIGNAL_CHANNEL = 'voice-global'

const ICE_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
  { urls: 'stun:stun2.l.google.com:19302' },
  { urls: 'stun:stun3.l.google.com:19302' },
  { urls: 'stun:stun4.l.google.com:19302' }
]

const normalize = (v) => v.trim().toLowerCase().replace(/\s+/g, '')

function App() {
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [user, setUser] = useState(null)
  const [error, setError] = useState('')
  const [status, setStatus] = useState('Desconectado')
  const [connected, setConnected] = useState(false)
  const [micMuted, setMicMuted] = useState(false)
  const [camOff, setCamOff] = useState(false)
  const [sharing, setSharing] = useState(false)
  const [peerState, setPeerState] = useState('')

  const channelRef = useRef(null)
  const pcRef = useRef(null)
  const localStreamRef = useRef(null)
  const screenStreamRef = useRef(null)
  const remoteVideoRef = useRef(null)
  const localVideoRef = useRef(null)
  const candidateQueue = useRef([])
  const makingOffer = useRef(false)
  const selfIdRef = useRef(null)
  const userRef = useRef(null)

  useEffect(() => { userRef.current = user }, [user])

  const selfId = useMemo(() => {
    if (!user) return null
    const id = `${user.displayName}-${Date.now()}-${Math.random().toString(16).slice(2)}`
    selfIdRef.current = id
    return id
  }, [user])

  useEffect(() => {
    return () => { void cleanup() }
  }, [])

  /* ───── LOGIN ───── */
  const login = (e) => {
    e.preventDefault()
    setError('')
    const u = normalize(username)
    const p = normalize(password)
    const found = ALLOWED_USERS[u]
    if (!found || normalize(found.password) !== p) {
      setError('Usuário ou senha inválidos')
      return
    }
    setUser(found)
    setStatus('Logado. Entre no canal para falar.')
  }

  /* ───── SIGNALING ───── */
  const sendSignal = useCallback(async (type, data) => {
    if (!channelRef.current || !selfIdRef.current) return
    await channelRef.current.send({
      type: 'broadcast',
      event: 'signal',
      payload: {
        type,
        payload: data,
        from: selfIdRef.current,
        username: userRef.current?.displayName,
        ts: Date.now()
      }
    })
  }, [])

  /* ───── PEER CONNECTION ───── */
  const createPeer = useCallback(() => {
    const peer = new RTCPeerConnection({ iceServers: ICE_SERVERS })

    peer.onicecandidate = ({ candidate }) => {
      if (candidate) sendSignal('candidate', { candidate })
    }

    peer.ontrack = (e) => {
      if (remoteVideoRef.current && e.streams[0]) {
        remoteVideoRef.current.srcObject = e.streams[0]
      }
    }

    peer.oniceconnectionstatechange = () => {
      const s = peer.iceConnectionState
      setPeerState(s)
      if (s === 'connected' || s === 'completed') {
        setStatus('Conectado — voz e vídeo em tempo real')
      } else if (s === 'disconnected') {
        setStatus('Conexão instável — reconectando...')
      } else if (s === 'failed') {
        setStatus('Conexão falhou — tente reconectar')
        peer.restartIce()
      }
    }

    peer.onnegotiationneeded = async () => {
      try {
        makingOffer.current = true
        const offer = await peer.createOffer()
        if (peer.signalingState !== 'stable') return
        await peer.setLocalDescription(offer)
        await sendSignal('offer', { offer: peer.localDescription })
      } catch { } finally {
        makingOffer.current = false
      }
    }

    if (localStreamRef.current) {
      localStreamRef.current.getTracks().forEach((track) => {
        peer.addTrack(track, localStreamRef.current)
      })
    }

    pcRef.current = peer
    return peer
  }, [sendSignal])

  const flushCandidates = useCallback(async () => {
    const pc = pcRef.current
    if (!pc || !pc.remoteDescription) return
    while (candidateQueue.current.length > 0) {
      const c = candidateQueue.current.shift()
      try { await pc.addIceCandidate(new RTCIceCandidate(c)) } catch { }
    }
  }, [])

  /* ───── HANDLE INCOMING SIGNALS ───── */
  const handleSignal = useCallback(async ({ payload }) => {
    if (!payload || payload.from === selfIdRef.current) return

    if (payload.type === 'join') {
      const polite = selfIdRef.current < payload.from
      if (!polite) {
        const peer = pcRef.current || createPeer()
        const offer = await peer.createOffer()
        await peer.setLocalDescription(offer)
        await sendSignal('offer', { offer: peer.localDescription })
      }
      return
    }

    if (payload.type === 'offer') {
      const polite = selfIdRef.current < payload.from
      const pc = pcRef.current || createPeer()
      const collision = makingOffer.current || pc.signalingState !== 'stable'
      if (!polite && collision) return

      await pc.setRemoteDescription(new RTCSessionDescription(payload.payload.offer))
      await flushCandidates()
      const answer = await pc.createAnswer()
      await pc.setLocalDescription(answer)
      await sendSignal('answer', { answer: pc.localDescription })
      return
    }

    if (payload.type === 'answer') {
      if (!pcRef.current) return
      try {
        await pcRef.current.setRemoteDescription(new RTCSessionDescription(payload.payload.answer))
        await flushCandidates()
      } catch { }
      return
    }

    if (payload.type === 'candidate') {
      if (!pcRef.current || !pcRef.current.remoteDescription) {
        candidateQueue.current.push(payload.payload.candidate)
      } else {
        try { await pcRef.current.addIceCandidate(new RTCIceCandidate(payload.payload.candidate)) } catch { }
      }
    }
  }, [createPeer, flushCandidates, sendSignal])

  /* ───── CONNECT ───── */
  const startCall = async () => {
    try {
      setError('')
      setStatus('Obtendo câmera e microfone...')

      localStreamRef.current = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        video: { width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 30, max: 60 } }
      })

      if (localVideoRef.current) {
        localVideoRef.current.srcObject = localStreamRef.current
      }

      setStatus('Entrando no canal...')

      const channel = supabase.channel(SIGNAL_CHANNEL, {
        config: { broadcast: { self: false }, presence: { key: selfId } }
      })

      channel.on('broadcast', { event: 'signal' }, handleSignal)

      await channel.subscribe(async (state) => {
        if (state === 'SUBSCRIBED') {
          setStatus('No canal — aguardando outro usuário...')
          setConnected(true)
          await sendSignal('join', { ready: true })
        }
      })

      channelRef.current = channel
    } catch (err) {
      setStatus('Erro ao entrar no canal')
      setError(err.message || 'Falha ao iniciar chamada')
      await cleanup()
    }
  }

  /* ───── MUTE / CAMERA ───── */
  const toggleMic = () => {
    if (!localStreamRef.current) return
    const next = !micMuted
    localStreamRef.current.getAudioTracks().forEach((t) => { t.enabled = !next })
    setMicMuted(next)
  }

  const toggleCam = () => {
    if (!localStreamRef.current) return
    const next = !camOff
    localStreamRef.current.getVideoTracks().forEach((t) => { t.enabled = !next })
    setCamOff(next)
  }

  /* ───── SCREEN SHARE ───── */
  const startScreenShare = async () => {
    try {
      const screen = await navigator.mediaDevices.getDisplayMedia({
        video: { width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 30 } },
        audio: false
      })
      screenStreamRef.current = screen
      const screenTrack = screen.getVideoTracks()[0]

      if (pcRef.current) {
        const sender = pcRef.current.getSenders().find((s) => s.track?.kind === 'video')
        if (sender) await sender.replaceTrack(screenTrack)
      }

      if (localVideoRef.current) localVideoRef.current.srcObject = screen

      screenTrack.onended = () => stopScreenShare()
      setSharing(true)
    } catch (err) {
      if (err.name !== 'NotAllowedError') setError('Erro ao compartilhar tela: ' + err.message)
    }
  }

  const stopScreenShare = async () => {
    if (screenStreamRef.current) {
      screenStreamRef.current.getTracks().forEach((t) => t.stop())
      screenStreamRef.current = null
    }
    if (localStreamRef.current && pcRef.current) {
      const camTrack = localStreamRef.current.getVideoTracks()[0]
      if (camTrack) {
        const sender = pcRef.current.getSenders().find((s) => s.track?.kind === 'video' || s.track === null)
        if (sender) await sender.replaceTrack(camTrack)
      }
    }
    if (localVideoRef.current && localStreamRef.current) localVideoRef.current.srcObject = localStreamRef.current
    setSharing(false)
  }

  /* ───── DISCONNECT ───── */
  const cleanup = async () => {
    setConnected(false)
    setSharing(false)
    setMicMuted(false)
    setCamOff(false)
    setPeerState('')
    candidateQueue.current = []

    if (screenStreamRef.current) {
      screenStreamRef.current.getTracks().forEach((t) => t.stop())
      screenStreamRef.current = null
    }
    if (pcRef.current) {
      pcRef.current.onicecandidate = null
      pcRef.current.ontrack = null
      pcRef.current.oniceconnectionstatechange = null
      pcRef.current.onnegotiationneeded = null
      pcRef.current.close()
      pcRef.current = null
    }
    if (localStreamRef.current) {
      localStreamRef.current.getTracks().forEach((t) => t.stop())
      localStreamRef.current = null
    }
    if (channelRef.current) {
      await supabase.removeChannel(channelRef.current)
      channelRef.current = null
    }
    if (remoteVideoRef.current) remoteVideoRef.current.srcObject = null
    if (localVideoRef.current) localVideoRef.current.srcObject = null

    if (userRef.current) setStatus('Desconectado do canal')
    else setStatus('Desconectado')
  }

  const logout = async () => {
    await cleanup()
    setUser(null)
    setUsername('')
    setPassword('')
    setError('')
  }

  /* ───── RENDER: LOGIN ───── */
  if (!user) {
    return (
      <main className="page">
        <section className="card">
          <h1>BOMZAO CALLS</h1>
          <p className="subtitle">Login</p>
          <form onSubmit={login} className="form">
            <label>
              Usuário
              <input
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                placeholder="kaziin ou gui"
                autoComplete="username"
              />
            </label>
            <label>
              Senha
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="Digite sua senha"
                autoComplete="current-password"
              />
            </label>
            {error && <p className="error">{error}</p>}
            <button type="submit">Entrar</button>
          </form>
        </section>
      </main>
    )
  }

  /* ───── RENDER: CALL ───── */
  return (
    <main className="page">
      <section className="card wide">
        <div className="topBar">
          <h1>BOMZAO CALLS</h1>
          <div className="topRight">
            <span className="userLabel">{user.displayName}</span>
            <button onClick={logout} className="secondary small">Sair</button>
          </div>
        </div>

        <div className="channelBox">
          <div className="channelHeader">
            <h2>Canal de Voz e Vídeo</h2>
            <span className={'statusBadge ' + (peerState === 'connected' || peerState === 'completed' ? 'online' : '')}>
              {status}
            </span>
          </div>

          <div className="videoGrid">
            <div className="videoCard">
              <p>Você {sharing ? '(Tela)' : ''}</p>
              <video ref={localVideoRef} autoPlay muted playsInline />
            </div>
            <div className="videoCard">
              <p>Remoto</p>
              <video ref={remoteVideoRef} autoPlay playsInline />
            </div>
          </div>

          <div className="controls">
            {!connected ? (
              <button onClick={startCall} className="ctrlBtn connect">Conectar</button>
            ) : (
              <>
                <button onClick={toggleMic} className={'ctrlBtn ' + (micMuted ? 'danger' : '')}>
                  {micMuted ? 'Mic OFF' : 'Mic ON'}
                </button>
                <button onClick={toggleCam} className={'ctrlBtn ' + (camOff ? 'danger' : '')}>
                  {camOff ? 'Cam OFF' : 'Cam ON'}
                </button>
                {!sharing ? (
                  <button onClick={startScreenShare} className="ctrlBtn share">Compartilhar Tela</button>
                ) : (
                  <button onClick={stopScreenShare} className="ctrlBtn danger">Parar Tela</button>
                )}
                <button onClick={cleanup} className="ctrlBtn danger">Desconectar</button>
              </>
            )}
          </div>
        </div>

        {error && <p className="error">{error}</p>}
      </section>
    </main>
  )
}

export default App