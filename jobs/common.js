export class PluginError extends Error {
  constructor(status, message) {
    super(message)
    this.status = status
  }
}

export function json(data, status = 200) {
  return { status, headers: { 'Cache-Control': 'no-store' }, json: data }
}

export function header(headers, name) {
  const key = Object.keys(headers || {}).find(item => item.toLowerCase() === name.toLowerCase())
  const value = key ? headers[key] : undefined
  return String(Array.isArray(value) ? value[0] || '' : value || '')
}

export function videoId(value) {
  const id = String(value || '')
  if (!/^[a-zA-Z0-9_-]{1,100}$/.test(id) || id.startsWith('folder-')) {
    throw new PluginError(400, '影片编号无效。')
  }
  return id
}

export function boundedInteger(value, fallback, low, high) {
  const number = Number(value ?? fallback)
  return Number.isSafeInteger(number) && number >= low && number <= high ? number : fallback
}

export function publicURL(value, base) {
  let url
  try { url = new URL(value, base) }
  catch { throw new PluginError(502, '来源返回了无效的媒体地址。') }
  const host = url.hostname.toLowerCase().replace(/\.$/, '')
  if (url.protocol !== 'https:' || url.username || url.password || url.port
    || !/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z][a-z0-9-]*$/i.test(host)
    || /\.(?:local|localhost|internal|test|invalid|example|onion)$/.test(host)
    || url.href.length > 5000) {
    throw new PluginError(502, '来源地址不符合媒体连接规则。')
  }
  url.hash = ''
  return url
}

export function constantEqual(left, right) {
  if (!left || left.length !== right?.length) return false
  let delta = 0
  for (let i = 0; i < left.length; i++) delta |= left.charCodeAt(i) ^ right.charCodeAt(i)
  return delta === 0
}

function aliasHeaders(extra) {
  return { ...extra, 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff' }
}

export async function passStream(ctx, upstream, request, allowed, extra = {}) {
  const headers = aliasHeaders(extra)
  for (const name of allowed) {
    const value = header(upstream.headers, name)
    if (value && !/[\r\n]/.test(value)) headers[name] = value
  }
  if (request.method === 'HEAD' || upstream.status === 416) return { status: upstream.status, headers }
  const output = await ctx.response.stream({ status: upstream.status, headers })
  for (;;) {
    const chunk = await upstream.read()
    if (chunk === null) break
    await output.write(chunk)
  }
}
