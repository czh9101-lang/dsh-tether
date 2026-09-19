// 界面语言跟随手机系统语言:WebView 的 navigator.language 就是系统语言,不额外做开关——
// 多一个开关就多一处与系统不一致的状态,而手机上换语言本来就是去系统设置里换。
// 只分中英两种,dsh 自己的界面也只有这两种。
// index.html 里带 data-i18n* 的节点在 applyStatic() 里填,文案只存在这一处,不在 HTML 里留一份。
const zh = {
  'status.disconnected': '未连接',
  'status.connected': '已连接',
  'status.connectedTo': '已连接 · {name}',
  'status.connecting': '连接中…',
  'status.connectingTo': '连接 {name}…',
  'status.local': '本机 · DSH 运行中',
  'status.opening': '正在打开电脑上的 DeepSeek Harness…',
  'status.reconnect': '重新连接',
  'status.retry': '重试',
  'status.switch': '换一台电脑',
  'topbar.hosts': '主机',
  'local.title': '本机运行 DSH',
  'local.idle': '未启动',
  'local.running': '运行中',
  'local.hint': '没有电脑也能用:DeepSeek Harness 直接跑在这台手机上,会话和设置只存在手机里。',
  'local.start': '在本机运行',
  'local.open': '打开',
  'local.stop': '停止本机 DSH',
  'local.starting': '正在启动本机 DSH…',
  'hosts.title': '我的电脑',
  'hosts.hint': '配过的电脑都记在这台手机上,换一台不用重新配对。',
  'hosts.empty': '还没有配对过的电脑。',
  'hosts.add': '添加电脑',
  'hosts.back': '返回',
  'hosts.namePlaceholder': '给这台电脑起个名字',
  'hosts.save': '保存',
  'hosts.rename': '改名',
  'hosts.delete': '删除',
  'hosts.confirmDelete': '确认删除',
  'hosts.deleteWarning': '删除后需要重新配对才能连回来',
  'hosts.lastUsed': '{id} · 上次使用',
  'about.link': '项目主页',
  'pair.title': '添加电脑',
  'pair.hint': '电脑上跑 <code>dsh web</code> 后,插件会打印一行配对串,整行粘到下面即可。',
  'pair.peer': '配对串',
  'pair.peerPlaceholder': '粘贴电脑上显示的那一整行',
  'pair.code': '配对码(已在上面粘贴则免填)',
  'pair.codePlaceholder': '6 位数字',
  'pair.label': '给这台电脑起个名字',
  'pair.labelPlaceholder': '例如:家里的电脑',
  'pair.name': '本机名称(电脑上会显示成这个)',
  'pair.nameDefault': '我的手机',
  'pair.submit': '配对并连接',
  'pair.incomplete': '配对串不完整:要电脑上显示的那一整行',
  'common.cancel': '取消',
  'notify.title': '等待你批准:{tool}',
  'notify.someAction': '一个操作',
  'notify.body': '打开 DSH Tether 查看并批准',
}

const en = {
  'status.disconnected': 'Not connected',
  'status.connected': 'Connected',
  'status.connectedTo': 'Connected · {name}',
  'status.connecting': 'Connecting…',
  'status.connectingTo': 'Connecting to {name}…',
  'status.local': 'On this phone · DSH running',
  'status.opening': 'Opening the DeepSeek Harness on your computer…',
  'status.reconnect': 'Reconnect',
  'status.retry': 'Try again',
  'status.switch': 'Use another computer',
  'topbar.hosts': 'Machines',
  'local.title': 'Run DSH on this phone',
  'local.idle': 'Not running',
  'local.running': 'Running',
  'local.hint': 'No computer needed: the DeepSeek Harness runs on this phone, and its sessions and settings stay here.',
  'local.start': 'Run on this phone',
  'local.open': 'Open',
  'local.stop': 'Stop DSH on this phone',
  'local.starting': 'Starting DSH on this phone…',
  'hosts.title': 'My computers',
  'hosts.hint': 'Every computer you pair is remembered here, so switching back needs no new pairing.',
  'hosts.empty': 'No computer paired yet.',
  'hosts.add': 'Add a computer',
  'hosts.back': 'Back',
  'hosts.namePlaceholder': 'Name this computer',
  'hosts.save': 'Save',
  'hosts.rename': 'Rename',
  'hosts.delete': 'Remove',
  'hosts.confirmDelete': 'Confirm removal',
  'hosts.deleteWarning': 'Removing it means pairing again before you can connect',
  'hosts.lastUsed': '{id} · last used',
  'about.link': 'Project page',
  'pair.title': 'Add a computer',
  'pair.hint': 'Run <code>dsh web</code> on the computer; the plugin prints a pairing line — paste the whole line below.',
  'pair.peer': 'Pairing string',
  'pair.peerPlaceholder': 'Paste the whole line shown on the computer',
  'pair.code': 'Pairing code (skip it if the line above already has one)',
  'pair.codePlaceholder': '6 digits',
  'pair.label': 'Name this computer',
  'pair.labelPlaceholder': 'e.g. Desktop at home',
  'pair.name': "This phone's name (shown on the computer)",
  'pair.nameDefault': 'My phone',
  'pair.submit': 'Pair and connect',
  'pair.incomplete': 'Incomplete pairing string — paste the whole line shown on the computer',
  'common.cancel': 'Cancel',
  'notify.title': 'Waiting for your approval: {tool}',
  'notify.someAction': 'an action',
  'notify.body': 'Open DSH Tether to review and approve',
}

const lang = /^zh\b/i.test(navigator.language || '') ? 'zh' : 'en'
const dict = lang === 'zh' ? zh : en

/** 取文案;{name} 这类占位由 vars 填 */
function t(key, vars) {
  const text = dict[key] ?? zh[key] ?? key
  return vars === undefined ? text : text.replace(/\{(\w+)\}/g, (_, name) => vars[name] ?? '')
}

/** 把 index.html 里 data-i18n* 标记的节点填上文案 */
function applyStatic() {
  document.documentElement.lang = lang === 'zh' ? 'zh-CN' : 'en'
  for (const node of document.querySelectorAll('[data-i18n]')) node.textContent = t(node.dataset.i18n)
  // 只有自家词典里的内容会进 innerHTML(配对说明里要保留 <code>)
  for (const node of document.querySelectorAll('[data-i18n-html]')) node.innerHTML = t(node.dataset.i18nHtml)
  for (const node of document.querySelectorAll('[data-i18n-ph]')) node.placeholder = t(node.dataset.i18nPh)
  for (const node of document.querySelectorAll('[data-i18n-value]')) node.value = t(node.dataset.i18nValue)
}

window.t = t
// 自己填,不等 main.js:静态文案不该因为 main.js 里任何一行出错就整页空着
applyStatic()
