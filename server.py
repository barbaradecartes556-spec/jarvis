#!/usr/bin/env python3
"""J.A.R.V.I.S. 本地服务：提供网页，并把聊天请求转发给 DeepSeek / 豆包。
用法：先在 config.json 里填好 Key，然后运行  python3 server.py ，再用 Chrome 打开 http://localhost:8765
只用到 Python 自带的库，不需要安装任何东西。
"""
import json, os, sys, urllib.request, urllib.error
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler

HERE = os.path.dirname(os.path.abspath(__file__))
# Key 放在程序文件夹外面的 ~/Jarvis/config.json，更新解压出新文件夹也不会丢；没有的话再读程序文件夹里的
USER_CONFIG = os.path.join(os.path.expanduser("~"), "Jarvis", "config.json")
CONFIG_PATH = os.environ.get("JARVIS_CONFIG") or (USER_CONFIG if os.path.exists(USER_CONFIG) else os.path.join(HERE, "config.json"))
PORT = int(os.environ.get("JARVIS_PORT", "8765"))
VERSION = "1.7.6"

PROVIDERS = {
    "deepseek": {
        "url": os.environ.get("JARVIS_DEEPSEEK_URL", "https://api.deepseek.com/chat/completions"),
        "key_field": "deepseek_api_key",
        "model_field": "deepseek_model",
        "default_model": "deepseek-chat",
    },
    "doubao": {
        "url": "https://ark.cn-beijing.volces.com/api/v3/chat/completions",
        "key_field": "doubao_api_key",
        "model_field": "doubao_model",
        "default_model": "",
    },
}


def clean_key(raw):
    """去掉首尾空白和误粘的引号；含中文或全角字符时返回 None，表示 Key 没填对。"""
    k = (raw or "").strip().strip('"\'“”‘’').strip().replace("\u3000", "")
    if not k:
        return ""
    if not k.isascii() or " " in k:
        return None
    return k


def load_config():
    try:
        with open(CONFIG_PATH, "r", encoding="utf-8") as f:
            return json.load(f)
    except FileNotFoundError:
        return {}


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=HERE, **kw)

    def log_message(self, fmt, *args):
        sys.stderr.write("[jarvis] " + (fmt % args) + "\n")

    def do_GET(self):
        if not self._host_ok():
            self.send_error(403)
            return
        path = self.path.split("?")[0]
        if path.startswith("/api/status"):
            cfg = load_config()
            status = {}
            for name, p in PROVIDERS.items():
                status[name] = {
                    "has_key": bool(clean_key(cfg.get(p["key_field"], ""))),
                    "model": cfg.get(p["model_field"], "") or p["default_model"],
                }
            self._json(200, {"providers": status, "default_provider": cfg.get("provider", "deepseek"), "version": VERSION, "dir": HERE, "config": CONFIG_PATH})
            return
        # 只允许访问这几个静态文件，其他路径（包括 config.json 的各种变体写法）一律 404
        if path in ("/", "/index.html"):
            self.path = "/index.html"
        elif path in ("/preview.png", "/holo3d.js", "/bg3d.js") or self._safe_static(path):
            self.path = path
        else:
            self.send_error(404)
            return
        self._no_cache = True   # 页面文件一律不让浏览器缓存，更新后刷新就是新版
        return super().do_GET()

    def end_headers(self):
        if getattr(self, "_no_cache", False):
            self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def do_POST(self):
        if self.path != "/api/chat":
            self.send_error(404)
            return
        # 只接受本页面发来的请求，防止别的网站偷偷用你的 Key
        origin = self.headers.get("Origin")
        if not self._host_ok() or (origin is not None and origin not in self._allowed()):
            self._json(403, {"error": "拒绝了来自其他网页的请求"})
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
            body = json.loads(self.rfile.read(length) or b"{}")
        except Exception:
            self._json(400, {"error": "请求格式不对"})
            return

        cfg = load_config()
        provider = body.get("provider") or cfg.get("provider", "deepseek")
        p = PROVIDERS.get(provider)
        if not p:
            self._json(400, {"error": f"不认识的模型服务：{provider}"})
            return
        key = clean_key(cfg.get(p["key_field"], ""))
        if key is None:
            self._json(400, {"error": f"Key 没填对：config.json 里的 {p['key_field']} 含有中文、全角字符或空格。请把占位文字整个删掉，只粘贴 Key 本身。"})
            return
        if not key:
            self._json(400, {"error": f"config.json 里还没填 {p['key_field']}"})
            return
        model = cfg.get(p["model_field"], "").strip() or p["default_model"]
        if not model:
            self._json(400, {"error": f"config.json 里还没填 {p['model_field']}（豆包需要填你在火山方舟开通的模型名或接入点 ID）"})
            return

        payload = {
            "model": model,
            "messages": body.get("messages", []),
            "stream": True,
            "temperature": body.get("temperature", 0.7),
        }
        req = urllib.request.Request(
            p["url"],
            data=json.dumps(payload).encode("utf-8"),
            headers={"Content-Type": "application/json", "Authorization": "Bearer " + key},
            method="POST",
        )
        try:
            upstream = urllib.request.urlopen(req, timeout=60)
        except urllib.error.HTTPError as e:
            detail = e.read().decode("utf-8", "replace")[:500]
            self._json(502, {"error": f"{provider} 返回错误 {e.code}：{detail}"})
            return
        except Exception as e:
            msg = f"连不上 {provider}：{e}"
            if "CERTIFICATE_VERIFY_FAILED" in str(e):
                msg = ("连不上 " + provider + "：电脑上的 Python 缺少证书。Mac 上请打开“应用程序”里的 Python 文件夹，"
                       "双击 Install Certificates.command，跑完后重新运行 python3 server.py。")
            self._json(502, {"error": msg})
            return

        # 把上游的流式回复原样转发给网页
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream; charset=utf-8")
        self.send_header("Cache-Control", "no-cache")
        self.send_header("Connection", "close")
        self.end_headers()
        try:
            while True:
                line = upstream.readline()
                if not line:
                    break
                self.wfile.write(line)
                if line.strip() == b"":
                    self.wfile.flush()
            self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError):
            pass  # 用户点了中断，网页断开了连接
        finally:
            upstream.close()
        self.close_connection = True

    def _safe_static(self, path):
        """只放行 themes/ 和 vendor/ 目录里的图片、视频和脚本，且不能跳出这两个目录。"""
        if not (path.startswith("/themes/") or path.startswith("/vendor/")):
            return False
        if "%" in path or ".." in path or "\\" in path:
            return False
        if not path.lower().endswith((".js", ".jpg", ".png", ".mp4")):
            return False
        full = os.path.realpath(os.path.join(HERE, path.lstrip("/")))
        roots = [os.path.realpath(os.path.join(HERE, d)) for d in ("themes", "vendor")]
        return any(full.startswith(r + os.sep) for r in roots) and os.path.isfile(full)

    def _allowed(self):
        return {f"http://localhost:{PORT}", f"http://127.0.0.1:{PORT}"}

    def _host_ok(self):
        return self.headers.get("Host", "") in {f"localhost:{PORT}", f"127.0.0.1:{PORT}"}

    def _json(self, code, obj):
        data = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)


if __name__ == "__main__":
    if not os.path.exists(CONFIG_PATH):
        print(f"还没有 config.json。请把 config.example.json 复制到 {USER_CONFIG} 并填好 Key（双击“启动贾维斯.command”会自动帮你建好并打开）。")
    # 只监听本机，别人连不上
    server = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    print(f"Key 配置文件：{CONFIG_PATH}")
    print(f"J.A.R.V.I.S. v{VERSION}（{HERE}）已上线：用 Chrome 打开 http://localhost:{PORT}  （按 Ctrl+C 关闭）")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
