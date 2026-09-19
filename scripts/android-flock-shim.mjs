// dsh 0.1.5 起会话锁走原生插件 @deepseek-ai/node-addon-system 的 flock,而它的加载器只认
// linux / darwin,android 直接抛 ERR_FLOCK_UNSUPPORTED_PLATFORM。表现是会话**打得开但恢复不了**:
// 界面报 `resume failed for session "…": flock is not supported on android-arm64`,发不出消息。
//
// bionic 自带 flock(2),缺的只是这个平台的原生构建。dsh 依赖树里本来就有 android-arm64 的
// koffi(dsh 自己用它调系统库),所以在 android 上改为经 koffi 调 libc 的 flock,语义与原生插件
// 一致:LOCK_EX|LOCK_NB,拿到返回 0,被别人占着返回 -EAGAIN(调用方按 errno 判定争用)。
// 不改成「空实现直接成功」:那会让两个写者同时改一份会话日志时都以为自己拿到了锁。手机上确实
// 只有一个 dsh 进程,但空实现一旦哪天不成立,坏的是用户的会话日志,而 koffi 这条路没有这个代价。
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const FILE = '@deepseek-ai/node-addon-system/lib/flock.js'
const FIND = "    if (platform !== 'linux' && platform !== 'darwin') {"
const INTO = `    if (platform === 'android') return __tetherAndroidFlock();
${FIND}`

// 放在文件开头;用的是该模块自己 import 的 createRequire(函数体在模块初始化后才跑,拿得到)
const PRELUDE = `let __tetherFlockBinding;
/** dsh-tether: Android 没有 flock 原生构建,经 koffi 调 libc;见 scripts/android-flock-shim.mjs */
function __tetherAndroidFlock() {
    if (__tetherFlockBinding)
        return __tetherFlockBinding;
    const koffi = createRequire(import.meta.url)('koffi');
    const flock = koffi.load('libc.so').func('int flock(int fd, int operation)');
    __tetherFlockBinding = {
        tryLock(fd, callback) {
            // LOCK_EX | LOCK_NB。回调约定是 0 成功、正 errno 失败:调用方拿到后自己取负
            // 交给 getSystemErrorName,这里再取一次负会得到正数,那个函数会直接抛 ERR_OUT_OF_RANGE
            const rc = flock(fd, 2 | 4);
            callback(rc === 0 ? 0 : koffi.errno());
        },
    };
    return __tetherFlockBinding;
}
`

/** 给 flock 加载器加 android 分支 */
export function patchFlock(nodeModules) {
  const path = join(nodeModules, FILE)
  const src = readFileSync(path, 'utf8')
  const hits = src.split(FIND).length - 1
  if (hits !== 1) throw new Error(`${FILE}: 期望恰好一处平台闸,实际 ${hits} 处(dsh 版本变了?)`)
  if (src.includes('__tetherAndroidFlock')) throw new Error(`${FILE}: 已经打过补丁`)
  writeFileSync(path, PRELUDE + src.replace(FIND, INTO))
}
