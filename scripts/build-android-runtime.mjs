// Android 本地模式的运行时打包。产物进 app/src-tauri/android-runtime/(不入 git):
//   jniLibs/arm64-v8a/libnode.so     Node 可执行文件。Android 10+ 只允许 exec APK
//                                    原生库目录里的文件,所以它必须以 lib*.so 的身份进 APK
//   assets/dsh-runtime.tar           其余全部:node 的共享库、openssl.cnf、dsh 依赖树、
//                                    DSH_HOME 骨架、manifest.json;首启由 App 解压到数据目录
//
// 两种用法:
//   node scripts/build-android-runtime.mjs            按 package.json 里钉住的版本组装(默认)
//   node scripts/build-android-runtime.mjs mirror     从 Termux 仓库重做 Node 运行时镜像包
//
// Node 来自 Termux 仓库的 nodejs-lts(唯一现成的 bionic 链接、动态依赖只有八个库的 Node)。
// Termux 的 apt 仓库是滚动的,旧版本 deb 会从 pool 消失,所以 Node 运行时先做成镜像包
// 挂在本仓库 Release 上,默认模式只从镜像取;`mirror` 模式才碰 Termux。
import { createWriteStream, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, readdirSync, statSync, copyFileSync, cpSync } from 'node:fs'
import { pipeline } from 'node:stream/promises'
import { Readable } from 'node:stream'
import { execFileSync, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join, basename } from 'node:path'
import { platform, tmpdir } from 'node:os'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const pin = pkg.dsh?.androidRuntime
if (!pin?.node || !pin?.dsh) throw new Error('package.json 缺 dsh.androidRuntime.{node,dsh}')

const OUT = join(root, 'app', 'src-tauri', 'android-runtime')
const CACHE = join(OUT, 'cache')
const MIRROR_TAG = `android-runtime-node${pin.node}`
const MIRROR_NAME = `node-android-arm64-${pin.node}.tar.gz`
const MIRROR_URL = `https://github.com/zexadev/dsh-tether/releases/download/${MIRROR_TAG}/${MIRROR_NAME}`

// Termux 包与版本:只在 mirror 模式用。改 Node 版本时同步改这里和 package.json 的钉。
const TERMUX_BASE = 'https://packages.termux.dev/apt/termux-main'
const TERMUX_DEBS = {
  'nodejs-lts': `pool/main/n/nodejs-lts/nodejs-lts_${pin.node}-1_aarch64.deb`,
  'libc++': 'pool/main/libc/libc++/libc++_29_aarch64.deb',
  openssl: 'pool/main/o/openssl/openssl_1:3.6.3_aarch64.deb',
  'c-ares': 'pool/main/c/c-ares/c-ares_1.34.8_aarch64.deb',
  libicu: 'pool/main/libi/libicu/libicu_78.3_aarch64.deb',
  libsqlite: 'pool/main/libs/libsqlite/libsqlite_3.53.4_aarch64.deb',
  zlib: 'pool/main/z/zlib/zlib_1.3.2_aarch64.deb',
}
// node 二进制 NEEDED 的全部共享库(llvm-readelf -d 查得),按 soname 列出
const NODE_LIBS = ['libz.so.1', 'libcares.so', 'libsqlite3.so', 'libcrypto.so.3', 'libssl.so.3', 'libicui18n.so.78', 'libicuuc.so.78', 'libicudata.so.78', 'libc++_shared.so']
const TERMUX_PREFIX = 'data/data/com.termux/files/usr'

const log = (...a) => console.log('[android-runtime]', ...a)
const tar = platform() === 'win32' ? 'C:\\Windows\\System32\\tar.exe' : 'tar'

async function download(url, dest) {
  if (existsSync(dest)) return dest
  mkdirSync(dirname(dest), { recursive: true })
  log('下载', url)
  const r = await fetch(url, { redirect: 'follow' })
  if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`)
  const tmp = dest + '.part'
  await pipeline(Readable.fromWeb(r.body), createWriteStream(tmp))
  copyFileSync(tmp, dest)
  rmSync(tmp)
  return dest
}

/** .deb 是 ar 归档;60 字节定长头。只取 data.tar.* 写出去,交给系统 tar 解 xz */
function extractDeb(deb, into) {
  const buf = readFileSync(deb)
  if (buf.subarray(0, 8).toString() !== '!<arch>\n') throw new Error(`${deb} 不是 ar 归档`)
  let off = 8
  while (off + 60 <= buf.length) {
    // GNU ar 的条目名以 / 结尾(data.tar.xz/)
    const name = buf.subarray(off, off + 16).toString().trim().replace(/\/$/, '')
    const size = Number(buf.subarray(off + 48, off + 58).toString().trim())
    const start = off + 60
    if (name.startsWith('data.tar')) {
      const out = join(into, name)
      writeFileSync(out, buf.subarray(start, start + size))
      execFileSync(tar, ['-xf', out, '-C', into], { stdio: 'inherit' })
      rmSync(out)
      return
    }
    off = start + size + (size % 2)
  }
  throw new Error(`${deb} 里没有 data.tar`)
}

function ndkBin() {
  const home = process.env.NDK_HOME || process.env.ANDROID_NDK_HOME
    || (process.env.ANDROID_HOME && (() => {
      const d = join(process.env.ANDROID_HOME, 'ndk')
      const vers = existsSync(d) ? readdirSync(d).sort() : []
      return vers.length ? join(d, vers[vers.length - 1]) : undefined
    })())
  if (!home) throw new Error('找不到 NDK:设 NDK_HOME')
  const host = { win32: 'windows-x86_64', linux: 'linux-x86_64', darwin: 'darwin-x86_64' }[platform()]
  const bin = join(home, 'toolchains', 'llvm', 'prebuilt', host, 'bin')
  if (!existsSync(bin)) throw new Error(`NDK 里没有 ${bin}`)
  return bin
}

/** node-pty 没有 android 预编译;unix 实现就一个 pty.cc,用 NDK clang 直接编 */
function buildPtyNode(nodeInclude, ptySrcDir, out) {
  const bin = ndkBin()
  const cxx = join(bin, platform() === 'win32' ? 'aarch64-linux-android24-clang++.cmd' : 'aarch64-linux-android24-clang++')
  const napi = join(ptySrcDir, '..', 'node-addon-api')
  const args = ['-shared', '-fPIC', '-O2', '-std=c++17', '-fexceptions', '-Wall',
    '-DNAPI_CPP_EXCEPTIONS', '-DBUILDING_NODE_EXTENSION', '-DNAPI_VERSION=9',
    `-I${nodeInclude}`, `-I${napi}`, join(ptySrcDir, 'src', 'unix', 'pty.cc'), '-o', out, '-static-libstdc++']
  log('编译 pty.node')
  const r = spawnSync(cxx, args, { stdio: 'inherit', shell: platform() === 'win32' })
  if (r.status !== 0) throw new Error('pty.node 编译失败')
}

/** 依赖树里只装一份 node-pty 源码用来编 pty.node;它随 npm install 一起来 */
function npmInstallDsh(into) {
  mkdirSync(into, { recursive: true })
  writeFileSync(join(into, 'package.json'), JSON.stringify({ name: 'dsh-android-bundle', private: true }, null, 2))
  log(`npm install @deepseek-ai/dsh@${pin.dsh}(os=android cpu=arm64)`)
  const r = spawnSync(platform() === 'win32' ? 'npm.cmd' : 'npm', ['install', `@deepseek-ai/dsh@${pin.dsh}`,
    '--os=android', '--cpu=arm64', '--ignore-scripts', '--no-audit', '--no-fund', '--no-package-lock', '--loglevel=error'],
    { cwd: into, stdio: 'inherit', shell: platform() === 'win32' })
  if (r.status !== 0) throw new Error('npm install 失败')
}

/** 去掉不会在 android-arm64 上用到的东西:别的平台的预编译、源码映射、类型声明 */
function prune(nodeModules) {
  let freed = 0
  const rmAll = (p) => { if (existsSync(p)) { freed += dirSize(p); rmSync(p, { recursive: true, force: true }) } }
  for (const d of readdirSync(join(nodeModules, 'node-pty', 'prebuilds'))) {
    if (d !== 'android-arm64') rmAll(join(nodeModules, 'node-pty', 'prebuilds', d))
  }
  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name)
      if (e.isDirectory()) walk(p)
      else if (/\.(map|d\.ts|d\.mts|d\.cts)$/.test(e.name)) { freed += statSync(p).size; rmSync(p) }
    }
  }
  walk(nodeModules)
  log(`裁剪 ${(freed / 1048576).toFixed(1)} MB`)
}

function dirSize(p) {
  const st = statSync(p)
  if (!st.isDirectory()) return st.size
  return readdirSync(p).reduce((n, e) => n + dirSize(join(p, e)), 0)
}

// DSH_HOME 骨架:dsh 首启只需要 profile 的这几个文件,其余自己补,不联网。
// 本插件也装进去(sidecar: false):手机上的 dsh 同样需要窄屏适配与目录选择器
// 替换;文件直接从仓库拷,与 App 同一版本,不经 npm。
function writeHomeSkeleton(home) {
  const web = join(home, 'profiles', 'web')
  const plugin = join(web, 'node_modules', pkg.name)
  mkdirSync(plugin, { recursive: true })
  for (const f of ['index.js', 'cordis.patch.yml', 'package.json']) copyFileSync(join(root, f), join(plugin, f))
  writeFileSync(join(web, 'package.json'), JSON.stringify({
    name: 'dsh-profile-web', private: true, dependencies: { [pkg.name]: pkg.version },
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', pkg.name], patchReload: 'live' } },
  }, null, 2) + '\n')
  // 与 dsh plugin --profile web 初始化出的文件一致:patch 必须是 YAML 数组,
  // 空文件会被判为非法;workspace 的写法也照抄,免得 dsh 首启自己动它。
  // patch 里按 id 给本插件配置 sidecar: false。
  writeFileSync(join(web, 'cordis.patch.yml'), [
    '# 本机 profile 的用户 patch 层。本插件以无 sidecar 模式运行:dsh 就在手机上,',
    '# 只要界面适配,不要配对与远端。',
    '- id: dsh-tether',
    '  config:',
    '    sidecar: false',
    '',
  ].join('\n'))
  writeFileSync(join(web, 'pnpm-workspace.yaml'), ['packages:', '  - .', '', 'nodeLinker: hoisted', 'autoInstallPeers: false', ''].join('\n'))
}

async function mirror() {
  const work = join(CACHE, 'termux')
  mkdirSync(work, { recursive: true })
  const rootfs = join(work, 'rootfs')
  rmSync(rootfs, { recursive: true, force: true })
  mkdirSync(rootfs)
  for (const [name, rel] of Object.entries(TERMUX_DEBS)) {
    const deb = await download(`${TERMUX_BASE}/${rel}`, join(work, basename(rel).replace(/:/g, '_')))
    log('解包', name)
    extractDeb(deb, rootfs)
  }
  const usr = join(rootfs, TERMUX_PREFIX)
  const stage = join(work, `node-android-arm64-${pin.node}`)
  rmSync(stage, { recursive: true, force: true })
  mkdirSync(join(stage, 'lib'), { recursive: true })
  copyFileSync(join(usr, 'bin', 'node'), join(stage, 'node'))
  for (const so of NODE_LIBS) copyFileSync(join(usr, 'lib', so), join(stage, 'lib', so))
  cpSync(join(usr, 'include', 'node'), join(stage, 'include', 'node'), { recursive: true })
  // Termux 的 OpenSSL 会去读它前缀下的 openssl.cnf,读不到就退出;给一份最小配置
  writeFileSync(join(stage, 'openssl.cnf'), '# 供打包进 App 的 node 使用\nopenssl_conf = default_conf\n[default_conf]\n')
  // pty.node 要 node-pty 源码,装一份依赖树取之(与默认模式同一份缓存)
  const bundle = join(CACHE, `dsh-${pin.dsh}`)
  if (!existsSync(join(bundle, 'node_modules', 'node-pty', 'src', 'unix', 'pty.cc'))) npmInstallDsh(bundle)
  buildPtyNode(join(stage, 'include', 'node'), join(bundle, 'node_modules', 'node-pty'), join(stage, 'pty.node'))
  const out = join(OUT, MIRROR_NAME)
  execFileSync(tar, ['-czf', out, '-C', work, basename(stage)], { stdio: 'inherit' })
  log('镜像包已生成:', out)
  log(`上传:gh release create ${MIRROR_TAG} "${out}" --title "${MIRROR_TAG}" --notes "Node ${pin.node} for android-arm64(Termux nodejs-lts + 依赖库 + node-pty prebuild)"`)
}

async function assemble() {
  mkdirSync(CACHE, { recursive: true })
  const tgz = await download(MIRROR_URL, join(CACHE, MIRROR_NAME))
  const rt = join(CACHE, `node-android-arm64-${pin.node}`)
  if (!existsSync(join(rt, 'node'))) execFileSync(tar, ['-xzf', tgz, '-C', CACHE], { stdio: 'inherit' })
  const bundle = join(CACHE, `dsh-${pin.dsh}`)
  if (!existsSync(join(bundle, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'))) npmInstallDsh(bundle)

  const stage = join(OUT, 'stage')
  rmSync(stage, { recursive: true, force: true })
  mkdirSync(join(stage, 'lib'), { recursive: true })
  for (const so of NODE_LIBS) copyFileSync(join(rt, 'lib', so), join(stage, 'lib', so))
  copyFileSync(join(rt, 'openssl.cnf'), join(stage, 'openssl.cnf'))
  cpSync(join(bundle, 'node_modules'), join(stage, 'app', 'node_modules'), { recursive: true })
  copyFileSync(join(bundle, 'package.json'), join(stage, 'app', 'package.json'))
  const prebuild = join(stage, 'app', 'node_modules', 'node-pty', 'prebuilds', 'android-arm64')
  mkdirSync(prebuild, { recursive: true })
  copyFileSync(join(rt, 'pty.node'), join(prebuild, 'pty.node'))
  prune(join(stage, 'app', 'node_modules'))
  writeHomeSkeleton(join(stage, 'home'))
  writeFileSync(join(stage, 'manifest.json'), JSON.stringify({ node: pin.node, dsh: pin.dsh, app: pkg.version }, null, 2) + '\n')

  const jni = join(OUT, 'jniLibs', 'arm64-v8a')
  mkdirSync(jni, { recursive: true })
  copyFileSync(join(rt, 'node'), join(jni, 'libnode.so'))
  const assets = join(OUT, 'assets')
  mkdirSync(assets, { recursive: true })
  const tarPath = join(assets, 'dsh-runtime.tar')
  rmSync(tarPath, { force: true })
  execFileSync(tar, ['-cf', tarPath, '-C', stage, '.'], { stdio: 'inherit' })
  rmSync(stage, { recursive: true, force: true })
  log(`libnode.so ${(statSync(join(jni, 'libnode.so')).size / 1048576).toFixed(1)} MB,dsh-runtime.tar ${(statSync(tarPath).size / 1048576).toFixed(1)} MB`)
}

if (process.argv[2] === 'mirror') await mirror()
else await assemble()
