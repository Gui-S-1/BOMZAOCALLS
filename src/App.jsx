import { useEffect, useMemo, useRef, useState, useCallback } from 'react'
import { supabase } from './supabase'

/* ═══════════════ CONFIG ═══════════════ */
const USERS = {
  kaziin: { password: 'bomzao123', displayName: 'kaziin' },
  gui: { password: 'bomzao321', displayName: 'gui' }
}

const CHANNEL = 'bomzao-voice-v2'
const norm = (v) => v.trim().toLowerCase().replace(/\s+/g, '')

const RTC_CONFIG = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun.cloudflare.com:3478' },
    {
      urls: 'turn:openrelay.metered.ca:80',
      username: 'openrelayproject',
      credential: 'openrelayproject'
    },
    {
      urls: 'turn:openrelay.metered.ca:443',
      username: 'openrelayproject',
      credential: 'openrelayproject'
    },
    {
      urls: 'turn:openrelay.metered.ca:443?transport=tcp',
      username: 'openrelayproject',
      credential: 'openrelayproject'
    }
  ],
  iceCandidatePoolSize: 10
}

function log(...args) {
  console.log('[BOMZAO]', ...args)
}

/* ═══════════════ APP ═══════════════ */
function App() {
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [user, setUser] = useState(() => {
    try { const s = localStorage.getItem('bomzao_user'); return s ? JSON.parse(s) : null }
    catch { return null }
  })
  const [error, setError] = useState('')
  const [status, setStatus] = useState(() => {
    try { return localStorage.getItem('bomzao_user') ? 'Entre no canal para falar.' : '' }
    catch { return '' }
  })
  const [connected, setConnected] = useState(false)
  const [micMuted, setMicMuted] = useState(false)
  const [camOff, setCamOff] = useState(false)
  const [sharing, setSharing] = useState(false)
  const [peerState, setPeerState] = useState('')
  const [onlineUsers, setOnlineUsers] = useState([])
  const [hasVideo, setHasVideo] = useState(true)
  const [remoteUsername, setRemoteUsername] = useState('')

  const channelRef = useRef(null)
  const pcRef = useRef(null)
  const localStreamRef = useRef(null)
  const screenStreamRef = useRef(null)
  const remoteVideoRef = useRef(null)
  const remoteAudioRef = useRef(null)
  const localVideoRef = useRef(null)
  const candidateQ = useRef([])
  const makingOffer = useRef(false)
  const selfIdRef = useRef(null)
  const userRef = useRef(null)
  const politeRef = useRef(true)

  useEffect(() => { userRef.current = user }, [user])

  const selfId = useMemo(() => {
    if (!user) return null
    const id = `${user.displayName}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
    selfIdRef.current = id
    return id
  }, [user])

  useEffect(() => () => { void hangup() }, [])

  /* ─── LOGIN ─── */
  const login = (e) => {
    e.preventDefault()
    setError('')
    const found = USERS[norm(username)]
    if (!found || norm(found.password) !== norm(password)) {
      setError('Usuário ou senha inválidos')
      return
    }
    setUser(found)
    localStorage.setItem('bomzao_user', JSON.stringify(found))
    setStatus('Entre no canal para falar.')
  }

  /* ─── SIGNALING ─── */
  const send = useCallback(async (type, data) => {
    const ch = channelRef.current
    if (!ch || !selfIdRef.current) return
    log('>> send', type)
    await ch.send({
      type: 'broadcast',
      event: 'rtc',
      payload: { type, data, from: selfIdRef.current, user: userRef.current?.displayName, t: Date.now() }
    })
  }, [])

  /* ─── CREATE PEER ─── */
  const buildPeer = useCallback(() => {
    if (pcRef.current) {
      pcRef.current.close()
      pcRef.current = null
    }

    const pc = new RTCPeerConnection(RTC_CONFIG)
    log('peer created')

    // Add local tracks BEFORE any negotiation
    if (localStreamRef.current) {
      localStreamRef.current.getTracks().forEach((t) => {
        log('adding local track', t.kind)
        pc.addTrack(t, localStreamRef.current)
      })
    }

    pc.onicecandidate = ({ candidate }) => {
      if (candidate) send('ice', candidate)
    }

    pc.ontrack = (e) => {
      log('ontrack', e.track.kind, e.streams.length)
      const stream = e.streams[0]
      if (!stream) return

      // Always set video element
      if (remoteVideoRef.current) {
        remoteVideoRef.current.srcObject = stream
        remoteVideoRef.current.play().catch(() => {})
      }
      // Also set dedicated audio element for reliability
      if (remoteAudioRef.current) {
        remoteAudioRef.current.srcObject = stream
        remoteAudioRef.current.play().catch(() => {})
      }
    }

    pc.oniceconnectionstatechange = () => {
      const s = pc.iceConnectionState
      log('ice state:', s)
      setPeerState(s)
      if (s === 'connected' || s === 'completed') setStatus('Conectado')
      else if (s === 'disconnected') setStatus('Reconectando...')
      else if (s === 'failed') { setStatus('Falhou — reconectando...'); pc.restartIce() }
    }

    // Perfect negotiation: onnegotiationneeded
    pc.onnegotiationneeded = async () => {
      try {
        makingOffer.current = true
        log('negotiationneeded → creating offer')
        await pc.setLocalDescription()
        send('description', pc.localDescription)
      } catch (err) { log('nego err', err) }
      finally { makingOffer.current = false }
    }

    pcRef.current = pc
    return pc
  }, [send])

  /* ─── FLUSH ICE QUEUE ─── */
  const flush = useCallback(async () => {
    const pc = pcRef.current
    if (!pc?.remoteDescription) return
    while (candidateQ.current.length) {
      try { await pc.addIceCandidate(candidateQ.current.shift()) }
      catch { }
    }
  }, [])

  /* ─── HANDLE SIGNAL ─── */
  const onSignal = useCallback(async ({ payload: msg }) => {
    if (!msg || msg.from === selfIdRef.current) return
    log('<< recv', msg.type, 'from', msg.user)

    if (msg.user) setRemoteUsername(msg.user)

    // Join → we decide who is polite, create peer, let onnegotiationneeded fire
    if (msg.type === 'join') {
      politeRef.current = selfIdRef.current < msg.from
      log('polite?', politeRef.current)
      if (!pcRef.current) buildPeer()
      // Impolite side creates first offer via onnegotiationneeded (already fires after addTrack)
      // If peer already exists, force renegotiation
      if (pcRef.current && pcRef.current.signalingState === 'stable' && !politeRef.current) {
        const offer = await pcRef.current.createOffer()
        await pcRef.current.setLocalDescription(offer)
        send('description', pcRef.current.localDescription)
      }
      return
    }

    // SDP description (offer or answer)
    if (msg.type === 'description') {
      const desc = msg.data
      const pc = pcRef.current || buildPeer()
      const isOffer = desc.type === 'offer'
      const collision = isOffer && (makingOffer.current || pc.signalingState !== 'stable')

      if (collision && !politeRef.current) {
        log('ignoring colliding offer (impolite)')
        return
      }

      if (collision && politeRef.current) {
        log('rolling back (polite)')
        await pc.setLocalDescription({ type: 'rollback' })
      }

      log('setRemoteDescription', desc.type)
      await pc.setRemoteDescription(desc)
      await flush()

      if (isOffer) {
        log('creating answer')
        await pc.setLocalDescription()
        send('description', pc.localDescription)
      }
      return
    }

    // ICE candidate
    if (msg.type === 'ice') {
      if (!pcRef.current?.remoteDescription) {
        candidateQ.current.push(msg.data)
      } else {
        try { await pcRef.current.addIceCandidate(msg.data) } catch { }
      }
    }
  }, [buildPeer, flush, send])

  /* ─── CONNECT ─── */
  const joinChannel = async () => {
    try {
      setError('')
      setStatus('Acessando dispositivos...')

      let stream
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
          video: { width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 30 } }
        })
        setHasVideo(true)
      } catch {
        stream = await navigator.mediaDevices.getUserMedia({ audio: true })
        setHasVideo(false)
      }

      localStreamRef.current = stream
      if (localVideoRef.current) localVideoRef.current.srcObject = stream

      setStatus('Entrando no canal...')

      const ch = supabase.channel(CHANNEL, {
        config: { broadcast: { self: false }, presence: { key: selfId } }
      })

      ch.on('broadcast', { event: 'rtc' }, onSignal)

      ch.on('presence', { event: 'sync' }, () => {
        const ps = ch.presenceState()
        const names = [...new Set(Object.values(ps).flat().map((p) => p.username).filter(Boolean))]
        setOnlineUsers(names)
      })

      await ch.subscribe(async (s) => {
        if (s === 'SUBSCRIBED') {
          log('subscribed to channel')
          await ch.track({ username: userRef.current?.displayName, joinedAt: Date.now() })
          setConnected(true)
          setStatus('No canal — aguardando...')
          // Small delay to ensure presence is tracked before signaling
          setTimeout(() => send('join', { ready: true }), 300)
        }
      })

      channelRef.current = ch
    } catch (err) {
      setError(err.message || 'Erro')
      setStatus('Erro ao conectar')
      await hangup()
    }
  }

  /* ─── MIC / CAM ─── */
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

  /* ─── SCREEN SHARE ─── */
  const shareScreen = async () => {
    try {
      const screen = await navigator.mediaDevices.getDisplayMedia({
        video: { width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 30 } }
      })
      screenStreamRef.current = screen
      const vTrack = screen.getVideoTracks()[0]

      if (pcRef.current) {
        const sender = pcRef.current.getSenders().find((s) => s.track?.kind === 'video')
        if (sender) {
          await sender.replaceTrack(vTrack)
          log('replaced video track with screen')
        } else {
          // No video sender exists (audio-only) → add the screen track
          pcRef.current.addTrack(vTrack, screen)
          log('added screen track as new sender')
        }
      }

      if (localVideoRef.current) localVideoRef.current.srcObject = screen
      vTrack.onended = () => unshareScreen()
      setSharing(true)
    } catch (err) {
      if (err.name !== 'NotAllowedError') setError('Erro: ' + err.message)
    }
  }

  const unshareScreen = async () => {
    if (screenStreamRef.current) {
      screenStreamRef.current.getTracks().forEach((t) => t.stop())
      screenStreamRef.current = null
    }
    if (localStreamRef.current && pcRef.current) {
      const cam = localStreamRef.current.getVideoTracks()[0]
      if (cam) {
        const sender = pcRef.current.getSenders().find((s) => s.track?.kind === 'video' || !s.track)
        if (sender) await sender.replaceTrack(cam)
      }
    }
    if (localVideoRef.current && localStreamRef.current) localVideoRef.current.srcObject = localStreamRef.current
    setSharing(false)
  }

  /* ─── HANGUP ─── */
  const hangup = async () => {
    setConnected(false); setSharing(false); setMicMuted(false); setCamOff(false)
    setPeerState(''); setOnlineUsers([]); setHasVideo(true); setRemoteUsername('')
    candidateQ.current = []; makingOffer.current = false; politeRef.current = true

    ;[screenStreamRef, localStreamRef].forEach((ref) => {
      if (ref.current) { ref.current.getTracks().forEach((t) => t.stop()); ref.current = null }
    })

    if (pcRef.current) {
      pcRef.current.onicecandidate = null; pcRef.current.ontrack = null
      pcRef.current.oniceconnectionstatechange = null; pcRef.current.onnegotiationneeded = null
      pcRef.current.close(); pcRef.current = null
    }
    if (channelRef.current) { await supabase.removeChannel(channelRef.current); channelRef.current = null }
    if (remoteVideoRef.current) remoteVideoRef.current.srcObject = null
    if (remoteAudioRef.current) remoteAudioRef.current.srcObject = null
    if (localVideoRef.current) localVideoRef.current.srcObject = null

    if (userRef.current) setStatus('Desconectado')
    else setStatus('')
  }

  const logout = async () => {
    await hangup(); setUser(null); localStorage.removeItem('bomzao_user')
    setUsername(''); setPassword(''); setError('')
  }

  /* ═══════════════ RENDER ═══════════════ */
  if (!user) {
    return (
      <main className="loginPage">
        <div className="loginCard">
          <div className="loginLogo">
            <div className="logoIcon">B</div>
            <h1>BOMZAO CALLS</h1>
            <p className="loginSub">Conecte-se para entrar no canal</p>
          </div>
          <form onSubmit={login} className="loginForm">
            <div className="inputGroup">
              <input value={username} onChange={(e) => setUsername(e.target.value)}
                placeholder="Usuário" autoComplete="username" />
            </div>
            <div className="inputGroup">
              <input type="password" value={password} onChange={(e) => setPassword(e.target.value)}
                placeholder="Senha" autoComplete="current-password" />
            </div>
            {error && <p className="err">{error}</p>}
            <button type="submit" className="loginBtn">Entrar</button>
          </form>
          <p className="loginFooter">Acesso exclusivo para membros</p>
        </div>
      </main>
    )
  }

  const isLive = peerState === 'connected' || peerState === 'completed'

  return (
    <main className="appPage">
      {/* Hidden audio element — guarantees audio always plays */}
      <audio ref={remoteAudioRef} autoPlay playsInline style={{ display: 'none' }} />

      {/* SIDEBAR */}
      <aside className="sidebar">
        <div className="sideTop">
          <div className="logoSmall">B</div>
          <span className="brandSmall">BOMZAO</span>
        </div>

        <div className="channelList">
          <p className="channelLabel">CANAL DE VOZ</p>
          <div className={'channelItem ' + (connected ? 'active' : '')}>
            <span className="channelIcon">🔊</span>
            <span>Geral</span>
            {isLive && <span className="liveDot" />}
          </div>
          {onlineUsers.length > 0 && (
            <div className="memberList">
              {onlineUsers.map((u) => (
                <div key={u} className="member">
                  <span className="memberDot" />
                  <span>{u}</span>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="sideBottom">
          <div className="userInfo">
            <div className="avatar">{user.displayName[0].toUpperCase()}</div>
            <span className="uname">{user.displayName}</span>
          </div>
          <button onClick={logout} className="logoutBtn">Sair</button>
        </div>
      </aside>

      {/* MAIN */}
      <section className="mainArea">
        <header className="mainHeader">
          <h2>🔊 Geral</h2>
          <span className={'badge ' + (isLive ? 'live' : '')}>{status}</span>
        </header>

        <div className="videoArea">
          <div className="vidBox">
            <video ref={localVideoRef} autoPlay muted playsInline />
            <span className="vidLabel">
              {user.displayName} {sharing ? '(Tela)' : ''} {!hasVideo && connected ? '(Áudio)' : ''}
            </span>
          </div>
          <div className="vidBox">
            <video ref={remoteVideoRef} autoPlay playsInline />
            <span className="vidLabel">{remoteUsername || '—'}</span>
          </div>
        </div>

        <div className="toolbar">
          {!connected ? (
            <button onClick={joinChannel} className="tbtn join">Conectar</button>
          ) : (
            <>
              <button onClick={toggleMic} className={'tbtn ' + (micMuted ? 'off' : 'on')}>
                {micMuted ? '🔇 Mutado' : '🎙️ Mic'}
              </button>
              <button onClick={toggleCam} className={'tbtn ' + (camOff ? 'off' : 'on')}>
                {camOff ? '📷 Cam Off' : '📹 Cam'}
              </button>
              {!sharing
                ? <button onClick={shareScreen} className="tbtn screen">🖥️ Tela</button>
                : <button onClick={unshareScreen} className="tbtn off">⏹️ Parar</button>
              }
              <button onClick={hangup} className="tbtn hang">✖ Sair</button>
            </>
          )}
        </div>

        {error && <p className="err">{error}</p>}
      </section>
    </main>
  )
}

export default App