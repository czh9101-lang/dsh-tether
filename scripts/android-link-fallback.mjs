// Android 上普通 App 一律不能建硬链接:AOSP sepolicy 的 private/app_neverallows.te 写着
// `neverallow all_untrusted_apps file_type:file link;`,link(2) 恒 EACCES,与 ROM、系统版本无关。
// dsh 用 link(src, dst) 做「不覆盖地发布一个已 fsync 的文件」的地方有四处(0.1.5-rc.2):
//   session-persistence-jsonl  materializePosix        新会话首次落盘,失败即每一轮对话都失败
//   session-persistence-jsonl  publishCurrentExclusive 会话格式迁移;内置 dsh 升版本后,手机上
//                                                      已有的旧会话第一次被读到就走这条
//   attachment-local           publishStagedObject     附件入库
//   attachment-local           publishImmutableAlias   给已入库的对象再起一个名字
// 打运行时 tar 时把这四处调用换成 __tetherLink:先照常 link;只有 link 因文件系统/策略不许
// 硬链接而失败(EACCES / EPERM / ENOTSUP)时,改为「src 复制一份并 fsync → 目标已存在就照
// link 的样子抛 EEXIST → rename 到目标」。EXDEV 不在其列:跨文件系统 rename 同样失败。
//
// 与 link 相比保住的:目标内容原子出现(rename)、副本先 fsync(调用方随后照旧 fsync 目录)、
// 不覆盖已存在的目标(EEXIST 由调用方按各自的方式和解)、src 原样留着(调用方随后自己删 src,
// 有的用 rm 有的用 unlink,后者遇到 src 不在会报错,所以不能直接 rename src)。
// 丢掉的有两条:
//   一是存在检查与 rename 之间不原子,两个发布者同时发布同一路径时后者覆盖前者。四处调用方
//     都碰不到:会话 id 是随机 UUID 且上游 createCore 已挡掉同 id 重复创建;附件按内容 sha256
//     寻址,并发写的是相同字节;迁移发布同一代只有一个写者。
//   二是别名那处会多占一份字节(硬链接是同一份数据的第二个名字,复制不是)。只影响用户真发过
//     的附件。不用符号链接换掉这份开销:上游多处按 lstat 判定拒绝非普通文件,赌不起。
// 不用 open(dst, 'wx') 先占位再 rename:占位与 rename 之间进程被杀会留下空的目标文件,
// 会话日志与附件都会因此被判为损坏,而 Android 杀后台进程是常态。
import { readFileSync, readdirSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const HELPER = '__tetherLink'

// 调用点逐字匹配,每处必须恰好出现一次;换 dsh 版本后对不上就让构建失败,照新代码改这张表。
// internals.fs 那处是上游给测试留的注入口,把它原样传给 helper,先用它的 link 再回退。
export const SITES = [
  {
    file: '@deepseek-ai/dsh-session-persistence-jsonl/lib/index.js',
    find: 'await link(tmp, finalPath);',
    into: `await ${HELPER}(tmp, finalPath);`,
  },
  {
    file: '@deepseek-ai/dsh-session-persistence-jsonl/lib/index.js',
    find: 'await internals.fs.link(staged, currentPath);',
    into: `await ${HELPER}(staged, currentPath, internals.fs);`,
  },
  {
    file: '@deepseek-ai/dsh-attachment-local/lib/index.js',
    find: 'await link(source, target);',
    into: `await ${HELPER}(source, target);`,
  },
  {
    file: '@deepseek-ai/dsh-attachment-local/lib/index.js',
    find: 'await link(staged.path, target);',
    into: `await ${HELPER}(staged.path, target);`,
  },
  {
    // 迁移跑在 worker 线程里,同一份发布逻辑又被打进这个 CJS 包
    file: '@deepseek-ai/dsh-session-persistence-jsonl/lib/worker.cjs',
    find: 'await internals.fs.link(staged, currentPath);',
    into: `await ${HELPER}(staged, currentPath, internals.fs);`,
  },
]

// 注入到模块开头;命名空间导入免得与模块自己的绑定重名。写法照上游文件(tab、分号、双引号)
const HELPER_BODY = `/** dsh-tether: Android forbids hard links for apps; see scripts/android-link-fallback.mjs */
async function ${HELPER}(src, dst, fs) {
	try {
		return await (fs ?? __tetherFsp).link(src, dst);
	} catch (error) {
		if (!["EACCES", "EPERM", "ENOTSUP"].includes(error?.code)) throw error;
	}
	const copy = \`\${src}.\${__tetherRandomBytes(6).toString("hex")}.tmp\`;
	try {
		const { mode } = await __tetherFsp.stat(src);
		const handle = await __tetherFsp.open(copy, "wx", mode & 511);
		try {
			await handle.writeFile(await __tetherFsp.readFile(src));
			await handle.sync();
		} finally {
			await handle.close();
		}
		const exists = await __tetherFsp.lstat(dst).then(() => true, (error) => {
			if (error?.code === "ENOENT") return false;
			throw error;
		});
		if (exists) throw Object.assign(new Error(\`EEXIST: file already exists, link '\${src}' -> '\${dst}'\`), {
			errno: -17,
			code: "EEXIST",
			syscall: "link",
			path: src,
			dest: dst
		});
		await __tetherFsp.rename(copy, dst);
	} finally {
		await __tetherFsp.rm(copy, { force: true });
	}
}
`

const PRELUDES = {
  esm: `import * as __tetherFsp from "node:fs/promises";
import { randomBytes as __tetherRandomBytes } from "node:crypto";
${HELPER_BODY}`,
  cjs: `const __tetherFsp = require("node:fs/promises");
const { randomBytes: __tetherRandomBytes } = require("node:crypto");
${HELPER_BODY}`,
}

const preludeFor = (file) => PRELUDES[file.endsWith('.cjs') ? 'cjs' : 'esm']

// 带参数的 link( / linkSync( 调用;unlink( symlink( 前面是字母,\b 不成立;注释里的 link() 没参数
const LINK_CALL = /\b(?:link|linkSync)\(\s*[\w$]/

/** 打补丁并确认 @deepseek-ai 各包 lib 里不再有未经处理的硬链接调用 */
export function patchHardLinks(nodeModules) {
  const patched = new Set()
  for (const { file, find, into } of SITES) {
    const path = join(nodeModules, file)
    const src = readFileSync(path, 'utf8')
    const hits = src.split(find).length - 1
    if (hits !== 1) throw new Error(`${file}: 期望恰好一处 \`${find}\`,实际 ${hits} 处(dsh 版本变了?)`)
    const prelude = patched.has(path) ? '' : preludeFor(file)
    patched.add(path)
    writeFileSync(path, prelude + src.replace(find, into))
  }
  const left = []
  const scope = join(nodeModules, '@deepseek-ai')
  for (const pkgDir of readdirSync(scope)) {
    const lib = join(scope, pkgDir, 'lib')
    if (existsSync(lib)) walkJs(lib, (p) => {
      // 注入的 helper 里那一处 link 是本意,跳过前导段再扫
      const text = readFileSync(p, 'utf8')
      const own = Object.values(PRELUDES).find((v) => text.startsWith(v))
      const skip = own ? own.split('\n').length - 1 : 0
      text.split('\n').slice(skip).forEach((line, i) => {
        if (LINK_CALL.test(line)) left.push(`${p}:${skip + i + 1}: ${line.trim()}`)
      })
    })
  }
  if (left.length) throw new Error(`还有未处理的硬链接调用,Android 上会 EACCES:\n${left.join('\n')}`)
}

function walkJs(dir, fn) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (e.isDirectory()) walkJs(p, fn)
    else if (/\.(js|mjs|cjs)$/.test(e.name)) fn(p)
  }
}
