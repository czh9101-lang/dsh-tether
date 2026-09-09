// 真机操作辅助(adb):node scripts/android-device.mjs <shot [out.png]|tap x y|text ...|launch|stop|ps|avc|logcat [n]|clear|size>
// 环境变量 PKG 指定包名,默认 cc.zexa.dshtether.dev(debug 包)
import { execFileSync, spawnSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
const ADB = process.env.ANDROID_HOME.replace(/\\/g, '/') + '/platform-tools/adb.exe'
const PKG = process.env.PKG || 'cc.zexa.dshtether.dev'
const sh = (cmd) => spawnSync(ADB, ['shell', cmd], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
const [cmd, ...args] = process.argv.slice(2)
switch (cmd) {
  case 'shot': {
    const out = args[0] || 'tmp_device.png'
    const png = spawnSync(ADB, ['exec-out', 'screencap', '-p'], { maxBuffer: 64 * 1024 * 1024 }).stdout
    writeFileSync(out, png)
    console.log('saved', out, png.length, 'bytes')
    break
  }
  case 'tap': console.log(sh(`input tap ${args[0]} ${args[1]}`).stdout); break
  case 'text': console.log(sh(`input text '${args.join(' ')}'`).stdout); break
  case 'launch': console.log(sh(`am start -n ${PKG}/cc.zexa.dshtether.MainActivity`).stdout); break
  case 'stop': console.log(sh(`am force-stop ${PKG}`).stdout); break
  case 'ps': console.log(sh(`ps -A -o PID,PPID,RSS,NAME,ARGS | grep -E 'dshtether|libnode' | grep -v grep`).stdout); break
  case 'avc': console.log(sh(`logcat -d -b all | grep -E 'avc: *denied' | grep -E 'dshtether|libnode|node' | tail -20`).stdout); break
  case 'logcat': console.log(sh(`logcat -d -v time | grep -E 'dshtether|Tauri|RustStdout|RustStderr|tether' | tail -${args[0] || 60}`).stdout); break
  case 'clear': console.log(sh('logcat -c').stdout, 'cleared'); break
  case 'size': console.log(sh(`du -sh /data/data/${PKG}/ 2>/dev/null; ls /data/data/${PKG}/files 2>/dev/null`).stdout); break
  default: console.log('usage: shot|tap x y|text|launch|stop|ps|avc|logcat [n]|clear|size')
}
