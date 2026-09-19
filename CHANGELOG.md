# 更新日志

本文件记录面向用户的变化。每个版本的这一节会原样作为该版本 Release 的说明。

## 0.1.17

### 修复

- **sidecar 自己的 `--help` 还是中文**([#8](https://github.com/zexadev/dsh-tether/issues/8))。0.1.16 把界面和终端输出都做了英文,唯独 `tether-host --help` 和每个参数的说明漏了,手跑二进制的人只能对着中文猜参数。现在帮助文本也按语言出中英。
- **Windows 和 macOS 上手跑 sidecar 恒出中文**。判定语言只认 `LC_ALL`/`LANG`,而这两个系统本来就不设这两个变量,英文用户于是必得中文。现在环境变量没有就问系统语言。
- **配对失败的原因在手机上显示成中文**。原因是电脑侧直接把中文句子发给了手机——这句该由看到它的那一端来措辞。线上改成只传原因码,手机 App 和 dsh 界面各按自己那侧的语言显示。另有几处写死的中文一并补齐(phone-sim 的代理就绪、本地代理监听失败、前台服务日志、移除设备失败)。

### English

This release finishes what 0.1.16 started: `tether-host --help` and all option descriptions are now English on an English machine, the language is detected from the system when `LC_ALL`/`LANG` are unset (which is the normal case on Windows and macOS), and a failed pairing is now worded by whichever side displays it, so the phone no longer shows a Chinese reason. Nothing a user can see is Chinese-only any more; if you find something, please open an issue.

## 0.1.16

### 新增

- **英文界面**([#8](https://github.com/zexadev/dsh-tether/issues/8))。手机 App 的界面、连接与本地模式的报错、常驻通知,以及电脑上插件与 sidecar 打在终端里的输出,现在都有英文。没有单独的语言开关,各处跟随各自那一侧的语言:App 跟手机的系统语言,终端输出跟电脑的系统语言,插件注入在 dsh 界面里的那部分(侧栏按钮、配对串弹窗、已配对手机列表)跟 dsh 自己的语言设置,在 dsh 设置里切换语言即时生效。dsh 界面本身的语言仍由 dsh 的设置决定。

## 0.1.15

### 新增

- **手机本地模式内置的 dsh 升到 `0.1.5-rc.2`**(此前是 `0.1.2-rc.1`)。升级后第一次进入本地模式会重新解压运行时(约 9 秒);手机上已有的会话会在打开时自动迁移到新版日志格式,内容不丢。dsh 本身的变化见它自己的更新说明。

### 修复

- **电脑上的 dsh 升到 0.1.5 后,手机上的版式右侧一列错位、对话区被挤窄**。上游把布局类名从 `detailsCol` 改成了 `rightbarCol`,插件注入的窄屏样式匹配不到就静默失效。两个名字现在都兼容,新旧 dsh 都正常。

## 0.1.14

### 修复

- **Android 本地模式:每一轮对话都失败,报 `EACCES: permission denied, link ...`**([#9](https://github.com/zexadev/dsh-tether/issues/9))。Android 系统的 SELinux 策略禁止普通 App 创建硬链接,与机型、ROM、系统版本无关;dsh 新会话首次落盘用的正是硬链接,所以 0.1.13 的本地模式在任何手机上都新建不了会话,发送图片也会以 `ATTACHMENT_WRITE_FAILED` 失败。现在本地模式内置的 dsh 在硬链接被拒时改为「写一份副本并落盘 → 确认目标不存在 → 原子改名」,文件仍然完整出现、不会覆盖已有会话。升级后第一次进入本地模式会重新解压运行时(约 9 秒)。远程模式(连电脑)不受影响。

## 0.1.13

### 新增

- **Android 本地模式:没电脑也能用,DSH 直接跑在手机上**。同一个 App 两种模式:有电脑连电脑(原有能力),没电脑在「主机」页点「在本机运行」。Node 24 与 dsh `0.1.2-rc.1` 的完整依赖树打在 `arm64` APK 里,首次启动离线解压(实测 9 秒),之后每次约 2 秒;没有配对、没有远端,会话和设置只存在手机里,与连电脑时的状态完全分开;运行期间挂一条常驻通知(前台服务),退后台、锁屏不被系统收掉,进程被杀后下次打开自动重起。手机上的 dsh 同样带窄屏适配。只有 `arm64` 包带本地模式(约 71 MB,其余包约 32 MB);iOS 沙箱不允许子进程,没有这个入口。手机上没有 bash 与完整 coreutils,依赖 shell 的工具用不全。
- 顶栏常驻「主机」按钮,任何模式下都能回到主机页。

### 变更

- 插件 `peerDependencies` 加入 dsh `0.1.5` 版本族;`0.1.2-rc.1` 与 `0.1.5-alpha.1` 已在隔离环境实测(patch、cookie 兑换、路由栅栏、侧栏注入、经代理流的手机链路)。实测 pnpm 在 peer 范围不含当前版本族时照常安装且无警告,该声明只记录已验证范围。
- 插件新增 `config.sidecar: false`:只做界面适配,不找也不起 sidecar;供手机本地模式使用。
- README、网页与包描述改为如实表述:直连优先,打不通才退回 relay,relay 只见密文;不再写「不经过任何服务器」。
## 0.1.12

### 修复

- **Termux:`tether-host` 启动时打一段 `android context was not initialized` 的 panic 栈**([#5](https://github.com/zexadev/dsh-tether/issues/5))。iroh 默认解析器在 android 上经 JNI 读系统 DNS,Termux 没有 JVM;iroh 内部接住 panic 后回退 Google DNS,进程照常工作,但栈已经打出来了。现在 android 目标直接用等价的解析器,不再走 JNI。
- **侧栏底部「连接手机」按钮与 dsh-cost-meter 互挤,被压成只剩图标的竖条**([#7](https://github.com/zexadev/dsh-tether/issues/7))。两者共用 `sidebar.footer.action` 插槽,横排下互挤。现改为纵向堆叠、各占一行,展开态与折叠成图标条两种状态都与「设置」按钮几何一致。
- **手机每次打开 App,dsh web UI 都当作全新访问;配合 Prefab Anchored Standard 一类一进会话就写入历史的预设,每开一次多一条会话**([#7](https://github.com/zexadev/dsh-tether/issues/7))。手机侧本地代理端口此前每次连接随机,web UI 按源保存的「当前会话」等状态永远读不到。现在端口按主机派生固定,同一台电脑每次同源;不同电脑不同源,状态互不串。

## 0.1.11

### 新增

- **`tether-host` 新增 android-arm64 平台子包,支持在 Termux 里跑**([#5](https://github.com/zexadev/dsh-tether/issues/5))。sidecar 本身是与 tauri 无关的纯 CLI,交叉编译到 `aarch64-linux-android`(NDK,API 24)与其余四个平台走的是同一套打包流程。Termux 的 Node 把 `process.platform` 报成 `android`(不是 `linux`),`index.js` 现有的自动选包逻辑按这个字段筛,所以是新增一个平台子包而不是复用 linux-arm64。

### 修复

- **iOS:配对必然 `timed out`,主机侧完全收不到配对请求**([#6](https://github.com/zexadev/dsh-tether/issues/6))。iOS 14 起,发往同网段私网 IP 的收发受内核层 Local Network Privacy 管控,且不区分是否经 NWFramework——iroh/quinn 用的原始 UDP socket 同样受限。此前 `Info.ios.plist` 只有 `NSAllowsLocalNetworking`(管 WebView 加载本机代理页面的 ATS 例外),没有 `NSLocalNetworkUsageDescription`,系统既不弹权限询问也不放行局域网收发。

  现补上这个键,系统会弹一次性授权询问。**本修复未在 iOS 真机验证**,由用户反馈发现;若升级后仍 timed out,麻烦在 issue 里确认安装后是否弹出过「本地网络」权限询问、以及设置里该权限是否开启。

## 0.1.10

### 修复

- **macOS / Linux:sidecar 起不来,配对时报「sidecar 没有在 5 秒内给出配对码」,终端见 Permission denied**。npm 平台子包里的 `tether-host` 二进制自首个版本起就缺可执行位——CI 的 artifact 传输不保留 Unix 权限位,打包时原样带进了 tgz。Windows 不看执行位,故只在 Mac/Linux 上暴露。由 Mac 用户反馈发现。

  现打包前补回执行位,并对每个发布产物断言执行位存在,缺位则发布直接失败。**Mac/Linux 用户升级本版即修复**:`dsh plugin --profile web add dsh-plugin-tether@0.1.10`。如暂不升级,也可手动 `chmod 0755` 装好的 `dsh-tether-host-*/bin/tether-host` 应急。

- sidecar 启动失败不再只留一句干瘪的错误:插件现在会接住并打印可读原因(EACCES 附排查提示),「连接手机」弹窗里也会立即显示原因,而不是干等 5 秒换一个 504。

## 0.1.9

### 新增

- **适配 dsh 0.1.2-alpha 的浏览器认证**([#4](https://github.com/zexadev/dsh-tether/issues/4))。dsh 0.1.2-alpha 起,网页界面与 Host API 要求持有经启动 token 兑换的签名 cookie,无凭据一律 401——手机端表现为连上后一片 401 提示。

  适配完全在电脑侧完成:插件启动时自动完成 token→cookie 兑换,sidecar 在代理出口把认证注入每个转发请求。**手机 App 无需更新**;dsh 的跨站请求防护经隧道原样保留(伪造来源仍被 403 拒绝)。

  cookie 是 `SameSite=Strict` 且绑定地址端口,手机 WebView 的内嵌页面属跨站上下文、cookie 根本不会随请求发出,所以「把登录链接发给手机打开」这条路在浏览器规则下走不通,注入只能发生在电脑侧。

- 继续兼容 dsh 0.1.0-rc.7 / rc.8:旧版没有浏览器认证,代理保持原样透传,行为不变。

## 0.1.8

### 修复

- **iOS:连接成功但界面空白**。iOS 的 App Transport Security 默认禁止 WebView 加载明文 HTTP,而手机端的界面正是从本机代理出口 `http://127.0.0.1:<端口>` 加载的。安卓侧一直有对应配置放行回环流量,iOS 侧没有。iroh 连接是原生代码不受 ATS 约束,所以「显示已连接」与「界面空白」会同时出现。

  现只放行回环、`.local` 与链路本地地址(`NSAllowsLocalNetworking`),其余域仍受 ATS 约束——与安卓侧只放行 `127.0.0.1` / `localhost` 的做法一致。

  由用户反馈发现。**本修复未在 iOS 真机验证**,若仍有问题请在 issue 里补充电脑侧终端的完整输出。

### 新增

- 手机第一次开始加载界面时,电脑侧会打印「手机已开始加载界面」。此前电脑侧对代理流完全静默,「连上却空白」无从判断是手机压根没发请求,还是发了但转发不通。

## 0.1.7

### 元数据

- **补上 `repository`、`homepage`、`bugs`、`author`**。主包与五个平台子包此前在 npm 上都没有仓库链接,`npm view repository` 为空——包页面上看不到出处。插件目录站按 `repository` 回链核实包与仓库的对应关系,缺这个字段就建立不起对应。
- **描述与关键词改为覆盖真实搜索词**。原描述里没有 Android、iOS、mobile、remote 这些词,而目录站的搜索匹配的正是描述文本:实测搜 `phone`、`手机` 能命中,搜 `android`、`mobile`、`远程` 则排不进前列。

本版无代码变更。

## 0.1.6

### 安全

- **身份密钥与配对白名单改为仅属主可读**。此前这些文件以默认权限写入,在 Unix 上通常是 `0644`——同一台机器上任何本地用户都能读到 `identity.key`(32 字节裸私钥),读到即可冒充主机、给自己签发配对码,从而取得对 dsh 界面的完整访问权。

  这比此前文档中已说明的边界更宽:那条边界要求攻击者能在机器上执行代码,而本问题**只需读权限**。

  受影响的是 Linux 与 macOS;Windows 无 POSIX 权限位,不受影响。**升级即修复**:程序在读取既有密钥时会一并收紧权限,不需要重新配对,主机身份也不会变。

  由 [@kagura-agent](https://github.com/kagura-agent) 报告([#1](https://github.com/zexadev/dsh-tether/issues/1))。

### 修复

- **私密文件改为原子写**。此前是就地截断再写,写入过程中掉电或进程被杀会留下半截文件;对 `identity.key` 而言等同于主机身份丢失,所有已配对的手机都需重新配对。现改为先写临时文件再 rename,目标文件要么是旧内容要么是新内容。

## 0.1.5

### 新增

- **iOS 客户端(测试版)**。Release 里新增 `dsh-tether-<版本>-ios-unsigned.ipa`,未签名,需要自行签名安装(AltStore、Sideloadly 等)。功能与安卓版一致:同样的 iroh 直连、同样显示 DSH 自己的完整界面、同样的配对流程。

  **请当作测试版对待。** 本项目没有 Mac,这个包只在 CI 上构建过,**从未在真机上运行**——能编译、结构正确、架构是 arm64 真机版,但装上去是否可用、连接与通知是否正常,一概未经验证。遇到任何问题请提 issue,附上 iOS 版本与签名方式,我按反馈修。

  自签的有效期取决于你的账号:免费 Apple ID 签的应用 7 天过期,付费开发者账号一年。

## 0.1.4

### 兼容性

- **确认支持 dsh `0.1.0-rc.8`**。已在 rc.8 环境下逐项核对本插件依赖的上游接触面:patch 引用的三个包名仍存在且 patch 实际生效(`--dump-config` 可见 `directory-picker` 已停用、两个 browse 条目已挂上);窄屏样式依赖的布局 class 未变;`sidebar.footer.action` 与 `settings.trigger` 两个插槽仍在;插件的三条 HTTP 路由均正常且跨站请求仍被拒。
- `peerDependencies` 由精确的 `0.1.0-rc.7` 放宽为 `>=0.1.0-rc.7`。此前的精确版本号会让 rc.8 用户在安装时收到 unmet peer 警告,而两个版本实测都可用。

## 0.1.3

### 新增

- **电脑端可以查看并移除已配对的手机**。侧栏「连接手机」弹出的配对串下方新增列表,显示每台手机的名字、ID 前 8 位与在线状态,可逐台移除。
  此前白名单只增不减,而手机每重装一次 App 就会生成一把新的身份密钥,旧的那把仍留在白名单里持有访问权,电脑端却没有任何入口能看见或撤销它们——只能手工编辑 `paired.json`。
  移除会同时断开该手机当前的连接:白名单只在握手时读取一次,若不主动断开,正连着的那台要等它自己下线才真正失效。
- 手机端「我的电脑」页脚的项目主页链接现在可用,由系统浏览器打开。此前该链接为空,不显示。

### 文档

- 补上 LINUX DO 社区链接与徽章。
- 32 位 APK 的实际文件名是 `arm` 而非 `armv7`,文档按实际产出更正。
- 移除配对章节中包含真实配对串的截图。

## 0.1.2

### 新增

- **APK 改为四个 CPU 架构全量构建**:`arm64`、`arm`、`x86`、`x86_64`。此前只构建 `aarch64`,而产物却被命名为 `universal`——那是「不按 ABI 拆分」这个构建变体的名字,不代表包含所有架构;解包可见其中只有 `arm64-v8a`。
- APK 文件名改为 `dsh-tether-<版本>-<架构>.apk`,此前是不含版本号的 `app-universal-release.apk`。

### 移除

- 删除 `dsh-tunnel`——插件化之前的独立隧道原型,其能力已由 `tether-host --proxy-target` 覆盖。

## 0.1.1

### 新增

- **新增 `linux-arm64` 平台子包**。主包的 `optionalDependencies` 本已声明五个平台,构建矩阵却只产出四个;缺失的那个按 npm 的可选依赖语义被静默跳过,安装期毫无提示,直到运行时才会发现找不到二进制。
- 打 tag 时自动发布到 npm,先发平台子包再发主包。

## 0.1.0

首个发布版本。

- DeepSeek Harness 插件 + Android App,通过 iroh P2P 直连,中间不经过任何服务器。
- 手机上显示的是 DSH 自身的完整 Web 界面,窄屏下注入最小样式适配(侧栏改抽屉、设置页导航横排)。
- 6 位配对码,10 分钟有效,每窗口 3 次尝试上限;配对后凭手机的 iroh 公钥授权。
- 手机端可保存多台电脑并切换;agent 等待审批时推送系统通知。
- 平台子包覆盖 win32-x64、darwin-x64、darwin-arm64、linux-x64。
