import { boundedInteger, PluginError, publicURL, videoId } from './common.js'
import { categories } from './categories.js'
const origins = [
  'https://v2.cdn199.com', 'https://v2.kekecdn.net', 'https://v2.luchu.org',
  'https://v2.madou.ws', 'https://v2.papapa.biz', 'https://v2.xiaoshuo.info', 'https://v2.xiaoshuo.la',
]
export const siteHeaders = {
  Origin: 'https://91porn.name',
  Referer: 'https://91porn.name/',
  'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Version/17.0 Mobile/15E148 Safari/604.1',
}

export function decodeEnvelope(ctx, value) {
  const bytes = ctx.codec.base64Decode(value)
  if (bytes.length < 32 || (bytes.length - 16) % 16
    || ctx.codec.utf8Decode(bytes.slice(0, 8)) !== 'Salted__') throw new Error('无效的来源响应')
  const salt = bytes.slice(8, 16)
  const input = ctx.codec.concat('xxx', salt)
  const first = ctx.crypto.md5(input, 'bytes')
  const second = ctx.crypto.md5(ctx.codec.concat(first, input), 'bytes')
  const iv = ctx.crypto.md5(ctx.codec.concat(second, input), 'bytes')
  const data = ctx.crypto.aesDecrypt({
    mode: 'cbc', padding: 'pkcs7', key: ctx.codec.concat(first, second), iv, data: bytes.slice(16), output: 'utf8',
  })
  return JSON.parse(data)
}

async function getDevice(ctx) {
  const existing = await ctx.storage.get('source-device')
  if (typeof existing === 'string') return existing
  const date = new Date().toISOString().slice(0, 19).replace(/\D/g, '')
  const device = 'U' + date + String(Math.floor(1000 + Math.random() * 9000))
  await ctx.storage.set('source-device', device)
  return device
}

async function catalogRequest(ctx, path, fields = {}) {
  const uuid = await getDevice(ctx)
  const preferred = await ctx.storage.get('source-mirror')
  const ordered = origins.includes(preferred) ? [preferred, ...origins.filter(item => item !== preferred)] : origins
  for (const base of ordered) {
    let response, envelope
    try {
      response = await ctx.http.request({
        url: base + '/js', method: 'POST', headers: siteHeaders, session: 'video91-source',
        json: { deviceInfo: {}, app: '91porn.name', isStandalone: false, theLink: 'novaluenull', uuid, url: path, version: '260901', ...fields },
        timeout_seconds: 5, max_bytes: 3 * 1024 * 1024, follow_redirects: false,
      })
      if (response.status >= 200 && response.status < 300) envelope = JSON.parse(response.body)
    } catch { continue }
    if (response.status === 429 || envelope?.blocked) throw new PluginError(429, '来源暂时限制了请求，请稍后再试。')
    if (response.status === 401 || response.status === 403) throw new PluginError(403, '来源拒绝了当前请求。')
    if (response.status === 404) throw new PluginError(404, '没有找到这个影片或目录。')
    if (!envelope || typeof envelope !== 'object') continue
    let result
    try { result = typeof envelope.r === 'string' ? decodeEnvelope(ctx, envelope.r) : envelope }
    catch { continue }
    if (result?.blocked) throw new PluginError(429, '来源暂时限制了请求，请稍后再试。')
    if (base !== preferred) await ctx.storage.set('source-mirror', base).catch(() => {})
    return result
  }
  throw new PluginError(502, '暂时无法读取影片来源。请检查 DIAN115 的网络设置后重试。')
}

function acceptedURL(value) {
  if (typeof value !== 'string' || !value.trim()) return ''
  try { return publicURL(value, 'https://91porn.name/').href } catch { return '' }
}

function text(value, max) {
  return typeof value === 'string' ? value.trim().slice(0, max) : ''
}

function mapRecord(raw) {
  if (!raw?.id) return null
  let id
  try { id = videoId(raw.id) } catch { return null }
  const thumb = [raw.thumbnails, raw.thumbNails].flat().map(acceptedURL).find(Boolean)
  const date = new Date(raw.createdTime)
  const length = Number(raw.duration)
  return {
    id, title: text(raw.title, 240) || '未命名影片', creator: text(raw.user, 80),
    duration: Number.isFinite(length) && length > 0 && length <= 86400 ? Math.floor(length) : 0,
    durationText: text(raw.durationStr, 24), date: Number.isFinite(date.getTime()) ? date.toISOString() : '',
    overview: text(raw.keywords_gem || raw.tags, 800), cover: thumb || '',
  }
}

function streams(raw) {
  return [...new Set([raw.m3u8, ...(Array.isArray(raw.m3u8s) ? raw.m3u8s : [])]
    .map(acceptedURL).filter(Boolean))].slice(0, 12)
}

function responseItems(value) {
  if (Array.isArray(value)) return value
  if (Array.isArray(value?.items)) return value.items
  if (Array.isArray(value?.data)) return value.data
  throw new PluginError(502, '来源返回的目录格式无法读取。')
}

export async function listPage(ctx, { source = 'recent', search = '', page = 1 } = {}) {
  if (!categories.some(item => item.id === source)) throw new PluginError(400, '分类无效。')
  if (typeof search !== 'string' || search.length > 120) throw new PluginError(400, '搜索词最多 120 个字符。')
  page = boundedInteger(page, 1, 1, 500)
  search = search.trim()
  const identity = JSON.stringify([source, search, page])
  const cacheKey = 'catalog:' + ctx.crypto.sha256(identity, 'hex').slice(0, 16)
  const cached = await ctx.storage.get(cacheKey)
  if (cached?.version === 2 && cached.identity === identity && cached.exp > Date.now()) return cached.result
  const raw = search
    ? await catalogRequest(ctx, '/searchSevenVideos', { page, keywords: search, filterCategory: 'all',
      filterTimeInDays: 'all', filterViews: 'all', filterDurationInMins: 'all', sortBy: 'time', keywordLogic: 'or' })
    : await catalogRequest(ctx, '/sevenVideos?page=' + page + '&type=' + encodeURIComponent(source))
  const items = responseItems(raw)
  const positions = Object.create(null)
  const results = []
  for (const [offset, record] of items.slice(0, 120).entries()) {
    const item = mapRecord(record)
    if (!item || Object.hasOwn(positions, item.id)) continue
    positions[item.id] = offset
    results.push(item)
  }
  const result = { items: results, positions, page, rawCount: items.length, hasMore: items.length > 0 && page < 500 }
  await ctx.storage.set(cacheKey, { version: 2, identity, exp: Date.now() + 90000, result }).catch(() => {})
  // 影片详情缓存与目录响应解耦：后台分批写入，主响应立即返回，避免翻页等待存储。
  ;(async () => {
    for (let offset = 0; offset < results.length; offset += 16) {
      await Promise.all(results.slice(offset, offset + 16).map(item => cacheItem(ctx, item)))
    }
  })()
  return result
}

function itemKey(ctx, id) {
  return 'film:' + ctx.crypto.sha256(id, 'hex').slice(0, 16)
}

function cacheItem(ctx, item) {
  return ctx.storage.set(itemKey(ctx, item.id), { item, exp: Date.now() + 600000 }).catch(() => {})
}

function detailKey(ctx, id) {
  return 'detail:' + ctx.crypto.sha256(id, 'hex').slice(0, 16)
}

export async function clearDetail(ctx, id) {
  // 写入已过期记录使其失效，兼容所有 storage 实现（含无 remove 的旧宿主）。
  await ctx.storage.set(detailKey(ctx, videoId(id)), { id, exp: 0 }).catch(() => {})
}

export async function detail(ctx, id) {
  id = videoId(id)
  const key = detailKey(ctx, id)
  const cached = await ctx.storage.get(key)
  if (cached?.id === id && cached.exp > Date.now()) return cached.result
  const response = await catalogRequest(ctx, '/sevenVideos/' + encodeURIComponent(id), { url_search: '' })
  const record = String(response?.data?.id || '') === id ? response.data : response
  if (!record?.id || String(record.id) !== id) throw new PluginError(404, '没有找到这个影片。')
  const item = mapRecord(record)
  if (!item) throw new PluginError(404, '没有找到这个影片。')
  const playbackDenied = record.canPlay === false || record.locked === true
  const result = { item, playbackDenied, variants: playbackDenied ? [] : streams(record) }
  ctx.storage.set(key, { id, exp: Date.now() + 120000, result }).catch(() => {})
  await cacheItem(ctx, item)
  return result
}

export async function playback(ctx, id) {
  const media = await detail(ctx, id)
  if (media.playbackDenied) throw new PluginError(403, '来源拒绝播放此影片。')
  if (!media.variants.length) throw new PluginError(404, '来源没有返回可用的播放线路。')
  return media
}

export async function getItem(ctx, id) {
  id = videoId(id)
  const cached = await ctx.storage.get(itemKey(ctx, id))
  if (cached?.item?.id === id && cached.exp > Date.now()) return cached.item
  return (await detail(ctx, id)).item
}

export function viewItem(item) {
  const { cover, ...view } = item
  return { ...view, hasCover: Boolean(cover) }
}
