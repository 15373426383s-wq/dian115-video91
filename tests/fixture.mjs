import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, randomUUID } from 'node:crypto'
import { handle } from '../jobs/http.js'

const buffer = value => Buffer.from(value)
const format = (bytes, output = 'hex') => output === 'bytes' ? Uint8Array.from(bytes) : bytes.toString(output)
const hash = (method, data) => createHash(method).update(buffer(data)).digest()
const codec = {
  hexEncode: value => buffer(value).toString('hex'), utf8Decode: value => buffer(value).toString('utf8'),
  base64Decode: value => Uint8Array.from(Buffer.from(value, 'base64')),
  base64Encode: (value, options) => buffer(value).toString(options?.url ? 'base64url' : 'base64'),
  concat: (...parts) => Uint8Array.from(Buffer.concat(parts.map(buffer))),
}
export function encryptEnvelope(value) {
  const salt = Buffer.from('A1B2C3D4'), auth = Buffer.concat([Buffer.from('xxx'), salt])
  const block1 = hash('md5', auth), block2 = hash('md5', Buffer.concat([block1, auth]))
  const cipher = createCipheriv('aes-256-cbc', Buffer.concat([block1, block2]), hash('md5', Buffer.concat([block2, auth])))
  return Buffer.concat([Buffer.from('Salted__'), salt, cipher.update(JSON.stringify(value)), cipher.final()]).toString('base64')
}
const hls = 'https://media.example.com/a/main.m3u8'
export const cover = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACklEQVR4nGNgAAAAAgABSK+kcQAAAABJRU5ErkJggg=='
const defaultItems = [
  { id: '101', title: '城间的光', user: '示例片库', duration: 38, m3u8: hls,
    thumbnails: [], thumbNails: ['https://media.example.com/a/cover.jpg'] },
  { id: '102', title: '传媒示例', videoType: 'cvideo', m3u8: hls },
  { id: '103', title: '雨后的街道', user: '示例片库', duration: 35, m3u8: hls },
  { id: '104', title: '春日影集', user: '示例片库', duration: 55, m3u8: hls },
]
export function fixture({ override, items = defaultItems, manifest, segment } = {}) {
  const store = new Map(), requests = []
  let listener = null
  const ctx = {
    codec, crypto: { randomUUID, randomBytes: size => Uint8Array.from(randomBytes(size)),
      md5: (data, style) => format(hash('md5', data), style),
      sha256: (data, style) => format(hash('sha256', data), style),
      hmac: (method, key, data, style) => format(createHmac(method, buffer(key)).update(buffer(data)).digest(), style),
      aesDecrypt: ({ key, iv, data, output }) => {
        const cipher = createDecipheriv('aes-256-cbc', key, iv)
        return format(Buffer.concat([cipher.update(data), cipher.final()]), output)
      },
    },
    storage: { get: async key => store.get(key) ?? null, set: async (key, value) => store.set(key, structuredClone(value)) },
    server: { hookPath: '/api/extensions/v3/local.video91/hook',
      list: async () => listener ? [listener] : [],
      listen: async input => {
        if (input.port === 8098) { listener = null; throw new Error('address already in use') }
        listener = { ...input, running: true }
        return listener
      },
      close: async () => { listener = null },
    },
    http: {
      request: async req => {
        requests.push(req)
        const forced = override?.(req)
        if (forced) return forced
        const path = new URL(req.url).pathname
        if (path === '/a/cover.jpg') {
          return { status: 200, headers: { 'Content-Type': ['application/octet-stream'] }, body_base64: cover }
        }
        if (path !== '/js') {
          return { status: 200, headers: {}, body: manifest || '#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:1\n#EXTINF:1,\none.ts\n#EXT-X-ENDLIST\n' }
        }
        const input = req.json
        const page = String(input.page || input.url.match(/page=(\d+)/)?.[1] || '1')
        const results = input.url.startsWith('/sevenVideos/') ? items.find(item => item.id === input.url.split('/').at(-1)) || {}
          : page !== '1' ? [] : input.keywords ? items.filter(item => item.title.includes(input.keywords)) : items
        return { status: 200, body: JSON.stringify(results) }
      },
      stream: async req => {
        requests.push(req)
        const chunk = segment || Uint8Array.from([71, 0, 0, 1])
        const pieces = [chunk]
        return { status: req.headers.Range ? 206 : 200, headers: { 'Content-Type': ['video/mp2t'],
          'Content-Length': [String(chunk.length)], 'Content-Range': ['bytes 0-' + (chunk.length - 1) + '/' + chunk.length] },
          read: async () => pieces.shift() ?? null, close: async () => {} }
      },
    },
  }
  async function call(source, method, path, { headers = {}, query = {}, data } = {}) {
    let output
    const response = { stream: async meta => { output = { ...meta, chunks: [] }; return { write: async bytes => output.chunks.push(bytes) } } }
    const result = await handle({ ...ctx, response }, { source, method, path, headers, query, json: data })
    return result || { status: output.status, headers: output.headers, bytes: Buffer.concat(output.chunks) }
  }
  return { ctx, store, requests, call }
}
