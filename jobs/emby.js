import { detail, listPage, playback } from './catalog.js'
import { categories } from './categories.js'
import { boundedInteger, constantEqual, header, json, PluginError, videoId } from './common.js'
import { serveImage, servePart } from './media.js'
import { accessToken, checkPassword, readAccount } from './settings.js'
import { covers } from './library-covers/covers-data.js'

const name = '91 影音'
const part = '/emby/Videos/part'
export const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, HEAD, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Emby-Authorization, X-Emby-Token, X-MediaBrowser-Token, Range',
  'Access-Control-Expose-Headers': 'Content-Length, Content-Range, Accept-Ranges',
}
const ticks = 10000000
const listResult = (items, total = items.length, start = 0) => ({ Items: items, TotalRecordCount: total, StartIndex: start })
const empty = { status: 204 }

function info(account) {
  return {
    ServerName: name, Version: '4.8.0.0', ProductName: 'Emby Server', Id: account.serverId,
    OperatingSystem: 'Linux', StartupWizardCompleted: true,
  }
}

function user(account) {
  return {
    Id: account.userId, ServerId: account.serverId, Name: account.username, HasPassword: true, HasConfiguredPassword: true,
    HasConfiguredEasyPassword: false, Configuration: {}, Policy: {
      IsAdministrator: false, IsDisabled: false, EnableAllFolders: true, EnableMediaPlayback: true,
      EnableAudioPlaybackTranscoding: false, EnableVideoPlaybackTranscoding: false, EnablePlaybackRemuxing: true,
      EnableContentDownloading: false, EnableContentDeletion: false, EnableRemoteAccess: true,
    },
  }
}

function shiftAuth(request) {
  const raw = header(request.headers, 'X-Emby-Authorization') || header(request.headers, 'Authorization')
  return raw.match(/(?:^|[ ,])Token="([^"]+)"/i)?.[1] || raw.match(/^Bearer (\S+)$/i)?.[1]
    || header(request.headers, 'X-Emby-Token') || header(request.headers, 'X-MediaBrowser-Token')
    || header(request.query, 'api_key') || header(request.query, 'ApiKey') || header(request.query, 'X-Emby-Token')
}

function serverFolder(account, category) {
  const tag = 'library-v1-' + category.id
  return { Name: category.name, Id: 'folder-' + category.id, ServerId: account.serverId, Type: 'CollectionFolder',
    IsFolder: true, CollectionType: 'movies', MediaType: 'Unknown', ImageTags: { Primary: tag, Thumb: tag },
    BackdropImageTags: [tag], PrimaryImageAspectRatio: 16 / 9, OriginalPrimaryImageAspectRatio: 16 / 9, UserData: {} }
}

function embyItem(account, value, progress = {}, source = 'recent') {
  return {
    Id: value.id, Name: value.title, OriginalTitle: value.title, ServerId: account.serverId, Type: 'Movie', MediaType: 'Video',
    IsFolder: false, Overview: value.overview, RunTimeTicks: value.duration > 0 ? value.duration * ticks : undefined,
    DateCreated: value.date || undefined, PremiereDate: value.date || undefined,
    ImageTags: value.cover ? { Primary: 'cover-v2-' + value.id } : {}, BackdropImageTags: [], Genres: [],
    ParentId: 'folder-' + source, UserData: { PlaybackPositionTicks: progress.position || 0, Played: !!progress.played,
      IsFavorite: false, PlayCount: progress.played ? 1 : 0 },
  }
}

async function progressFor(ctx, id) {
  const record = await ctx.storage.get('progress:' + id)
  return record || {}
}

async function saveProgress(ctx, input) {
  const id = videoId(input.ItemId)
  const position = Math.min(86400 * ticks, Math.max(0, Number(input.PositionTicks || 0)))
  if (!Number.isSafeInteger(position)) return empty
  const previous = await progressFor(ctx, id)
  const completed = typeof input.RunTimeTicks === 'number' && input.RunTimeTicks > 0
    && position / input.RunTimeTicks >= 0.95
  if (position !== previous.position || completed && !previous.played) {
    await ctx.storage.set('progress:' + id, { position: completed ? 0 : position, played: completed || !!previous.played })
  }
  return empty
}

function mediaSource(item, upstream, token, session) {
  const query = new URLSearchParams({ Static: 'true', MediaSourceId: item.id, api_key: token })
  if (session) query.set('PlaySessionId', session)
  return { Id: item.id, ItemId: item.id, Name: 'HLS', Type: 'Default', Protocol: 'Http', Container: 'hls',
    Path: upstream, DirectStreamUrl: '/Videos/' + item.id + '/original.m3u8?' + query.toString(),
    AddApiKeyToDirectStreamUrl: false, IsRemote: true,
    SupportsDirectPlay: true, SupportsDirectStream: true, SupportsTranscoding: false,
    RunTimeTicks: item.duration ? item.duration * ticks : undefined, MediaStreams: [],
  }
}

async function embyList(ctx, account, query) {
  const parent = header(query, 'ParentId')
  const source = parent ? String(parent).replace(/^folder-/, '') : 'recent'
  if (!categories.some(item => item.id === source)) return listResult([])
  const start = boundedInteger(header(query, 'StartIndex') || undefined, 0, 0, 4000)
  const limit = boundedInteger(header(query, 'Limit') || undefined, 30, 0, 60)
  const search = header(query, 'SearchTerm').trim()
  const first = await listPage(ctx, { source, search, page: 1 })
  if (!first.rawCount) return listResult([], 0, start)
  const width = first.rawCount
  const take = []
  let page = Math.floor(start / width) + 1
  let end = start
  const requested = Math.max(1, limit)
  for (; page <= Math.ceil((start + requested) / width) && page <= 500; page++) {
    const data = page === 1 ? first : await listPage(ctx, { source, search, page })
    const offset = (page - 1) * width
    end = offset + data.rawCount
    for (const item of data.items) {
      const position = offset + data.positions[item.id]
      if (position >= start && position < start + limit) take.push(item)
    }
    if (!data.hasMore) {
      return listResult(await hydrate(ctx, account, take, source), end, start)
    }
  }
  return listResult(await hydrate(ctx, account, take, source), Math.max(end + width, start + take.length), start)
}

async function hydrate(ctx, account, items, source) {
  const values = []
  for (let offset = 0; offset < items.length; offset += 16) {
    values.push(...await Promise.all(items.slice(offset, offset + 16)
      .map(async item => embyItem(account, item, await progressFor(ctx, item.id), source))))
  }
  return values
}

function withCors(response) {
  if (response) response.headers = { ...(response.headers || {}), ...cors }
  return response
}

async function handle(ctx, request) {
  const account = await readAccount(ctx)
  if (!account) throw new PluginError(503, '播放器账号尚未配置。')
  const path = (request.path || '/').replace(/^(?:\/emby)+(?=\/|$)/i, '').replace(/\/$/, '') || '/'
  const method = request.method
  const key = method + ' ' + path.toLowerCase()
  if (method === 'OPTIONS') return empty
  if (key === 'GET /system/info/public') return json(info(account))
  if (key === 'GET /users/public') return json([])
  if (key === 'POST /users/authenticatebyname') {
    const input = request.json || {}
    if (!checkPassword(ctx, account, input.Username ?? input.username, input.Pw ?? input.Password ?? input.pw)) {
      throw new PluginError(401, '播放器用户名或密码错误。')
    }
    return json({ User: user(account), AccessToken: accessToken(ctx, account), ServerId: account.serverId,
      SessionInfo: { Id: account.userId, UserId: account.userId, UserName: account.username, ServerId: account.serverId } })
  }
  if ((key === 'GET /videos/part' || key === 'HEAD /videos/part'
    || key === 'GET /videos/part.m3u8' || key === 'HEAD /videos/part.m3u8')) {
    return servePart(ctx, request, 'emby', account.secret, part, cors)
  }

  const token = accessToken(ctx, account)
  if (!constantEqual(token, shiftAuth(request))) throw new PluginError(401, '请登录播放器账号。')
  if (key === 'GET /system/info') return json(info(account))
  if (key === 'GET /users') return json([user(account)])
  if (key === 'GET /users/me') return json(user(account))
  if (key === 'GET /sessions') return json([])
  if (['POST /sessions/capabilities', 'POST /sessions/capabilities/full', 'POST /sessions/logout'].includes(key)) return empty
  if (['POST /sessions/playing', 'POST /sessions/playing/progress', 'POST /sessions/playing/stopped'].includes(key)) {
    return request.json?.ItemId ? saveProgress(ctx, request.json) : empty
  }

  const matchUser = /^\/users\/([\da-f]{32})(?=\/|$)/i.exec(path)
  if (matchUser && matchUser[1] !== account.userId) return { status: 404 }
  const route = (matchUser ? path.slice(matchUser[0].length) || '/' : path).toLowerCase()
  if (method === 'GET' && matchUser && route === '/') return json(user(account))
  if (method === 'GET' && ['/views', '/library/mediafolders'].includes(route)) {
    return json(listResult(categories.map(category => serverFolder(account, category))))
  }

  const query = request.query || {}
  if (method === 'GET' && route === '/items') return json(await embyList(ctx, account, query))
  if (method === 'GET' && route === '/items/latest') return json((await embyList(ctx, account, query)).Items)
  if (method === 'GET' && ['/items/resume', '/items/nextup'].includes(route)) return json(listResult([]))
  if (method === 'GET' && route === '/search/hints') {
    const list = await embyList(ctx, account, query)
    return json({ TotalRecordCount: list.TotalRecordCount, SearchHints: list.Items.map(item => ({
      Id: item.Id, ItemId: item.Id, Name: item.Name, Type: item.Type, MediaType: item.MediaType,
      RunTimeTicks: item.RunTimeTicks, PrimaryImageTag: item.ImageTags.Primary,
    })) })
  }

  const itemPath = matchUser ? path.slice(matchUser[0].length) : path
  const libraryImage = /^\/items\/folder-([a-z0-9_-]+)\/images\/(?:primary|thumb|backdrop)(?:\/0)?$/i.exec(itemPath)
  if (libraryImage && ['GET', 'HEAD'].includes(method)) {
    const category = categories.find(item => item.id === libraryImage[1])
    if (!category) return { status: 404 }
    const jpeg = covers[category.id]
    if (!jpeg) return { status: 404 }
    const headers = { 'Content-Type': 'image/jpeg', 'Cache-Control': 'private, max-age=3600',
      'X-Content-Type-Options': 'nosniff',
      'Content-Length': String(jpeg.length / 4 * 3 - (jpeg.endsWith('==') ? 2 : Number(jpeg.endsWith('=')))) }
    return { status: 200, headers, body_base64: method === 'HEAD' ? undefined : jpeg }
  }
  const playbackInfo = /^\/items\/([^/]+)\/playbackinfo$/i.exec(itemPath)
  if (playbackInfo && ['GET', 'POST'].includes(method)) {
    const { item, variants } = await playback(ctx, playbackInfo[1])
    const session = ctx.crypto.randomUUID()
    return json({ MediaSources: [mediaSource(item, variants[0], token, session)], PlaySessionId: session })
  }
  const image = /^\/items\/([^/]+)\/images\/primary(?:\/0)?$/i.exec(itemPath)
  if (image && ['GET', 'HEAD'].includes(method)) return serveImage(ctx, request, videoId(image[1]), cors)
  const video = /^\/videos?\/([^/]+)\/(?:(?:master|main|index)\.m3u8|(?:stream|original)(?:\.[a-z0-9]{1,8})?)$/i.exec(path)
  if (video && ['GET', 'HEAD'].includes(method)) {
    const { variants } = await playback(ctx, video[1])
    return { status: 307, headers: { Location: variants[0], 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' } }
  }
  const item = /^\/items\/([^/]+)$/i.exec(itemPath)
  if (item && method === 'GET') {
    const folder = categories.find(category => 'folder-' + category.id === item[1])
    if (folder) return json(serverFolder(account, folder))
    const id = videoId(item[1])
    const { item: value, variants } = await detail(ctx, id)
    return json({ ...embyItem(account, value, await progressFor(ctx, id)),
      MediaSources: variants.length ? [mediaSource(value, variants[0], token)] : [] })
  }
  return { status: 404 }
}

export async function handleEmby(ctx, request) {
  return withCors(await handle(ctx, request))
}
