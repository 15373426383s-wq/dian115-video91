import { getItem, playback, siteHeaders } from './catalog.js'
import { constantEqual, header, passStream, PluginError, publicURL } from './common.js'
import { webSecret } from './settings.js'

const playlistLimit = 2 * 1024 * 1024
const imageLimit = 5 * 1024 * 1024
const lifetime = 6 * 60 * 60 * 1000
const emptyHeaders = { 'Cache-Control': 'private, no-store', 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff' }
const responseHeaders = ['Content-Length', 'Content-Range', 'Accept-Ranges', 'Content-Type']

async function fetchMedia(ctx, value, request, kind) {
  let url = publicURL(value)
  const streaming = kind === 'segment'
  const method = kind !== 'image' && request.method === 'HEAD' ? 'HEAD' : 'GET'
  const range = header(request.headers, 'Range')
  if (streaming && range && !/^bytes=(?:\d{1,18}-\d{0,18}|-\d{1,18})$/i.test(range)) {
    throw new PluginError(416, '无效的媒体范围。')
  }
  const headers = { ...siteHeaders }
  if (streaming && range) headers.Range = range
  for (let hop = 0; hop < 5; hop++) {
    const options = {
      url: url.href, method, session: 'video91-media', headers, timeout_seconds: 20,
      follow_redirects: false,
    }
    const response = streaming
      ? await ctx.http.stream(options)
      : await ctx.http.request(kind === 'image'
        ? { ...options, max_bytes: imageLimit, response_type: 'base64' }
        : { ...options, max_bytes: playlistLimit })
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const next = header(response.headers, 'Location')
      if (streaming) await response.close().catch(() => {})
      if (!next) throw new PluginError(502, '媒体线路返回了空的跳转地址。')
      url = publicURL(next, url)
      continue
    }
    if (response.status !== 200 && response.status !== 206 && !(streaming && response.status === 416)) {
      if (streaming) await response.close().catch(() => {})
      if (response.status === 401 || response.status === 403) throw new PluginError(403, '媒体线路拒绝了播放请求。')
      if (response.status === 404) throw new PluginError(404, '媒体线路已失效，请重新打开影片。')
      if (response.status === 429) throw new PluginError(429, '媒体来源暂时限流。')
      throw new PluginError(502, '媒体线路暂时不可用。')
    }
    return { response, url }
  }
  throw new PluginError(502, '媒体线路跳转次数过多。')
}

function createPart(ctx, key, partBase, scope, exp, url, type) {
  const value = ctx.codec.base64Encode(JSON.stringify({ url: url.href, exp, scope, type }), { url: true })
  const sig = ctx.crypto.hmac('sha256', key, value, 'hex')
  const query = '?t=' + encodeURIComponent(value) + '.' + sig
  return partBase + (type === 'playlist' ? '.m3u8' : '') + query
}

function readPart(ctx, key, scope, value, now) {
  if (!key || typeof value !== 'string' || value.length > 8500) throw new PluginError(403, '播放链接无效或已过期。')
  const match = /^([\w=-]+)\.([a-f0-9]{64})$/.exec(value)
  if (!match || !constantEqual(ctx.crypto.hmac('sha256', key, match[1], 'hex'), match[2])) {
    throw new PluginError(403, '播放链接无效或已过期。')
  }
  let data
  try {
    const padded = match[1].replace(/-/g, '+').replace(/_/g, '/')
    data = JSON.parse(ctx.codec.utf8Decode(ctx.codec.base64Decode(padded.padEnd(Math.ceil(padded.length / 4) * 4, '='))))
  } catch { throw new PluginError(403, '播放链接无效。') }
  if (data?.scope !== scope || !['playlist', 'segment'].includes(data?.type) || !Number.isFinite(data.exp)
    || data.exp <= now || data.exp > now + lifetime + 1000) throw new PluginError(403, '播放链接已过期。')
  return data
}

function isPlaylist(url) {
  return /\.m3u8?$/i.test(url.pathname)
}

export function rewritePlaylist(body, base, makeLink) {
  if (typeof body !== 'string' || !/^\uFEFF?#EXTM3U(?:\s|$)/.test(body)) {
    throw new PluginError(502, '媒体线路未返回有效的 HLS 清单。')
  }
  let variant = false
  return body.split(/\r?\n/).map(line => {
    const trimmed = line.trim()
    if (!trimmed) return line
    if (!trimmed.startsWith('#')) {
      const url = publicURL(trimmed, base)
      const type = variant || isPlaylist(url) ? 'playlist' : 'segment'
      variant = false
      return makeLink(url, type)
    }
    if (trimmed.startsWith('#EXT-X-STREAM-INF:')) variant = true
    const playlistTag = /^#EXT-X-(?:MEDIA|I-FRAME-STREAM-INF|IMAGE-STREAM-INF|RENDITION-REPORT):/.test(trimmed)
    return line.replace(/\b(URI|SERVER-URI)="([^"]*)"/g, (_, attribute, address) => {
      const url = publicURL(address, base)
      return attribute + '="' + makeLink(url, playlistTag || isPlaylist(url) ? 'playlist' : 'segment') + '"'
    })
  }).join('\n')
}

async function servePlaylist(ctx, address, request, scope, key, partBase, exp, headers) {
  const { response, url } = await fetchMedia(ctx, address, request, 'playlist')
  const resultHeaders = { ...emptyHeaders, ...headers, 'Content-Type': 'application/vnd.apple.mpegurl; charset=utf-8' }
  if (request.method === 'HEAD') return { status: 200, headers: resultHeaders }
  return { status: 200, headers: resultHeaders,
    body: rewritePlaylist(response.body, url, (child, type) => createPart(ctx, key, partBase, scope, exp, child, type)) }
}

export function webPartBase(ctx) {
  return ctx.server.hookPath.replace(/\/$/, '') + '/hls/part'
}

export async function serveWebPlaylist(ctx, request, id, line) {
  const key = await webSecret(ctx, true)
  return serveVideo(ctx, request, id, line, 'web', key, webPartBase(ctx))
}

export async function serveVideo(ctx, request, id, line, scope, key, partBase, headers = {}) {
  const { variants } = await playback(ctx, id)
  const address = variants[line]
  if (!address) throw new PluginError(404, '这个影片没有可用的播放线路。')
  return servePlaylist(ctx, address, request, scope, key, partBase, Date.now() + lifetime, headers)
}

export async function servePart(ctx, request, scope, key, partBase, headers = {}) {
  const data = readPart(ctx, key, scope, request.query?.t, Date.now())
  if (data.type === 'playlist') return servePlaylist(ctx, data.url, request, scope, key, partBase, data.exp, headers)
  const { response } = await fetchMedia(ctx, data.url, request, 'segment')
  try {
    const mime = header(response.headers, 'Content-Type').split(';')[0].trim().toLowerCase()
    if (response.status !== 416 && mime && !/^(?:video\/|audio\/|application\/(?:octet-stream|mp4)$|text\/vtt$)/.test(mime)) {
      throw new PluginError(502, '媒体分片类型无效。')
    }
    return await passStream(ctx, response, request, responseHeaders, {
      'Content-Type': 'application/octet-stream', ...headers,
    })
  } finally {
    await response.close().catch(() => {})
  }
}

function imageType(ctx, body) {
  if (!body) return ''
  const bytes = ctx.codec.base64Decode(body.slice(0, 64))
  const startsWith = signature => signature.every((byte, index) => bytes[index] === byte)
  const text = (start, end) => String.fromCharCode(...bytes.slice(start, end))
  if (startsWith([0xff, 0xd8, 0xff])) return 'image/jpeg'
  if (startsWith([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png'
  if (['GIF87a', 'GIF89a'].includes(text(0, 6))) return 'image/gif'
  if (text(0, 4) === 'RIFF' && text(8, 12) === 'WEBP') return 'image/webp'
  const avifBrand = start => ['avif', 'avis'].includes(text(start, start + 4))
  if (text(4, 8) === 'ftyp' && (avifBrand(8) || [16, 20, 24, 28].some(avifBrand))) return 'image/avif'
  return ''
}

export async function serveImage(ctx, request, id, extra = {}) {
  const headers = { ...emptyHeaders, ...extra }
  const asset = (await getItem(ctx, id)).cover
  if (!asset) return { status: 404, headers }
  const { response } = await fetchMedia(ctx, asset, request, 'image')
  const body = response.body_base64
  const mime = imageType(ctx, body)
  if (!mime) return { status: 404, headers }
  headers['Content-Type'] = mime
  headers['Content-Length'] = String(body.length / 4 * 3 - (body.endsWith('==') ? 2 : Number(body.endsWith('='))))
  return { status: 200, headers, body_base64: request.method === 'HEAD' ? undefined : body }
}
