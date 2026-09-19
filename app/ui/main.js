const { invoke } = window.__TAURI__.core
const { listen } = window.__TAURI__.event
const notification = window.__TAURI__.notification

/** 项目主页;为空则主机页底部不显示入口 */
const PROJECT_URL = 'https://github.com/zexadev/dsh-tether'

const el = (id) => document.getElementById(id)
const views = { hosts: el('view-hosts'), pair: el('view-pair'), status: el('view-status') }

// 静态文案在任何视图显示之前填好,否则先渲染出来的是空白节点
applyStaticI18n()

/** 连接已建立且 web UI 正在显示——决定「取消/返回」该退回哪里 */
let live = false
let book = { hosts: [], current: null }
/** 本次连的是哪台;顶栏据此显示主机名,人才知道自己在操作哪台电脑 */
let connectingTo = null
/** 'remote' 连电脑 / 'local' 手机本地跑 dsh;远程状态事件只在 remote 模式下起作用 */
let mode = 'remote'
/** 本地模式代理的 URL;进程还活着时切回来不用重起 */
let localUrl = null
const LAST_MODE_KEY = 'dsh-tether:lastMode'
function rememberMode(m) {
  try { localStorage.setItem(LAST_MODE_KEY, m) } catch {}
}

function showView(name) {
  for (const [k, v] of Object.entries(views)) v.classList.toggle('hidden', k !== name)
  el('webui').classList.add('hidden')
  setSlim(false)
  // 连接还活着时,主机页和配对页都能原路退回,不必重连
  el('hosts-back').classList.toggle('hidden', !live)
  el('pair-cancel').classList.toggle('hidden', false)
}

/** web UI 的来源;只认这个源发来的消息 */
let webUiOrigin = null

// 主机的完整 dsh web UI 顶上来:顶栏收窄成一条,把高度还给它
function showWebUi(url) {
  const frame = el('webui')
  webUiOrigin = new URL(url).origin
  // 每次连上都重载:端口按主机派生后 URL 前后一致,而上一条连接的代理监听
  // 已随连接一起结束,旧页面里的 WebSocket 是死的,不重载就停在那儿。
  frame.src = url
  for (const v of Object.values(views)) v.classList.add('hidden')
  frame.classList.remove('hidden')
  setSlim(true)
  live = true
}

/** 回到已经连着的会话,不动连接 */
function backToLive() {
  const frame = el('webui')
  if (live && frame.getAttribute('src')) {
    for (const v of Object.values(views)) v.classList.add('hidden')
    frame.classList.remove('hidden')
    setSlim(true)
    return true
  }
  return false
}

function setSlim(slim) {
  el('topbar').classList.toggle('slim', slim)
  el('topbar-hosts').classList.toggle('hidden', !slim)
}

function setStatus(status, text) {
  el('status-dot').className = 'dot ' + (status === 'connected' ? 'dot-on' : status === 'connecting' ? 'dot-connecting' : 'dot-off')
  el('status-text').textContent = text
}

// —— 待审批通知 ——
// 审批在上面那个 web UI 里点(它就是 dsh 自己的界面)。通知只负责把
// 「agent 卡住了」送到锁屏——人不看手机就不知道,这是移动端不可替代的部分。

let notifyAllowed = false

async function ensureNotifyPermission() {
  if (notification === undefined) return
  notifyAllowed = await notification.isPermissionGranted()
  if (!notifyAllowed) notifyAllowed = (await notification.requestPermission()) === 'granted'
}

function notifyApproval({ toolName, reason }) {
  if (!notifyAllowed) return
  notification.sendNotification({
    title: t('notify.title', { tool: toolName || t('notify.someAction') }),
    body: reason || t('notify.body'),
  })
}

// —— 主机列表 ——

const shortId = (id) => id.slice(0, 8) + '…' + id.slice(-4)

/** 主机的显示名:配对时起的名字,没起就退回 ID 缩写 */
function hostName(id) {
  const host = book.hosts.find((h) => h.id === id)
  return host === undefined ? '' : (host.label || shortId(host.id))
}

/** 行内模式:'view' 浏览 / 'rename' 改名 / 'confirm' 确认删除 */
const rowMode = new Map()

function showHostsError(e) {
  const box = el('hosts-error')
  box.textContent = String(e)
  box.classList.remove('hidden')
}

async function runHostAction(promise) {
  try {
    book = await promise
    el('hosts-error').classList.add('hidden')
  } catch (e) {
    showHostsError(e)
  }
  renderHosts()
  if (live) showConnectedLabel()
}

function slimButton(text, onClick, quiet) {
  const b = document.createElement('button')
  b.className = 'btn btn-slim' + (quiet ? ' btn-slim-quiet' : '')
  b.textContent = text
  b.addEventListener('click', onClick)
  return b
}

function renderHosts() {
  const list = el('host-list')
  list.replaceChildren()
  for (const host of book.hosts) {
    const mode = rowMode.get(host.id) ?? 'view'
    const li = document.createElement('li')
    li.className = 'host-item'

    if (mode === 'rename') {
      const input = document.createElement('input')
      input.className = 'host-rename'
      input.value = host.label
      input.placeholder = t('hosts.namePlaceholder')
      const save = () => {
        rowMode.delete(host.id)
        runHostAction(invoke('rename_host', { id: host.id, label: input.value }))
      }
      input.addEventListener('keydown', (e) => { if (e.key === 'Enter') save() })
      li.append(input, slimButton(t('hosts.save'), save), slimButton(t('common.cancel'), () => {
        rowMode.delete(host.id)
        renderHosts()
      }, true))
      list.append(li)
      input.focus()
      continue
    }

    const main = document.createElement('button')
    main.className = 'host-pick'
    const name = document.createElement('span')
    name.className = 'host-name'
    name.textContent = host.label || shortId(host.id)
    const meta = document.createElement('span')
    meta.className = 'host-meta'
    meta.textContent = mode === 'confirm'
      ? t('hosts.deleteWarning')
      : (host.id === book.current ? t('hosts.lastUsed', { id: shortId(host.id) }) : shortId(host.id))
    main.append(name, meta)
    if (mode === 'view') main.addEventListener('click', () => { startConnect(host.id) })
    li.append(main)

    if (mode === 'confirm') {
      li.append(slimButton(t('hosts.confirmDelete'), () => {
        rowMode.delete(host.id)
        runHostAction(invoke('forget_host', { id: host.id }))
      }), slimButton(t('common.cancel'), () => {
        rowMode.delete(host.id)
        renderHosts()
      }, true))
    } else {
      li.append(slimButton(t('hosts.rename'), () => {
        rowMode.set(host.id, 'rename')
        renderHosts()
      }, true), slimButton(t('hosts.delete'), () => {
        rowMode.set(host.id, 'confirm')
        renderHosts()
      }, true))
    }
    list.append(li)
  }
  el('hosts-empty').classList.toggle('hidden', book.hosts.length > 0)
}

/** 顶栏的「已连接 · X」;改名后要跟着变,所以单独一处 */
function showConnectedLabel() {
  if (mode === 'local') {
    setStatus('connected', t('status.local'))
    return
  }
  const n = hostName(connectingTo)
  setStatus('connected', n ? t('status.connectedTo', { name: n }) : t('status.connected'))
}

async function refreshHosts() {
  book = await invoke('list_hosts')
  renderHosts()
  await refreshLocalCard()
  if (live) showConnectedLabel()
}

// —— 连接状态 ——

function onState({ status, detail }) {
  // 切到本地模式后远程连接可能仍在收尾,它的断开不该把本机界面撤掉
  if (mode !== 'remote') return
  if (status === 'connected') {
    live = true
    showConnectedLabel()
    // 刚配对完的主机还不在本地簿里,取回来补上名字
    if (hostName(connectingTo) === '') refreshHosts().catch(() => {})
    el('reconnect-row').classList.add('hidden')
  } else if (status === 'connecting') {
    const n = hostName(connectingTo)
    setStatus('connecting', n ? t('status.connectingTo', { name: n }) : t('status.connecting'))
  } else {
    live = false
    setStatus('disconnected', t('status.disconnected'))
    el('webui').removeAttribute('src')
    // 配对页正开着就把失败原因显示在那里,别把用户踢走
    if (!views.pair.classList.contains('hidden')) {
      const err = el('pair-error')
      err.textContent = detail
      err.classList.remove('hidden')
      el('pair-submit').disabled = false
      return
    }
    showView('status')
    el('connecting-note').classList.add('hidden')
    el('reconnect-text').textContent = detail
    el('reconnect-row').classList.remove('hidden')
  }
}

function startConnect(id) {
  mode = 'remote'
  rememberMode('remote')
  el('connecting-note').textContent = t('status.opening')
  connectingTo = id ?? book.current ?? (book.hosts[0]?.id ?? null)
  el('reconnect-row').classList.add('hidden')
  el('connecting-note').classList.remove('hidden')
  showView('status')
  invoke('connect', { id: id ?? null }).catch((e) => onState({ status: 'disconnected', detail: String(e) }))
}

// —— 配对 ——

function openPairView() {
  el('pair-error').classList.add('hidden')
  el('pair-submit').disabled = false
  showView('pair')
}

el('pair-submit').addEventListener('click', async () => {
  const err = el('pair-error')
  err.classList.add('hidden')
  let peer = el('pair-peer').value.trim()
  let code = el('pair-code').value.trim()
  // 支持「主机ID#配对码」整行粘贴
  if (peer.includes('#')) {
    const [p, c] = peer.split('#', 2)
    peer = p.trim()
    if (!code) code = c.trim()
  }
  if (!peer || !code) {
    err.textContent = t('pair.incomplete')
    err.classList.remove('hidden')
    return
  }
  el('pair-submit').disabled = true
  live = false
  el('connecting-note').classList.remove('hidden')
  showView('status')
  connectingTo = peer
  try {
    await invoke('pair', { peer, code, name: el('pair-name').value, label: el('pair-label').value })
    await refreshHosts()
  } catch (e) {
    el('pair-error').textContent = String(e)
    openPairView()
    el('pair-error').classList.remove('hidden')
  }
})

// 取消/返回:连接还活着就原路回到会话,什么都不重连
el('pair-cancel').addEventListener('click', () => {
  if (backToLive()) return
  showView('hosts')
})
el('hosts-back').addEventListener('click', () => {
  if (backToLive()) return
  showView('status')
})
el('add-host').addEventListener('click', openPairView)
el('reconnect').addEventListener('click', () => { if (mode === 'local') startLocal(); else startConnect(null) })
el('topbar-hosts').addEventListener('click', () => { refreshHosts(); showView('hosts') })
el('local-open').addEventListener('click', () => { startLocal() })
el('local-stop').addEventListener('click', () => { stopLocal() })
el('open-hosts').addEventListener('click', () => { refreshHosts(); showView('hosts') })

// 主机页的入口在 dsh 侧栏底部(插件往 sidebar.footer.action 插槽挂的按钮),
// 那个按钮在 iframe 里、跨源,只能经 postMessage 过来;只认 web UI 那个源。
window.addEventListener('message', (e) => {
  if (webUiOrigin === null || e.origin !== webUiOrigin) return
  if (e.data?.type !== 'dsh-tether:open-hosts') return
  refreshHosts()
  showView('hosts')
})

// 回前台即重连:Android 会在后台掐掉网络,回来时旧连接多半已死。
// 本地模式则看 node 进程还在不在,被系统杀了就重起(会话已落盘,不丢)。
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') return
  if (!views.pair.classList.contains('hidden') || !views.hosts.classList.contains('hidden')) return
  if (mode === 'local') {
    invoke('local_status').then((st) => { if (!st.running) startLocal() }).catch(() => {})
    return
  }
  if (!live && book.hosts.length > 0) startConnect(null)
})

// —— 本地模式 ——

/** 主机页顶部的「本机」卡片:这个构建有运行时才显示;在跑就给「打开 / 停止」 */
async function refreshLocalCard() {
  let st
  try { st = await invoke('local_status') } catch { st = { available: false, running: false, url: null } }
  const card = el('local-card')
  card.classList.toggle('hidden', !st.available)
  if (!st.available) return
  el('local-state').textContent = t(st.running ? 'local.running' : 'local.idle')
  el('local-open').textContent = t(st.running ? 'local.open' : 'local.start')
  el('local-stop').classList.toggle('hidden', !st.running)
  if (st.running) localUrl = st.url
}

function onLocalState({ status, detail }) {
  if (mode !== 'local') return
  // 解压与启动的进度都打在状态页那行字上
  el('connecting-note').textContent = detail
}

async function startLocal() {
  mode = 'local'
  rememberMode('local')
  connectingTo = null
  el('local-error').classList.add('hidden')
  el('reconnect-row').classList.add('hidden')
  el('connecting-note').textContent = t('local.starting')
  el('connecting-note').classList.remove('hidden')
  showView('status')
  try {
    localUrl = await invoke('local_start')
  } catch (e) {
    live = false
    el('webui').removeAttribute('src')
    el('connecting-note').classList.add('hidden')
    el('reconnect-text').textContent = String(e)
    el('reconnect').textContent = t('status.retry')
    el('reconnect-row').classList.remove('hidden')
    return
  }
  el('reconnect').textContent = t('status.reconnect')
  showWebUi(localUrl)
  setStatus('connected', t('status.local'))
}

async function stopLocal() {
  try { await invoke('local_stop') } catch {}
  // 界面正显示着本机就一并撤掉;显示的是远程的话不动它
  if (mode === 'local') {
    live = false
    el('webui').removeAttribute('src')
    setStatus('disconnected', t('status.disconnected'))
    mode = 'remote'
  }
  localUrl = null
  await refreshLocalCard()
  showView('hosts')
}

// —— 启动 ——

async function boot() {
  await listen('remote:state', (e) => onState(e.payload))
  await listen('remote:proxy-ready', (e) => showWebUi(e.payload.url))
  await listen('remote:approval', (e) => notifyApproval(e.payload))
  await listen('local:state', (e) => onLocalState(e.payload))
  await ensureNotifyPermission()
  invoke('app_version')
    .then((v) => { el('about-version').textContent = `DSH Tether v${v}` })
    .catch(() => {})
  if (PROJECT_URL !== '') {
    const link = el('about-link')
    // 不能让 href 生效:WebView 会就地导航过去,把 App 界面顶掉且退不回来。
    // 交给 opener 插件,由系统浏览器打开。
    link.addEventListener('click', (e) => {
      e.preventDefault()
      invoke('plugin:opener|open_url', { url: PROJECT_URL }).catch(() => {})
    })
    link.classList.remove('hidden')
  }
  await refreshHosts()
  let lastMode = null
  try { lastMode = localStorage.getItem(LAST_MODE_KEY) } catch {}
  const localAvailable = !el('local-card').classList.contains('hidden')
  if (lastMode === 'local' && localAvailable) startLocal()
  else if (book.hosts.length > 0) startConnect(null)
  else if (localAvailable) showView('hosts')
  else showView('pair')
}
boot()
