import {
  alloc,
  decodeBytes,
  encodeBytes,
  entries,
  fromEntries,
  fromJson,
  keys,
  libName,
  mkErr,
  noOp,
  toJson
} from './utils.js'

const TypedArray = Object.getPrototypeOf(Uint8Array)
const typeByteLimit = 12
const typeIndex = 0
const nonceIndex = typeIndex + typeByteLimit
const tagIndex = nonceIndex + 1
const progressIndex = tagIndex + 1
const payloadIndex = progressIndex + 1
const chunkSize = 16 * 2 ** 10 - payloadIndex
const oneByteMax = 0xff
const buffLowEvent = 'bufferedamountlow'

export default (onPeer, onSelfLeave) => {
  const peerMap = {}
  const actions = {}
  const pendingTransmissions = {}
  const pendingPongs = {}
  const pendingStreamMetas = {}
  const pendingTrackMetas = {}

  const iterate = (targets, f) =>
    (targets
      ? Array.isArray(targets)
        ? targets
        : [targets]
      : keys(peerMap)
    ).flatMap(id => {
      const peer = peerMap[id]

      if (!peer) {
        console.warn(`${libName}: no peer with id ${id} found`)
        return []
      }

      return f(id, peer)
    })

  const exitPeer = id => {
    if (!peerMap[id]) {
      return
    }

    delete peerMap[id]
    delete pendingTransmissions[id]
    delete pendingPongs[id]
    onPeerLeave(id)
  }

  const makeAction = type => {
    if (actions[type]) {
      return [
        actions[type].send,
        actions[type].setOnComplete,
        actions[type].setOnProgress
      ]
    }

    if (!type) {
      throw mkErr('action type argument is required')
    }

    const typeBytes = encodeBytes(type)

    if (typeBytes.byteLength > typeByteLimit) {
      throw mkErr(
        `action type string "${type}" (${typeBytes.byteLength}b) exceeds ` +
          `byte limit (${typeByteLimit}). Hint: choose a shorter name.`
      )
    }

    const typeBytesPadded = new Uint8Array(typeByteLimit)
    typeBytesPadded.set(typeBytes)

    let nonce = 0

    actions[type] = {
      onComplete: noOp,
      onProgress: noOp,

      setOnComplete: f => (actions[type] = {...actions[type], onComplete: f}),

      setOnProgress: f => (actions[type] = {...actions[type], onProgress: f}),

      send: async (data, targets, meta, onProgress) => {
        if (meta && typeof meta !== 'object') {
          throw mkErr('action meta argument must be an object')
        }

        const dataType = typeof data

        if (dataType === 'undefined') {
          throw mkErr('action data cannot be undefined')
        }

        const isJson = dataType !== 'string'
        const isBlob = data instanceof Blob
        const isBinary =
          isBlob || data instanceof ArrayBuffer || data instanceof TypedArray

        if (meta && !isBinary) {
          throw mkErr('action meta argument can only be used with binary data')
        }

        const buffer = isBinary
          ? new Uint8Array(isBlob ? await data.arrayBuffer() : data)
          : encodeBytes(isJson ? toJson(data) : data)

        const metaEncoded = meta ? encodeBytes(toJson(meta)) : null

        const chunkTotal =
          Math.ceil(buffer.byteLength / chunkSize) + (meta ? 1 : 0) || 1

        const chunks = alloc(chunkTotal, (_, i) => {
          const isLast = i === chunkTotal - 1
          const isMeta = meta && i === 0
          const chunk = new Uint8Array(
            payloadIndex +
              (isMeta
                ? metaEncoded.byteLength
                : isLast
                  ? buffer.byteLength -
                    chunkSize * (chunkTotal - (meta ? 2 : 1))
                  : chunkSize)
          )

          chunk.set(typeBytesPadded)
          chunk.set([nonce], nonceIndex)
          chunk.set(
            [isLast | (isMeta << 1) | (isBinary << 2) | (isJson << 3)],
            tagIndex
          )
          chunk.set(
            [Math.round(((i + 1) / chunkTotal) * oneByteMax)],
            progressIndex
          )
          chunk.set(
            meta
              ? isMeta
                ? metaEncoded
                : buffer.subarray((i - 1) * chunkSize, i * chunkSize)
              : buffer.subarray(i * chunkSize, (i + 1) * chunkSize),
            payloadIndex
          )

          return chunk
        })

        nonce = (nonce + 1) & oneByteMax

        return Promise.all(
          iterate(targets, async (id, peer) => {
            const chan = peer.channel
            let chunkN = 0

            while (chunkN < chunkTotal) {
              const chunk = chunks[chunkN]

              if (chan.bufferedAmount > chan.bufferedAmountLowThreshold) {
                await new Promise(res => {
                  const next = () => {
                    chan.removeEventListener(buffLowEvent, next)
                    res()
                  }

                  chan.addEventListener(buffLowEvent, next)
                })
              }

              if (!peerMap[id]) {
                break
              }

              peer.sendData(chunk)
              chunkN++
              onProgress?.(chunk[progressIndex] / oneByteMax, id, meta)
            }
          })
        )
      }
    }

    return [
      actions[type].send,
      actions[type].setOnComplete,
      actions[type].setOnProgress
    ]
  }

  const handleData = (id, data) => {
    const buffer = new Uint8Array(data)
    const type = decodeBytes(buffer.subarray(typeIndex, nonceIndex)).replaceAll(
      '\x00',
      ''
    )
    const [nonce] = buffer.subarray(nonceIndex, tagIndex)
    const [tag] = buffer.subarray(tagIndex, progressIndex)
    const [progress] = buffer.subarray(progressIndex, payloadIndex)
    const payload = buffer.subarray(payloadIndex)
    const isLast = !!(tag & 1)
    const isMeta = !!(tag & (1 << 1))
    const isBinary = !!(tag & (1 << 2))
    const isJson = !!(tag & (1 << 3))

    if (!actions[type]) {
      throw mkErr(`received message with unregistered type (${type})`)
    }

    pendingTransmissions[id] ||= {}
    pendingTransmissions[id][type] ||= {}

    const target = (pendingTransmissions[id][type][nonce] ||= {chunks: []})

    if (isMeta) {
      target.meta = fromJson(decodeBytes(payload))
    } else {
      target.chunks.push(payload)
    }

    actions[type].onProgress(progress / oneByteMax, id, target.meta)

    if (!isLast) {
      return
    }

    const full = new Uint8Array(
      target.chunks.reduce((a, c) => a + c.byteLength, 0)
    )

    target.chunks.reduce((a, c) => {
      full.set(c, a)
      return a + c.byteLength
    }, 0)

    delete pendingTransmissions[id][type][nonce]

    if (isBinary) {
      actions[type].onComplete(full, id, target.meta)
    } else {
      const text = decodeBytes(full)
      actions[type].onComplete(isJson ? fromJson(text) : text, id)
    }
  }

  const [sendPing, getPing] = makeAction('__91n6__')
  const [sendPong, getPong] = makeAction('__90n6__')
  const [sendSignal, getSignal] = makeAction('__516n4L__')
  const [sendStreamMeta, getStreamMeta] = makeAction('__57r34m__')
  const [sendTrackMeta, getTrackMeta] = makeAction('__7r4ck__')
  const [sendLeave, getLeave] = makeAction('__l34v3__')

  let onPeerJoin = noOp
  let onPeerLeave = noOp
  let onPeerStream = noOp
  let onPeerTrack = noOp

  onPeer((peer, id) => {
    if (peerMap[id]) {
      return
    }

    const onData = handleData.bind(null, id)

    peerMap[id] = peer

    peer.setHandlers({
      onData,
      onStream: stream => {
        onPeerStream(stream, id, pendingStreamMetas[id])
        delete pendingStreamMetas[id]
      },
      onTrack: (track, stream) => {
        onPeerTrack(track, stream, id, pendingTrackMetas[id])
        delete pendingTrackMetas[id]
      },
      onSignal: sdp => sendSignal(sdp, id),
      onClose: () => exitPeer(id)
    })

    onPeerJoin(id)
  })

  getPing((_, id) => sendPong('', id))

  getPong((_, id) => {
    pendingPongs[id]?.()
    delete pendingPongs[id]
  })

  getSignal((sdp, id) => peerMap[id]?.addSignal(sdp))

  getStreamMeta((meta, id) => (pendingStreamMetas[id] = meta))

  getTrackMeta((meta, id) => (pendingTrackMetas[id] = meta))

  getLeave((_, id) => exitPeer(id))

  return {
    makeAction,

    ping: async id => {
      if (!id) {
        throw mkErr('ping() must be called with target peer ID')
      }

      const start = Date.now()

      sendPing('', id)
      await new Promise(res => (pendingPongs[id] = res))
      return Date.now() - start
    },

    leave: async () => {
      await sendLeave('')
      await new Promise(res => setTimeout(res, 99))
      entries(peerMap).forEach(([id, peer]) => {
        peer.kill()
        delete peerMap[id]
      })
      onSelfLeave()
    },

    getPeers: () =>
      fromEntries(entries(peerMap).map(([id, peer]) => [id, peer.connection])),

    addStream: (stream, targets, meta) =>
      iterate(targets, async (id, peer) => {
        if (meta) {
          await sendStreamMeta(meta, id)
        }

        peer.addStream(stream)
      }),

    removeStream: (stream, targets) =>
      iterate(targets, (_, peer) => peer.removeStream(stream)),

    addTrack: (track, stream, targets, meta) =>
      iterate(targets, async (id, peer) => {
        if (meta) {
          await sendTrackMeta(meta, id)
        }

        peer.addTrack(track, stream)
      }),

    removeTrack: (track, stream, targets) =>
      iterate(targets, (_, peer) => peer.removeTrack(track, stream)),

    replaceTrack: (oldTrack, newTrack, stream, targets, meta) =>
      iterate(targets, async (id, peer) => {
        if (meta) {
          await sendTrackMeta(meta, id)
        }

        peer.replaceTrack(oldTrack, newTrack, stream)
      }),

    onPeerJoin: f => (onPeerJoin = f),

    onPeerLeave: f => (onPeerLeave = f),

    onPeerStream: f => (onPeerStream = f),

    onPeerTrack: f => (onPeerTrack = f)
  }
}
