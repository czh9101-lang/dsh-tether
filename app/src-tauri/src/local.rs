//! Android 本地模式:在手机上起内置的 Node + dsh,经本地注入代理把 web UI 交给 WebView。
//!
//! 运行时分两处:Node 可执行文件以 `libnode.so` 打在 APK 原生库目录(Android 10+ 只允许
//! exec 那里的文件),其余(共享库、dsh 依赖树、DSH_HOME 骨架)在 assets 里的一个 tar,
//! 首启解压到应用数据目录。dsh 0.1.2 起 index/api 要求认证 cookie,而 WebView 里的
//! dsh 界面在 iframe 内(跨站,Strict cookie 不带),所以和远程模式一样在本地起一个
//! 逐请求注入 cookie 的代理,iframe 只看见代理端口。
use std::collections::VecDeque;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Arc;

use anyhow::{bail, Context as _, Result};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};
use tether_core::{read_request_head, rewrite_request_head, ProxyAuth};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::net::{TcpListener, TcpStream};
use tokio::process::{Child, Command};
use tokio::sync::Mutex;

/// 本地模式的代理端口。与远程主机按 EndpointId 派生的端口同在 20000–31999 段,
/// 「本机」这个源固定用段尾这一个,web UI 的 localStorage 与任何远程主机都不串。
const LOCAL_PROXY_PORT: u16 = 31999;
/// 本 crate 编出的动态库名,进程里一定已加载,用它在映射表里找原生库目录
const SELF_LIB: &str = "/libdsh_tether_app_lib.so";
/// 运行时 tar 在 APK 里的路径
const RUNTIME_ASSET: &str = "assets/dsh-runtime.tar";
/// 日志环形缓冲行数;够看清启动失败的原因
const LOG_LINES: usize = 200;

pub struct LocalHost {
    child: Child,
    proxy_port: u16,
    /// 代理的 accept 循环;stop 时必须中止,否则监听套接字一直占着固定端口,
    /// 下次启动只能退到随机端口,web UI 的 localStorage 就换了源
    proxy_task: tauri::async_runtime::JoinHandle<()>,
    log: Arc<Mutex<VecDeque<String>>>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct LocalStateEvent {
    status: &'static str,
    detail: String,
}

fn emit(app: &AppHandle, status: &'static str, detail: impl Into<String>) {
    let _ = app.emit("local:state", LocalStateEvent { status, detail: detail.into() });
}

/// APK 原生库目录与 APK 本体路径。进程已加载本 crate 的 .so,`/proc/self/maps`
/// 里就有它的绝对路径,同一目录就是原生库目录。APK 不从映射表里挑:进程里还
/// 映射着 WebView 等别的包的 base.apk,按顺序取会拿错;安装目录的布局是固定的
/// `<install dir>/lib/<abi>/` 与 `<install dir>/base.apk`,从库目录反推即可。
struct Layout {
    native_lib_dir: PathBuf,
    apk: PathBuf,
}

fn layout() -> Result<Layout> {
    let maps = std::fs::read_to_string("/proc/self/maps").context("读不到 /proc/self/maps")?;
    let native_lib_dir = maps
        .lines()
        .filter_map(|line| line.split_whitespace().nth(5))
        .find(|path| path.ends_with(SELF_LIB))
        .and_then(|path| Path::new(path).parent().map(Path::to_path_buf))
        .context("映射表里找不到本应用的原生库目录")?;
    let apk = native_lib_dir
        .parent()
        .and_then(Path::parent)
        .map(|install| install.join("base.apk"))
        .filter(|p| p.is_file())
        .context("原生库目录旁找不到 base.apk")?;
    Ok(Layout { native_lib_dir, apk })
}

fn node_binary(layout: &Layout) -> PathBuf {
    layout.native_lib_dir.join("libnode.so")
}

/// 只有带 libnode.so 的构建(arm64)才有本地模式;其余 ABI 与 iOS 没有这个入口
pub fn available() -> bool {
    layout().map(|l| node_binary(&l).is_file()).unwrap_or(false)
}

fn data_dir(app: &AppHandle) -> Result<PathBuf> {
    app.path().app_data_dir().context("取不到应用数据目录")
}

fn runtime_dir(app: &AppHandle) -> Result<PathBuf> {
    Ok(data_dir(app)?.join("dsh-runtime"))
}

/// 运行时随 App 版本一起变;版本不同就重新解压,不比对 tar 内容
fn runtime_ready(dir: &Path) -> bool {
    let Ok(text) = std::fs::read_to_string(dir.join("manifest.json")) else { return false };
    let Ok(value) = serde_json::from_str::<serde_json::Value>(&text) else { return false };
    value.get("app").and_then(|v| v.as_str()) == Some(env!("CARGO_PKG_VERSION"))
}

/// 从 APK 里把运行时 tar 解到数据目录。先解到临时目录再改名,半途被杀不会留下
/// 「看似就绪」的残缺目录。25k 个文件,进度按条目数报给前端。
fn extract_runtime(app: &AppHandle, apk: &Path, dir: &Path) -> Result<()> {
    let tmp = dir.with_extension("extracting");
    let _ = std::fs::remove_dir_all(&tmp);
    std::fs::create_dir_all(&tmp)?;
    let file = std::fs::File::open(apk).context("打不开 APK")?;
    let mut zip = zip::ZipArchive::new(file).context("APK 不是有效的 zip")?;
    let entry = zip.by_name(RUNTIME_ASSET).context("APK 里没有运行时,这个构建不含本地模式")?;
    let mut archive = tar::Archive::new(entry);
    let mut count = 0usize;
    for item in archive.entries().context("运行时 tar 损坏")? {
        let mut item = item?;
        item.unpack_in(&tmp)?;
        count += 1;
        if count % 1000 == 0 {
            emit(app, "extracting", format!("正在解压运行时… {count} 个文件"));
        }
    }
    let _ = std::fs::remove_dir_all(dir);
    std::fs::rename(&tmp, dir).context("运行时目录改名失败")?;
    Ok(())
}

/// DSH_HOME 只需要 profile 的三个骨架文件;已有就不动,里面是用户的会话与设置
fn ensure_dsh_home(runtime: &Path, home: &Path) -> Result<()> {
    if home.join("profiles").join("web").join("package.json").is_file() {
        return Ok(());
    }
    copy_dir(&runtime.join("home"), home)
}

fn copy_dir(from: &Path, to: &Path) -> Result<()> {
    std::fs::create_dir_all(to)?;
    for entry in std::fs::read_dir(from)? {
        let entry = entry?;
        let target = to.join(entry.file_name());
        if entry.file_type()?.is_dir() {
            copy_dir(&entry.path(), &target)?;
        } else {
            std::fs::copy(entry.path(), target)?;
        }
    }
    Ok(())
}

/// node 的 stdout 第一条有用的行:`dsh web: http://127.0.0.1:<port>/?token=<token>`
fn parse_ready_line(line: &str) -> Option<(u16, String)> {
    let rest = line.trim().strip_prefix("dsh web: http://127.0.0.1:")?;
    let (port, query) = rest.split_once("/?token=")?;
    Some((port.parse().ok()?, query.trim().to_string()))
}

/// 拿启动 token 换认证 cookie:GET /?token= 回 303 + set-cookie。只要 name=value。
async fn exchange_cookie(port: u16, token: &str) -> Result<String> {
    let mut tcp = TcpStream::connect(("127.0.0.1", port)).await.context("连不上本机 dsh")?;
    let req = format!("GET /?token={token} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nConnection: close\r\n\r\n");
    tcp.write_all(req.as_bytes()).await?;
    let mut buf = Vec::with_capacity(4096);
    let mut chunk = [0u8; 1024];
    while !buf.windows(4).any(|w| w == b"\r\n\r\n") && buf.len() < 64 * 1024 {
        let n = tcp.read(&mut chunk).await?;
        if n == 0 {
            break;
        }
        buf.extend_from_slice(&chunk[..n]);
    }
    let head = String::from_utf8_lossy(&buf);
    for line in head.lines() {
        if let Some((key, value)) = line.split_once(':') {
            if key.trim().eq_ignore_ascii_case("set-cookie") {
                let pair = value.trim().split(';').next().unwrap_or_default().trim();
                if !pair.is_empty() {
                    return Ok(pair.to_string());
                }
            }
        }
    }
    bail!("dsh 没有下发认证 cookie(应答首行:{})", head.lines().next().unwrap_or_default())
}

/// 本地注入代理:每条入站 TCP 读完请求头改写(Host、cookie、Connection: close),
/// 再原样双向转发到 dsh 端口。与 sidecar 上的代理流是同一套改写。
async fn start_proxy(dsh_port: u16, auth: Arc<ProxyAuth>) -> Result<(u16, tauri::async_runtime::JoinHandle<()>)> {
    let listener = match TcpListener::bind(("127.0.0.1", LOCAL_PROXY_PORT)).await {
        Ok(l) => l,
        Err(_) => TcpListener::bind(("127.0.0.1", 0)).await.context("本地代理监听失败")?,
    };
    let port = listener.local_addr()?.port();
    let task = tauri::async_runtime::spawn(async move {
        loop {
            let Ok((mut tcp, _)) = listener.accept().await else { break };
            let auth = auth.clone();
            tauri::async_runtime::spawn(async move {
                let Ok(head) = read_request_head(&mut tcp).await else { return };
                let head = rewrite_request_head(&head, &auth);
                let Ok(mut upstream) = TcpStream::connect(("127.0.0.1", dsh_port)).await else { return };
                if upstream.write_all(head.as_bytes()).await.is_err() {
                    return;
                }
                let _ = tokio::io::copy_bidirectional(&mut tcp, &mut upstream).await;
            });
        }
    });
    Ok((port, task))
}

fn push_log(log: &Arc<Mutex<VecDeque<String>>>, line: String) {
    let log = log.clone();
    tauri::async_runtime::spawn(async move {
        let mut guard = log.lock().await;
        if guard.len() >= LOG_LINES {
            guard.pop_front();
        }
        guard.push_back(line);
    });
}

/// 起本机 dsh:解压(如需)→ spawn node → 等就绪行 → 换 cookie → 起代理。
/// 返回代理 URL,WebView 加载它即可。
pub async fn start(app: &AppHandle) -> Result<(LocalHost, String)> {
    let layout = layout()?;
    let node = node_binary(&layout);
    if !node.is_file() {
        bail!("这个构建不含本地运行时");
    }
    let runtime = runtime_dir(app)?;
    if !runtime_ready(&runtime) {
        emit(app, "extracting", "首次使用,正在解压运行时…");
        let app2 = app.clone();
        let apk = layout.apk.clone();
        let dir = runtime.clone();
        tauri::async_runtime::spawn_blocking(move || extract_runtime(&app2, &apk, &dir))
            .await
            .context("解压任务中断")??;
    }
    let data = data_dir(app)?;
    let home = data.join("dsh-home");
    ensure_dsh_home(&runtime, &home)?;
    let tmp = data.join("tmp");
    std::fs::create_dir_all(&tmp)?;

    emit(app, "starting", "正在启动本机 DSH…");
    let bin_js = runtime.join("app").join("node_modules").join("@deepseek-ai").join("dsh").join("lib").join("bin.js");
    let mut child = Command::new(&node)
        // cordis 加载器先试 --expose-internals 取内部模块加载器,有了它就不需要
        // node-addon-require-builtin 的原生件(那个没有 android 构建)
        .arg("--expose-internals")
        .arg(&bin_js)
        .args(["web", "--no-open", "--port", "0"])
        .env("LD_LIBRARY_PATH", runtime.join("lib"))
        // Termux 构建的 OpenSSL 会去读它前缀下的配置文件,读不到就退出
        .env("OPENSSL_CONF", runtime.join("openssl.cnf"))
        .env("HOME", &data)
        .env("TMPDIR", &tmp)
        .env("DSH_HOME", &home)
        .env("PATH", "/system/bin:/system/xbin")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .context("起不了 node")?;
    let log = Arc::new(Mutex::new(VecDeque::new()));
    let stdout = child.stdout.take().context("拿不到 stdout")?;
    let stderr = child.stderr.take().context("拿不到 stderr")?;
    {
        let log = log.clone();
        tauri::async_runtime::spawn(async move {
            let mut lines = BufReader::new(stderr).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                push_log(&log, line);
            }
        });
    }
    let mut lines = BufReader::new(stdout).lines();
    let ready = tokio::time::timeout(std::time::Duration::from_secs(90), async {
        while let Some(line) = lines.next_line().await? {
            if let Some(found) = parse_ready_line(&line) {
                return Ok::<_, anyhow::Error>(Some(found));
            }
            push_log(&log, line);
        }
        Ok(None)
    })
    .await;
    let (dsh_port, token) = match ready {
        Ok(Ok(Some(found))) => found,
        Ok(Ok(None)) => {
            let tail = log.lock().await.iter().rev().take(8).cloned().collect::<Vec<_>>();
            bail!("本机 DSH 启动失败:{}", tail.into_iter().rev().collect::<Vec<_>>().join(" | "))
        }
        Ok(Err(e)) => bail!("读取 DSH 输出失败:{e:#}"),
        Err(_) => bail!("本机 DSH 90 秒内未就绪"),
    };
    {
        let log = log.clone();
        tauri::async_runtime::spawn(async move {
            while let Ok(Some(line)) = lines.next_line().await {
                push_log(&log, line);
            }
        });
    }
    let cookie = exchange_cookie(dsh_port, &token).await?;
    let auth = Arc::new(ProxyAuth { cookie, authority: format!("127.0.0.1:{dsh_port}") });
    let (proxy_port, proxy_task) = start_proxy(dsh_port, auth).await?;
    let url = format!("http://127.0.0.1:{proxy_port}/");
    Ok((LocalHost { child, proxy_port, proxy_task, log }, url))
}

impl LocalHost {
    pub fn url(&self) -> String {
        format!("http://127.0.0.1:{}/", self.proxy_port)
    }

    /// 进程是否还活着;死了就不该再把 URL 交给 WebView
    pub fn alive(&mut self) -> bool {
        matches!(self.child.try_wait(), Ok(None))
    }

    pub async fn stop(mut self) {
        self.proxy_task.abort();
        let _ = self.child.kill().await;
    }

    pub async fn log_tail(&self) -> Vec<String> {
        self.log.lock().await.iter().cloned().collect()
    }
}
