import { constantEqual, PluginError } from './common.js'

export const listenerId = 'emby'
const accountKey = 'player-account'
const relayKey = 'web-media-secret'

function randomHex(ctx, bytes) {
  return ctx.codec.hexEncode(ctx.crypto.randomBytes(bytes))
}

export function readAccount(ctx) {
  return ctx.storage.get(accountKey)
}

export async function listener(ctx) {
  const entries = await ctx.server.list()
  return entries.find(item => item.id === listenerId) || null
}

export async function getSettings(ctx) {
  const [account, service] = await Promise.all([readAccount(ctx), listener(ctx)])
  return { username: account?.username || '', configured: Boolean(account), listener: service }
}

export async function setAccount(ctx, input) {
  const username = String(input.username || '').trim()
  if (!username || username.length > 48 || /[\u0000-\u001f\u007f]/.test(username)) {
    throw new PluginError(400, '请输入 1–48 个字符的播放器用户名。')
  }
  const previous = await readAccount(ctx)
  const password = randomHex(ctx, 16)
  const salt = randomHex(ctx, 16)
  const account = {
    username, salt, passwordHash: ctx.crypto.sha256(salt + ':' + password, 'hex'),
    secret: randomHex(ctx, 32),
    serverId: previous?.serverId || randomHex(ctx, 16),
    userId: previous?.userId || randomHex(ctx, 16),
  }
  await ctx.storage.set(accountKey, account)
  return { ...await getSettings(ctx), password }
}

export function accessToken(ctx, account) {
  return ctx.crypto.hmac('sha256', account.secret, 'video91:emby:' + account.userId, 'hex')
}

export function checkPassword(ctx, account, username, password) {
  if (!account || typeof password !== 'string' || password.length > 256) return false
  const digest = ctx.crypto.sha256(account.salt + ':' + password, 'hex')
  return username === account.username && constantEqual(account.passwordHash, digest)
}

export async function openListener(ctx, input) {
  if (!await readAccount(ctx)) throw new PluginError(409, '请先创建播放器账号。')
  const port = Number(input.port)
  const host = input.host === '0.0.0.0' || input.host === '127.0.0.1' ? input.host : ''
  if (!Number.isInteger(port) || port < 1024 || port > 65535 || !host) {
    throw new PluginError(400, '请选择监听范围并填写 1024–65535 之间的端口。')
  }
  const before = await listener(ctx)
  if (before?.running && before.host === host && before.port === port) return getSettings(ctx)
  try {
    const result = await ctx.server.listen({ id: listenerId, host, port })
    if (!result.running) throw new Error(result.error || 'listener did not start')
  } catch (error) {
    if (before?.running) {
      try {
        const restored = await ctx.server.listen({ id: listenerId, host: before.host, port: before.port })
        if (!restored.running) throw new Error('restore failed')
      } catch {
        throw new PluginError(409, '无法绑定新端口，原端口也未能恢复。请刷新查看当前状态。')
      }
    } else {
      await ctx.server.close(listenerId).catch(() => {})
    }
    throw new PluginError(409, /in use|only one usage/i.test(error?.message || '')
      ? '这个端口已被占用。' : '无法绑定端口，请检查宿主设置。')
  }
  return getSettings(ctx)
}

export async function closeListener(ctx) {
  if (await listener(ctx)) await ctx.server.close(listenerId)
  return getSettings(ctx)
}

export async function webSecret(ctx, create = false) {
  let secret = await ctx.storage.get(relayKey)
  if (!secret && create) {
    await ctx.storage.set(relayKey, randomHex(ctx, 32))
    secret = await ctx.storage.get(relayKey)
  }
  return secret
}
