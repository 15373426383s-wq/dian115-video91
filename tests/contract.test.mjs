import test from 'node:test'
import assert from 'node:assert/strict'
import { decodeEnvelope } from '../jobs/catalog.js'
import { rewritePlaylist } from '../jobs/media.js'
import { cover, encryptEnvelope, fixture } from './fixture.mjs'

const web = 'hook', emby = 'listener:emby'
async function login(server) {
  const created = await server.call(web, 'POST', '/settings/account', { data: { username: 'viewer' } })
  assert.match(created.json.password, /^[0-9a-f]{32}$/)
  const auth = await server.call(emby, 'POST', '/emby/Users/AuthenticateByName', {
    data: { Username: 'viewer', Pw: created.json.password },
  })
  assert.equal(auth.status, 200)
  assert.equal(server.store.get('player-account').password, undefined)
  return auth.json
}
test('host crypto decodes the attachment envelope', () => {
  const { ctx } = fixture()
  const rows = [{ id: '101', title: '城间的光' }]
  assert.deepEqual(decodeEnvelope(ctx, encryptEnvelope(rows)), rows)
  assert.throws(() => decodeEnvelope(ctx, 'abcd'))
})
test('browse and search retain all source categories and keep playback URLs out of responses', async () => {
  const server = fixture()
  const identity = JSON.stringify(['c1', '', 1])
  const cacheKey = 'catalog:' + server.ctx.crypto.sha256(identity, 'hex').slice(0, 3)
  await server.ctx.storage.set(cacheKey, { identity, exp: Date.now() + 90000, result: { items: [], restrictedCount: 4 } })
  const data = await server.call(web, 'GET', '/catalog', { query: { source: 'c1' } })
  assert.deepEqual(data.json.items.map(x => x.id), ['101', '102', '103', '104'])
  assert.equal(Object.hasOwn(data.json.items[0], 'm3u8'), false)
  const result = await server.call(web, 'GET', '/catalog', { query: { q: '街道' } })
  assert.deepEqual(result.json.items.map(x => x.id), ['103'])
  const categoryResult = await server.call(web, 'GET', '/catalog', { query: { q: '传媒' } })
  assert.deepEqual(categoryResult.json.items.map(x => x.id), ['102'])
  assert.equal((await server.call(web, 'GET', '/hls/index.m3u8', { query: { id: '102' } })).status, 200)
})
test('honors source throttling and permission responses without trying another origin', async () => {
  for (const [response, expected] of [
    [{ status: 429, body: '{}' }, 429],
    [{ status: 200, body: JSON.stringify({ r: encryptEnvelope({ blocked: true }) }) }, 429],
    [{ status: 403, body: '{}' }, 403],
  ]) {
    const server = fixture({ override: () => response })
    assert.equal((await server.call(web, 'GET', '/catalog')).status, expected)
    assert.equal(server.requests.length, 1)
  }
})
test('Emby authenticates, lists libraries, pages across source items, and searches', async () => {
  const server = fixture()
  assert.equal((await server.call('public', 'GET', '/catalog')).status, 404)
  const account = await login(server)
  assert.equal((await server.call(emby, 'GET', '/System/Info/Public')).json.Id, account.ServerId)
  assert.equal((await server.call(emby, 'GET', '/Items')).status, 401)
  const headers = { 'X-Emby-Authorization': 'MediaBrowser Client="Demo", Token="' + account.AccessToken + '"' }
  const views = await server.call(emby, 'GET', '/emby/Users/' + account.User.Id + '/Views', { headers })
  const webCategories = (await server.call(web, 'GET', '/categories')).json.categories
  assert.equal(webCategories.length, 59)
  assert.deepEqual(views.json.Items.map(item => item.Id), webCategories.map(item => 'folder-' + item.id))
  assert.equal(new Set(webCategories.map(item => item.group)).size, 3)
  assert.ok(views.json.Items.some(item => item.Id === 'folder-torture_other'))
  const list = await server.call(emby, 'GET', '/Items', { headers, query: { parentId: 'folder-recent', startIndex: '2', limit: '1' } })
  assert.deepEqual(list.json.Items.map(x => x.Id), ['103'])
  const category = await server.call(emby, 'GET', '/Items', { headers, query: { parentId: 'folder-t_high_gaoqing', limit: '1' } })
  assert.equal(category.json.Items[0].ParentId, 'folder-t_high_gaoqing')
  assert.ok(server.requests.some(req => req.json?.url === '/sevenVideos?page=1&type=t_high_gaoqing'))
  const studio = await server.call(emby, 'GET', '/Items', { headers, query: { parentId: 'folder-c1', startIndex: '1', limit: '1' } })
  assert.deepEqual(studio.json.Items.map(item => item.Id), ['102'])
  const search = await server.call(emby, 'GET', '/Search/Hints', { headers, query: { searchTerm: '雨后' } })
  assert.deepEqual(search.json.SearchHints.map(x => x.Id), ['103'])
})
test('listener restore and token rotation', async () => {
  const server = fixture()
  assert.equal((await server.call(web, 'POST', '/settings/listen', { data: { host: '0.0.0.0', port: 8097 } })).status, 409)
  const initial = await login(server)
  assert.equal((await server.call(web, 'POST', '/settings/listen', { data: { host: '0.0.0.0', port: 8097 } })).json.listener.running, true)
  assert.equal((await server.call(web, 'POST', '/settings/listen', { data: { host: '0.0.0.0', port: 8098 } })).status, 409)
  assert.equal((await server.call(web, 'GET', '/settings')).json.listener.port, 8097)
  assert.equal((await login(server)).User.Id, initial.User.Id)
  assert.equal((await server.call(emby, 'GET', '/Users/Me', { query: { api_key: initial.AccessToken } })).status, 401)
  assert.equal((await server.call(web, 'POST', '/settings/close')).json.listener, null)
})
test('Emby advertises distinct built-in artwork for all 59 libraries', async () => {
  const server = fixture()
  const { AccessToken, User } = await login(server)
  const query = { api_key: AccessToken }
  const views = await server.call(emby, 'GET', '/emby/Users/' + User.Id + '/Views', { query })
  const images = new Set()
  assert.equal(views.json.Items.length, 59)
  for (const folder of views.json.Items) {
    assert.equal(folder.ImageTags.Primary, folder.ImageTags.Thumb)
    assert.deepEqual(folder.BackdropImageTags, [folder.ImageTags.Primary])
    assert.equal(folder.PrimaryImageAspectRatio, 16 / 9)
    const image = await server.call(emby, 'GET', '/emby/Items/' + folder.Id + '/Images/Primary', { query })
    assert.equal(image.status, 200)
    assert.equal(image.headers['Content-Type'], 'image/jpeg')
    const bytes = Buffer.from(image.body_base64, 'base64')
    assert.equal(bytes.subarray(0, 3).toString('hex'), 'ffd8ff')
    assert.equal(Number(image.headers['Content-Length']), bytes.length)
    images.add(image.body_base64)
  }
  assert.equal(images.size, 59)
  for (const kind of ['Thumb', 'Backdrop']) {
    const head = await server.call(emby, 'HEAD', '/Items/folder-recent/Images/' + kind + '/0', { query })
    assert.equal(head.status, 200)
    assert.ok(Number(head.headers['Content-Length']) > 0)
    assert.equal(head.body_base64, undefined)
  }
  assert.equal((await server.call(emby, 'GET', '/Items/folder-recent/Images/Primary')).status, 401)
  assert.equal((await server.call(emby, 'GET', '/Items/folder-invalid/Images/Primary', { query })).status, 404)
  assert.equal(server.requests.length, 0)
})
test('web and Emby send the correct MIME for covers served as octet-stream', async () => {
  const server = fixture()
  const { AccessToken } = await login(server)
  const headers = { 'X-Emby-Token': AccessToken }
  const catalog = await server.call(web, 'GET', '/catalog')
  assert.equal(catalog.json.items[0].hasCover, true)
  const list = await server.call(emby, 'GET', '/Items', { headers })
  assert.equal(list.json.Items[0].ImageTags.Primary, 'cover-v2-101')
  for (const [source, path, query] of [[web, '/cover', { id: '101' }], [emby, '/emby/Items/101/Images/Primary/0', {}]]) {
    const image = await server.call(source, 'GET', path, { query, headers })
    assert.equal(image.status, 200)
    assert.equal(image.headers['Content-Type'], 'image/png')
    assert.equal(image.body_base64, cover)
    const head = await server.call(source, 'HEAD', path, { query, headers })
    assert.equal(head.headers['Content-Length'], String(Buffer.from(cover, 'base64').length))
    assert.equal(head.body_base64, undefined)
  }
  const html = fixture({ override: req => req.response_type === 'base64'
    ? { status: 200, headers: { 'Content-Type': ['image/png'] }, body_base64: Buffer.from('<!doctype html>').toString('base64') }
    : undefined })
  assert.equal((await html.call(web, 'GET', '/cover', { query: { id: '101' } })).status, 404)
})
test('Emby advertises a direct upstream HLS address and redirects standard playback routes', async () => {
  const server = fixture()
  const { AccessToken } = await login(server)
  const headers = { 'X-Emby-Token': AccessToken }
  const info = await server.call(emby, 'POST', '/emby/Items/101/PlaybackInfo', { headers })
  const media = info.json.MediaSources[0]
  assert.equal(media.SupportsDirectPlay, true)
  assert.equal(media.Path, 'https://media.example.com/a/main.m3u8')
  const url = new URL(media.DirectStreamUrl, 'https://player.example.com')
  assert.match(url.pathname, /original\.m3u8$/)
  assert.equal(url.searchParams.get('MediaSourceId'), '101')
  assert.equal(url.searchParams.get('PlaySessionId'), info.json.PlaySessionId)
  for (const path of [url.pathname, '/emby' + url.pathname, '/emby/emby/Videos/101/stream.mp4', '/Videos/101/master.m3u8', '/Video/101/stream']) {
    const redirect = await server.call(emby, 'GET', path, { query: Object.fromEntries(url.searchParams) })
    assert.equal(redirect.status, 307)
    assert.equal(redirect.headers.Location, media.Path)
  }
  assert.equal((await server.call(emby, 'GET', url.pathname)).status, 401)
  assert.equal((await server.call(emby, 'GET', '/Videos/102/original.m3u8', { headers })).status, 307)
  assert.equal(server.requests.some(req => req.url === media.Path), false)
})
test('explicit source playback denial keeps metadata visible without releasing the stream', async () => {
  const source = 'https://media.example.com/a/main.m3u8'
  const server = fixture({ items: [
    { id: '201', title: '来源拒绝', canPlay: false, m3u8: source },
    { id: '202', title: '来源锁定', locked: true, m3u8: source },
    { id: '203', title: '尚无线路' },
  ] })
  const { AccessToken } = await login(server)
  const headers = { 'X-Emby-Token': AccessToken }
  const list = await server.call(web, 'GET', '/catalog', { query: { source: 'c1' } })
  assert.equal(list.json.items.length, 3)
  for (const id of ['201', '202', '203']) {
    const denies = id !== '203'
    const detail = await server.call(web, 'GET', '/detail', { query: { id } })
    assert.equal(detail.json.playbackDenied, denies)
    assert.equal(detail.json.lines, 0)
    const media = await server.call(emby, 'GET', '/Items/' + id, { headers })
    assert.deepEqual(media.json.MediaSources, [])
    const expected = denies ? 403 : 404
    assert.equal((await server.call(web, 'GET', '/hls/index.m3u8', { query: { id } })).status, expected)
    assert.equal((await server.call(emby, 'POST', '/Items/' + id + '/PlaybackInfo', { headers })).status, expected)
    assert.equal((await server.call(emby, 'GET', '/Videos/' + id + '/original.m3u8', { headers })).status, expected)
  }
  assert.equal(server.requests.some(req => req.url === source), false)
})
test('web HLS signed subrequests are scoped and preserve Range', async () => {
  const server = fixture()
  await login(server)
  const master = await server.call(web, 'GET', '/hls/index.m3u8', { query: { id: '101' } })
  const part = new URL(master.body.split('\n').find(line => line.startsWith('/api/extensions/v3/local.video91/hook/hls/part')), 'https://dian.example.com')
  const t = part.searchParams.get('t')
  assert.equal((await server.call(emby, 'GET', '/emby/Videos/part', { query: { t } })).status, 403)
  assert.equal((await server.call(web, 'GET', '/hls/part', { query: { t: t + 'x' } })).status, 403)
  const media = await server.call(web, 'GET', '/hls/part', { query: { t }, headers: { Range: 'bytes=0-3' } })
  assert.equal(media.status, 206)
  assert.equal(media.headers['Content-Range'], 'bytes 0-3/4')
  assert.equal(media.bytes.length, 4)
})
test('rewrites playlist paths and rejects forbidden destinations', () => {
  const base = new URL('https://media.example.com/a/main.m3u8')
  const input = '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=3000\nlevel\n#EXT-X-KEY:METHOD=AES-128,URI="key.bin"\nseg.ts'
  const mapped = rewritePlaylist(input, base, (url, kind) => kind + ':' + url.pathname)
  assert.match(mapped, /playlist:\/a\/level/)
  assert.match(mapped, /URI="segment:\/a\/key.bin"/)
  assert.match(mapped, /segment:\/a\/seg.ts/)
  assert.throws(() => rewritePlaylist('#EXTM3U\nhttps://127.0.0.1/file', base, () => ''), /连接规则/)
})
test('saves playback progress per item', async () => {
  const server = fixture(), { AccessToken } = await login(server)
  const headers = { 'X-Emby-Token': AccessToken }
  assert.equal((await server.call(emby, 'POST', '/Sessions/Playing/Progress', { headers, data: { ItemId: '101', PositionTicks: 5550000 } })).status, 204)
  assert.equal((await server.call(emby, 'GET', '/Items/101', { headers })).json.UserData.PlaybackPositionTicks, 5550000)
  assert.equal((await server.call(emby, 'GET', '/Items/103', { headers })).json.UserData.PlaybackPositionTicks, 0)
})
