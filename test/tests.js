import {test, expect} from '@playwright/test'
import chalk from 'chalk'

const testUrl = 'https://localhost:8080/test'

const onConsole = (strategy, pageN) => e =>
  console.log(
    `${emojis[strategy]} ${colorize[pageN - 1](strategy)} ${pageN}:`,
    e
  )

const onError = (strategy, pageN) => err =>
  console.log(`❌ error! ${emojis[strategy]} ${strategy} ${pageN}:`, err)

const colorize = ['magenta', 'yellow', 'blue', 'red', 'green', 'cyan'].map(
  k => chalk[k]
)

const concurrentRooms = 3
const relayRedundancy = 4

export default (strategy, config) =>
  test(`Trystero: ${strategy}`, async ({page, context, browserName}) => {
    const isRelayStrategy =
      strategy === 'torrent' || strategy === 'nostr' || strategy === 'mqtt'

    const roomConfig = {
      appId: `trystero-test-${Math.random()}`,
      password: '03d1p@M@@s' + Math.random(),
      ...(isRelayStrategy ? {relayRedundancy} : {}),
      ...config
    }

    const scriptUrl = `../dist/trystero-${strategy}.min.js`
    const page2 = await context.newPage()

    page.on('console', onConsole(strategy, 1))
    page2.on('console', onConsole(strategy, 2))
    page.on('pageerror', onError(strategy, 1))
    page2.on('pageerror', onError(strategy, 2))

    await page.goto(testUrl)
    await page2.goto(testUrl)

    const loadLib = async path => (window.trystero = await import(path))

    await page.evaluate(loadLib, scriptUrl)
    await page2.evaluate(loadLib, scriptUrl)

    // # selfId

    const getSelfId = () => window.trystero.selfId

    const selfId1 = await page.evaluate(getSelfId)
    const selfId2 = await page2.evaluate(getSelfId)

    expect(selfId1).toHaveLength(20)
    expect(selfId1).not.toEqual(selfId2)

    await Promise.all(
      Array(concurrentRooms)
        .fill()
        .map(async (_, roomNum) => {
          const roomNs = `testRoom-${roomNum}-${Math.random().toString().replace('.', '')}`

          // # onPeerJoin()

          const eagerPayload = 33

          const joinRoom = ([ns, config, payload]) => {
            window[ns] = window.trystero.joinRoom(config, ns)

            const [sendEager, getEager] = window[ns].makeAction('eager')

            return new Promise(res => {
              getEager((...args) => res(args))
              window[ns].onPeerJoin(peerId => sendEager(payload, peerId))
            })
          }

          const args = [roomNs, roomConfig, eagerPayload]
          const start = Date.now()
          const [peer2Data, peer1Data] = await Promise.all([
            page.evaluate(joinRoom, args),
            page2.evaluate(joinRoom, args)
          ])
          const joinTime = Date.now() - start
          const [peer2Id, peer1Id] = [peer2Data[1], peer1Data[1]]

          expect(peer1Data).toEqual([eagerPayload, selfId1])
          expect(peer2Data).toEqual([eagerPayload, selfId2])

          // # Idempotent joinRoom()

          const isRoomIdentical = await page.evaluate(
            ([ns, config]) =>
              window.trystero.joinRoom(config, ns) === window[ns],
            [roomNs, roomConfig]
          )

          expect(isRoomIdentical).toBe(true)

          if (browserName !== 'webkit') {
            // # onPeerStream()

            const onPeerStream = ([ns, streamMeta]) =>
              new Promise(res => {
                window[ns].onPeerStream((_, peerId, meta) =>
                  res({peerId, meta})
                )

                setTimeout(async () => {
                  const stream = await navigator.mediaDevices.getUserMedia({
                    audio: true,
                    video: true
                  })
                  window[ns].addStream(stream, null, streamMeta)
                  window.mediaStream = stream
                }, 1000)
              })

            const streamMeta = {id: Math.random()}
            const args = [roomNs, streamMeta]
            const [peer2StreamInfo, peer1StreamInfo] = await Promise.all([
              page.evaluate(onPeerStream, args),
              page2.evaluate(onPeerStream, args)
            ])

            expect(peer1StreamInfo).toEqual({peerId: peer1Id, meta: streamMeta})
            expect(peer2StreamInfo).toEqual({peerId: peer2Id, meta: streamMeta})
          }

          // # getPeers()

          const getPeerId = ns => Object.keys(window[ns].getPeers())[0]

          expect(await page.evaluate(getPeerId, roomNs)).toEqual(peer2Id)
          expect(await page2.evaluate(getPeerId, roomNs)).toEqual(peer1Id)

          // # ping()

          const ping = ([ns, id]) => window[ns].ping(id)

          expect(await page.evaluate(ping, [roomNs, peer2Id])).toBeLessThan(100)
          expect(await page2.evaluate(ping, [roomNs, peer1Id])).toBeLessThan(
            100
          )

          // # makeAction()

          const makeAction = ([ns, message]) => {
            const [sendMessage, getMessage] = window[ns].makeAction('message')

            return new Promise(res => {
              getMessage(res)
              setTimeout(() => sendMessage(message), 333)
            })
          }

          const message1 = Math.random()
          const message2 = Math.random()

          const [receivedMessage1, receivedMessage2] = await Promise.all([
            page.evaluate(makeAction, [roomNs, message1]),
            page2.evaluate(makeAction, [roomNs, message2])
          ])

          expect(receivedMessage1).toEqual(message2)
          expect(receivedMessage2).toEqual(message1)

          const empty = ''

          const [receivedMessage3, receivedMessage4] = await Promise.all([
            page.evaluate(makeAction, [roomNs, empty]),
            page2.evaluate(makeAction, [roomNs, empty])
          ])

          expect(receivedMessage3).toEqual(empty)
          expect(receivedMessage4).toEqual(empty)

          const makeBinaryAction = ([ns, message, metadata]) => {
            const [sendBinary, getBinary, onProgress] =
              window[ns].makeAction('binary')

            let senderPercent = 0
            let receiverPercent = 0
            let senderCallCount = 0
            let receiverCallCount = 0

            onProgress(p => {
              receiverPercent = p
              receiverCallCount++
            })

            return Promise.all([
              new Promise(res =>
                getBinary((payload, _, receivedMeta) =>
                  res([
                    new TextDecoder().decode(payload).slice(-message.length),
                    receivedMeta
                  ])
                )
              ),

              sendBinary(
                new TextEncoder().encode(message.repeat(50000)),
                null,
                metadata,
                p => {
                  senderPercent = p
                  senderCallCount++
                }
              )
            ]).then(([[payload, meta]]) => [
              payload,
              meta,
              senderPercent,
              senderCallCount,
              receiverPercent,
              receiverCallCount
            ])
          }

          const mockMeta = {foo: 'bar', baz: 'qux'}

          const payloads = await Promise.all([
            page.evaluate(makeBinaryAction, [roomNs, peer1Id, mockMeta]),
            page2.evaluate(makeBinaryAction, [roomNs, peer2Id, mockMeta])
          ])

          expect(payloads[0][0]).toEqual(peer2Id)
          expect(payloads[1][0]).toEqual(peer1Id)

          payloads.forEach(payload => {
            const [
              ,
              meta,
              senderPercent,
              senderCallCount,
              receiverPercent,
              receiverCallCount
            ] = payload
            expect(meta).toEqual(mockMeta)
            expect(senderPercent).toEqual(1)
            expect(senderCallCount).toEqual(63)
            expect(receiverPercent).toEqual(senderPercent)
            expect(receiverCallCount).toEqual(senderCallCount)
          })

          if (strategy === 'firebase') {
            // # getOccupants()

            expect(
              (
                await page.evaluate(
                  ([ns, config]) => window.trystero.getOccupants(config, ns),
                  [roomNs, roomConfig]
                )
              ).length
            ).toEqual(2)
          }

          if (isRelayStrategy) {
            // # getRelaySockets()

            expect(
              await page.evaluate(
                () => Object.keys(window.trystero.getRelaySockets()).length
              )
            ).toEqual(relayRedundancy)

            expect(
              await page.evaluate(() =>
                Object.entries(window.trystero.getRelaySockets()).every(
                  ([k, v]) => typeof k === 'string' && v instanceof WebSocket
                )
              )
            ).toBe(true)
          }

          // # onPeerLeave()

          const peer1onLeaveId = page.evaluate(
            ns => new Promise(window[ns].onPeerLeave),
            roomNs
          )

          await page2.evaluate(ns => window[ns].leave(), roomNs)

          expect(await peer1onLeaveId).toEqual(peer2Id)

          console.log(`  ⏱️    ${strategy.padEnd(12, ' ')} ${joinTime}ms`)
        })
    )
  })

const emojis = {
  nostr: '🐦',
  mqtt: '📡',
  torrent: '🌊',
  supabase: '⚡️',
  firebase: '🔥',
  ipfs: '🪐'
}
