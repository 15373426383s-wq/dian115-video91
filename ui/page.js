const icons = {
  arrow: '<path d="m14 18-6-6 6-6"/><path d="M8 12h12"/>',
  search: '<circle cx="10.8" cy="10.8" r="6.8"/><path d="m16 16 4 4"/>',
  play: '<path d="M9 5.8v12.4l10-6.2z" fill="currentColor" stroke="none"/>',
  film: '<rect x="4" y="6" width="16" height="12" rx="2"/><path d="M8 6v12m8-12v12M4 12h4m8 0h4"/>',
}
function icon(name) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  svg.setAttribute('viewBox', '0 0 24 24')
  svg.setAttribute('fill', 'none')
  svg.setAttribute('stroke', 'currentColor')
  svg.setAttribute('stroke-width', '1.8')
  svg.setAttribute('stroke-linecap', 'round')
  svg.setAttribute('stroke-linejoin', 'round')
  svg.setAttribute('aria-hidden', 'true')
  svg.innerHTML = icons[name]
  return svg
}
let playIconTemplate
function playIcon() {
  if (!playIconTemplate) playIconTemplate = icon('play')
  return playIconTemplate.cloneNode(true)
}

function node(tag, className, text) {
  const element = document.createElement(tag)
  if (className) element.className = className
  if (text) element.textContent = text
  return element
}

function timestamp(seconds) {
  const length = Math.floor(Number(seconds) || 0)
  if (length <= 0) return ''
  const h = Math.floor(length / 3600), m = Math.floor(length / 60) % 60, s = length % 60
  return h ? [h, m, s].map(n => String(n).padStart(2, '0')).join(':')
    : m + ':' + String(s).padStart(2, '0')
}

export function mount(ctx) {
  const $ = id => document.getElementById(id)
  const local = new AbortController()
  const on = (element, name, handler, options) => element.addEventListener(name, handler, { ...options, signal: local.signal })
  const hook = '/api/extensions/v3/' + encodeURIComponent(ctx.id || 'local.video91') + '/hook'
  const endpoint = (path, query) => path + (query && Object.keys(query).length ? '?' + new URLSearchParams(query) : '')
  const api = (method, path, data) => ctx.api[method](hook + path, data)
  const asset = (path, query) => endpoint(ctx.server.hookURL(path), query)
  const views = { library: $('library'), watch: $('watch'), connection: $('connection') }
  const titles = { library: $('library-heading'), watch: $('watch-title'), connection: $('connection-heading') }
  const nav = [...document.querySelectorAll('[data-view]')]
  const grid = $('grid')
  const video = $('video')
  const categoryButtons = new Map()
  const allCategories = $('all-categories')
  const quickCategories = ['recent', 'hot', 'hd', '91original', 'month_hot', 'favs']
  let source = 'recent', search = '', page = 1, more = false, browseRequest = 0, view = 'library'
  let categories = [], settings, watch, returnFocus, scrollPosition = 0
  let player, playbackListeners, streamVersion = 0, changeViewVersion = 0, runningSettingAction = false
  const unsubscribe = ctx.theme?.subscribe(mode => { document.documentElement.dataset.theme = mode })
  if (!unsubscribe && ctx.theme?.mode) document.documentElement.dataset.theme = ctx.theme.mode

  function status(id, message, error = false) {
    const element = $(id)
    element.textContent = message
    element.dataset.error = String(error)
  }

  function playStatus(message, canRetry = false) {
    $('player-message').textContent = message
    $('player-status').hidden = !message
    $('retry-player').hidden = !canRetry
  }

  function cancelPlayback() {
    streamVersion++
    playbackListeners?.abort()
    player?.destroy()
    player = null
    video.pause()
    video.removeAttribute('src')
    video.load()
  }

  function setView(next, focus = true) {
    if (next !== view) {
      ++changeViewVersion
      if (view === 'watch' && next !== 'watch') {
        video.removeAttribute('poster')
        cancelPlayback()
      }
      view = next
      for (const [key, panel] of Object.entries(views)) panel.hidden = key !== next
      for (const button of nav) {
        if (button.dataset.view === next || button.dataset.view === 'library' && next === 'watch') button.setAttribute('aria-current', 'page')
        else button.removeAttribute('aria-current')
      }
      window.scrollTo({ top: 0, behavior: 'instant' })
    }
    if (focus) titles[next].focus({ preventScroll: true })
  }

  function emptyState(message, action) {
    const state = node('div', 'empty-state')
    state.append(node('strong', '', message))
    if (action) {
      const button = node('button', 'button', '重试')
      button.type = 'button'
      on(button, 'click', action)
      state.append(button)
    }
    grid.replaceChildren(state)
  }

  function formatCard(item) {
    const card = node('button', 'video-card')
    card.type = 'button'
    card.setAttribute('aria-label', '查看 ' + item.title)
    const cover = node('span', 'cover')
    cover.append(playIcon())
    if (item.hasCover) {
      const image = node('img')
      image.alt = ''
      image.loading = 'lazy'
      image.decoding = 'async'
      image.src = asset('cover', { id: item.id, v: 2 })
      on(image, 'load', () => image.classList.add('loaded'), { once: true })
      on(image, 'error', () => image.remove(), { once: true })
      cover.append(image)
    }
    const duration = item.durationText || timestamp(item.duration)
    if (duration) cover.append(node('span', 'duration', duration))
    const caption = node('span', 'caption')
    caption.append(node('strong', '', item.title))
    const meta = [item.creator, item.date?.slice(0, 10)].filter(Boolean).join(' · ')
    if (meta) caption.append(node('small', '', meta))
    card.append(cover, caption)
    on(card, 'click', () => { void openWatch(item, card) })
    return card
  }

  async function loadCatalog() {
    const request = ++browseRequest
    const current = categories.find(category => category.id === source)?.name || '最近更新'
    $('collection-name').textContent = search ? '搜索结果' : current
    for (const [value, button] of categoryButtons) button.setAttribute('aria-pressed', String(!search && value === source))
    allCategories.value = search || quickCategories.includes(source) ? '' : source
    $('pagination').hidden = true
    grid.setAttribute('aria-busy', 'true')
    status('library-status', '正在加载影片…')
    const columns = Math.max(1, Math.round(grid.clientWidth / 280))
    const placeholders = document.createDocumentFragment()
    for (let index = 0; index < columns * 2; index++) {
      const tile = node('div', 'placeholder-card')
      tile.setAttribute('aria-hidden', 'true')
      placeholders.append(tile)
    }
    grid.replaceChildren(placeholders)
    try {
      const { items, hasMore } = await api('get', endpoint('/catalog', { source, q: search, page }))
      if (local.signal.aborted || request !== browseRequest) return
      more = hasMore
      if (items.length) {
        const fragment = document.createDocumentFragment()
        for (const item of items) fragment.append(formatCard(item))
        grid.replaceChildren(fragment)
      } else emptyState(search ? '当前页没有找到匹配的影片。' : '当前页暂无影片。')
      $('previous').disabled = page <= 1
      $('next').disabled = !more
      $('page-label').textContent = '第 ' + page + ' 页'
      $('pagination').hidden = page === 1 && !more
      status('library-status', '')
    } catch (error) {
      if (local.signal.aborted || request !== browseRequest) return
      status('library-status', error.message || '无法加载影片。', true)
      emptyState('影片暂时无法加载。', loadCatalog)
    } finally {
      if (request === browseRequest) grid.setAttribute('aria-busy', 'false')
    }
  }

  function selectCategory(id) {
    source = id
    search = $('search').value = ''
    page = 1
    void loadCatalog()
  }

  async function loadCategories() {
    try {
      const result = await api('get', '/categories')
      if (local.signal.aborted) return
      categories = result.categories || []
      const groups = new Map()
      for (const { id, name, group } of categories) {
        if (!groups.has(group)) {
          const label = node('optgroup')
          label.label = group
          groups.set(group, label)
          allCategories.append(label)
        }
        const option = node('option', '', name)
        option.value = id
        groups.get(group).append(option)
      }
      allCategories.parentElement.hidden = categories.length === 0
      for (const id of quickCategories) {
        const category = categories.find(item => item.id === id)
        if (!category) continue
        const button = node('button', '', category.name)
        button.type = 'button'
        on(button, 'click', () => selectCategory(id))
        categoryButtons.set(id, button)
        $('categories').append(button)
      }
    } catch {}
    if (!local.signal.aborted) await loadCatalog()
  }

  function playLine(tryAutoplay, resume = 0, fresh = false) {
    if (!watch?.lines || view !== 'watch') return
    cancelPlayback()
    const version = streamVersion
    playStatus('正在连接播放线路…')
    const url = asset('hls/index.m3u8', { id: watch.item.id, line: $('lines').value || 0, t: Date.now(), ...(fresh ? { fresh: 1 } : {}) })
    const loaded = () => {
      if (streamVersion !== version || local.signal.aborted) return
      if (resume > 0 && Number.isFinite(video.duration) && resume < video.duration) video.currentTime = resume
      playStatus('')
      if (tryAutoplay) video.play().catch(() => {})
    }
    const error = () => {
      if (streamVersion !== version || view !== 'watch') return
      playStatus('播放中断。可以重新加载或切换播放线路。', true)
    }
    playbackListeners = new AbortController()
    const listeners = {
      signal: playbackListeners.signal,
      once: true,
    }
    video.addEventListener('loadedmetadata', loaded, listeners)
    video.addEventListener('error', error, listeners)
    if (video.canPlayType('application/vnd.apple.mpegurl')) {
      video.src = url
      video.load()
      if (tryAutoplay) video.play().catch(() => {})
    } else if (window.Hls?.isSupported()) {
      player = new window.Hls({
        maxBufferLength: 60,
        maxBufferSize: 80 * 1000 * 1000,
        enableWorker: true,
        lowLatencyMode: false,
        backBufferLength: 120,
        xhrSetup(xhr) { xhr.withCredentials = true },
      })
      player.on(window.Hls.Events.ERROR, (_, data) => { if (data.fatal) error() })
      player.loadSource(url)
      player.attachMedia(video)
    } else {
      playStatus('此浏览器无法播放 HLS 视频。', false)
    }
  }

  async function openWatch(item, trigger) {
    returnFocus = trigger
    scrollPosition = window.scrollY
    setView('watch', false)
    const version = changeViewVersion
    watch = null
    if (item.hasCover) video.poster = asset('cover', { id: item.id, v: 2 })
    $('watch-title').textContent = item.title
    $('watch-title').focus({ preventScroll: true })
    $('watch-meta').textContent = item.durationText || timestamp(item.duration)
    $('watch-overview').hidden = true
    $('lines').closest('.field').hidden = true
    playStatus('正在读取播放线路…')
    try {
      const result = await api('get', endpoint('/detail', { id: item.id }))
      if (local.signal.aborted || version !== changeViewVersion || view !== 'watch') return
      watch = result
      $('watch-title').textContent = result.item.title
      $('watch-meta').textContent = [result.item.creator, result.item.durationText || timestamp(result.item.duration),
        result.item.date?.slice(0, 10)].filter(Boolean).join(' · ')
      $('watch-overview').textContent = result.item.overview || ''
      $('watch-overview').hidden = !result.item.overview
      $('lines').replaceChildren(...Array.from({ length: result.lines }, (_, line) => {
        const option = node('option', '', '线路 ' + (line + 1))
        option.value = String(line)
        return option
      }))
      $('lines').closest('.field').hidden = result.lines < 2
      if (result.playbackDenied) playStatus('来源拒绝播放此影片。')
      else if (!result.lines) playStatus('来源没有返回可用的播放线路。', true)
      else playLine(true)
    } catch (error) {
      if (local.signal.aborted || version !== changeViewVersion) return
      playStatus(error.message || '无法取得播放线路。', true)
    }
    if (version === changeViewVersion) {
      $('retry-player').onclick = () => watch?.lines ? playLine(true, 0, true) : void openWatch(item, trigger)
    }
  }

  function setListenerStatus(result) {
    settings = result
    const account = $('account-form')
    if (result.username && document.activeElement !== account.elements.username) account.elements.username.value = result.username
    $('create-account').textContent = result.configured ? '重新生成密码' : '创建账号'
    $('password-hint').textContent = result.configured ? '重新生成密码后，外部播放器需要重新登录。' : '为播放器生成独立密码。'
    const running = result.listener?.running === true
    const indicator = $('listener-status')
    indicator.dataset.running = String(running)
    indicator.querySelector('span').textContent = running ? '监听中' : '监听已关闭'
    $('start-listener').disabled = !result.configured || runningSettingAction
    $('start-listener').textContent = running ? '应用端口设置' : '开启监听'
    $('stop-listener').hidden = !running
    $('stop-listener').disabled = runningSettingAction
    $('copy-address').disabled = !running
    $('reveal-key').disabled = !result.configured || runningSettingAction
    if (running) {
      const form = $('listen-form')
      form.elements.host.value = result.listener.host || '0.0.0.0'
      form.elements.port.value = String(result.listener.port)
      const host = result.listener.host === '127.0.0.1' ? '127.0.0.1' : new URL(asset('settings'), document.baseURI).hostname
      $('server-address').textContent = 'http://' + host + ':' + result.listener.port
    } else {
      $('server-address').textContent = '开启监听后显示'
    }
  }

  async function settingsAction(task, statusText = '') {
    if (runningSettingAction) return
    runningSettingAction = true
    $('create-account').disabled = true
    if (settings) setListenerStatus(settings)
    status('settings-status', statusText)
    try { await task() }
    catch (error) { status('settings-status', error.message || '设置操作失败。', true) }
    finally {
      runningSettingAction = false
      $('create-account').disabled = false
      if (settings) setListenerStatus(settings)
    }
  }

  function connection() {
    setView('connection')
    void settingsAction(async () => {
      setListenerStatus(await api('get', '/settings'))
      status('settings-status', '')
    }, '正在读取播放器设置…')
  }

  async function copy(id) {
    const element = $(id)
    try {
      await navigator.clipboard.writeText(element.textContent)
      status('settings-status', '已复制。')
    } catch {
      const range = document.createRange()
      range.selectNodeContents(element)
      const selection = document.getSelection()
      selection.removeAllRanges()
      selection.addRange(range)
      element.focus()
      status('settings-status', '已选中文字，可使用系统菜单复制。')
    }
  }

  $('search-icon').append(icon('search'))
  $('leave').append(icon('arrow'))
  $('watch-back').append(icon('arrow'), '返回影片库')
  $('leave').hidden = !ctx.navigation?.close
  $('start-listener').disabled = true
  if (ctx.navigation?.close) {
    on($('leave'), 'click', () => {
      ctx.navigation.close().catch(error => {
        if (view === 'library') status('library-status', error.message, true)
        else if (view === 'connection') status('settings-status', error.message, true)
        else playStatus(error.message)
      })
    })
  }
  for (const button of nav) on(button, 'click', () => {
    if (button.dataset.view === 'connection') connection()
    else setView('library')
  })
  on(allCategories, 'change', () => selectCategory(allCategories.value))
  on($('search-form'), 'submit', event => {
    event.preventDefault()
    search = $('search').value.trim()
    page = 1
    void loadCatalog()
  })
  on($('previous'), 'click', () => {
    if (page <= 1) return
    page--
    window.scrollTo({ top: 0, behavior: 'instant' })
    void loadCatalog()
  })
  on($('next'), 'click', () => {
    if (!more) return
    page++
    window.scrollTo({ top: 0, behavior: 'instant' })
    void loadCatalog()
  })
  on($('watch-back'), 'click', () => {
    setView('library', false)
    window.scrollTo({ top: scrollPosition, behavior: 'instant' })
    returnFocus?.focus({ preventScroll: true })
  })
  on($('lines'), 'change', () => playLine(true, video.currentTime))
  on($('account-form'), 'submit', event => {
    event.preventDefault()
    const username = event.currentTarget.elements.username.value
    void settingsAction(async () => {
      const result = await api('post', '/settings/account', { username })
      $('new-password').textContent = result.password
      $('password-box').hidden = false
      $('api-key').textContent = ''
      $('key-box').hidden = true
      setListenerStatus(result)
      status('settings-status', '播放器账号已保存。')
    }, '正在保存播放器账号…')
  })
  on($('listen-form'), 'submit', event => {
    event.preventDefault()
    const form = event.currentTarget
    const values = { port: Number(form.elements.port.value), host: form.elements.host.value }
    void settingsAction(async () => {
      try {
        setListenerStatus(await api('post', '/settings/listen', values))
        status('settings-status', '监听已开启。')
      } catch (error) {
        setListenerStatus(await api('get', '/settings'))
        throw error
      }
    }, '正在开启播放器端口…')
  })
  on($('stop-listener'), 'click', () => {
    void settingsAction(async () => {
      setListenerStatus(await api('post', '/settings/close', {}))
      status('settings-status', '监听已关闭。')
    })
  })
  on($('reveal-key'), 'click', () => {
    if (!$('key-box').hidden) {
      $('key-box').hidden = true
      $('api-key').textContent = ''
      return
    }
    void settingsAction(async () => {
      const { apiKey } = await api('post', '/settings/reveal-key', {})
      $('api-key').textContent = apiKey
      $('key-box').hidden = false
      $('api-key').focus()
      status('settings-status', '')
    })
  })
  for (const button of document.querySelectorAll('[data-copy]')) {
    on(button, 'click', () => { void copy(button.dataset.copy) })
  }

  function dispose() {
    if (local.signal.aborted) return
    local.abort()
    unsubscribe?.()
    cancelPlayback()
    $('retry-player').onclick = null
    ctx.signal?.removeEventListener('abort', dispose)
  }
  window.addEventListener('pagehide', dispose, { once: true })
  ctx.signal?.addEventListener('abort', dispose, { once: true })
  if (ctx.signal?.aborted) dispose()
  else void loadCategories()
  return dispose
}

let started = false
function start() {
  if (!started && window.DIAN115Plugin) {
    started = true
    mount(window.DIAN115Plugin)
  }
}
window.addEventListener('dian115:ready', start, { once: true })
start()
