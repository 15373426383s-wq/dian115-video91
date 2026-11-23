import { clearDetail, detail, listPage, viewItem } from './catalog.js'
import { categories } from './categories.js'
import { cors, handleEmby } from './emby.js'
import { boundedInteger, json, PluginError, videoId } from './common.js'
import { serveImage, servePart, serveWebPlaylist, webPartBase } from './media.js'
import { accessToken, closeListener, getSettings, listenerId, openListener, readAccount, setAccount, webSecret } from './settings.js'

async function handleWeb(ctx, request) {
  const query = request.query || {}
  const method = request.method
  const input = request.json || {}
  const path = request.path
  switch (method + ' ' + path) {
    case 'GET /categories':
      return json({ categories })
    case 'GET /catalog': {
      const result = await listPage(ctx, { source: query.source, search: query.q, page: query.page })
      return json({ items: result.items.map(viewItem), page: result.page, hasMore: result.hasMore })
    }
    case 'GET /detail': {
      const { item, variants, playbackDenied } = await detail(ctx, videoId(query.id))
      return json({ item: viewItem(item), lines: variants.length, playbackDenied })
    }
    case 'GET /settings': return json(await getSettings(ctx))
    case 'POST /settings/account': return json(await setAccount(ctx, input))
    case 'POST /settings/reveal-key': {
      const account = await readAccount(ctx)
      if (!account) throw new PluginError(409, '请先创建播放器账号。')
      return json({ apiKey: accessToken(ctx, account) })
    }
    case 'POST /settings/listen': return json(await openListener(ctx, input))
    case 'POST /settings/close': return json(await closeListener(ctx))
    case 'GET /cover':
    case 'HEAD /cover': return serveImage(ctx, request, videoId(query.id), {
      'Cache-Control': 'public, max-age=86400, immutable',
    })
    case 'GET /hls/index.m3u8':
    case 'HEAD /hls/index.m3u8': {
      const id = videoId(query.id)
      if (query.fresh === '1') await clearDetail(ctx, id)
      return serveWebPlaylist(ctx, request, id, boundedInteger(query.line, 0, 0, 11))
    }
    case 'GET /hls/part':
    case 'HEAD /hls/part':
    case 'GET /hls/part.m3u8':
    case 'HEAD /hls/part.m3u8': return servePart(ctx, request, 'web', await webSecret(ctx), webPartBase(ctx))
    default: return { status: 404 }
  }
}

export async function handle(ctx, request) {
  const external = request.source === 'listener:' + listenerId
  try {
    if (external) return await handleEmby(ctx, request)
    if (request.source !== 'hook') return { status: 404 }
    return await handleWeb(ctx, request)
  } catch (error) {
    const status = error instanceof PluginError ? error.status : 502
    const message = error instanceof PluginError ? error.message : '请求未完成，请稍后重试。'
    const result = json({ error: message, message }, status)
    if (external) Object.assign(result.headers, cors)
    return result
  }
}
