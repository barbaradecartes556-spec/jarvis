#!/usr/bin/env python3
"""J.A.R.V.I.S. 本地服务：提供网页，并把聊天请求转发给 DeepSeek / 豆包。
用法：先在 config.json 里填好 Key，然后运行  python3 server.py ，再用 Chrome 打开 http://localhost:8765
只用到 Python 自带的库，不需要安装任何东西。
"""
import base64, json, os, sys, uuid, urllib.request, urllib.error
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler

HERE = os.path.dirname(os.path.abspath(__file__))
# Key 放在程序文件夹外面的 ~/Jarvis/config.json，更新解压出新文件夹也不会丢；没有的话再读程序文件夹里的
USER_CONFIG = os.path.join(os.path.expanduser("~"), "Jarvis", "config.json")
CONFIG_PATH = os.environ.get("JARVIS_CONFIG") or (USER_CONFIG if os.path.exists(USER_CONFIG) else os.path.join(HERE, "config.json"))
PORT = int(os.environ.get("JARVIS_PORT", "8765"))
VERSION = "1.9.2"

PROVIDERS = {
    "deepseek": {
        "url": os.environ.get("JARVIS_DEEPSEEK_URL", "https://api.deepseek.com/chat/completions"),
        "key_field": "deepseek_api_key",
        "model_field": "deepseek_model",
        "default_model": "deepseek-chat",
    },
    "doubao": {
        "url": os.environ.get("JARVIS_DOUBAO_URL", "https://ark.cn-beijing.volces.com/api/v3/chat/completions"),
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


VOLC_TTS_URL = os.environ.get("JARVIS_VOLC_TTS_URL", "https://openspeech.bytedance.com/api/v3/tts/unidirectional")
VOLC_ASR_URL = os.environ.get("JARVIS_VOLC_ASR_URL", "https://openspeech.bytedance.com/api/v3/auc/bigmodel/recognize/flash")
DEFAULT_VOICE = "zh_male_M392_conversation_wvae_bigtts"


def volc_auth(cfg):
    """火山引擎语音的鉴权请求头：新版控制台用 API Key，旧版用 APPID + Access Token。都没填好返回 None。"""
    api_key = clean_key(cfg.get("volc_api_key", ""))
    if api_key:
        return {"X-Api-Key": api_key}
    app_id = clean_key(str(cfg.get("volc_app_id", "")))
    token = clean_key(cfg.get("volc_access_token", ""))
    if app_id and token:
        return {"X-Api-App-Id": app_id, "X-Api-App-Key": app_id, "X-Api-Access-Key": token}
    return None


def tts_resources(cfg, speaker):
    """按音色选模型版本：2.0 音色（带 uranus）用 seed-tts-2.0，复刻音色（S_ 开头）用 seed-icl，其余用 1.0。"""
    forced = (cfg.get("volc_resource_id") or "").strip()
    if forced:
        return [forced]
    if speaker.startswith("S_"):
        return ["seed-icl-2.0", "seed-icl-1.0"]
    if "uranus" in speaker or "saturn" in speaker:
        return ["seed-tts-2.0"]
    return ["seed-tts-1.0", "seed-tts-2.0"]


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
            self._json(200, {"providers": status, "default_provider": cfg.get("provider", "deepseek"), "version": VERSION, "dir": HERE, "config": CONFIG_PATH,
                                   "volc": {"ready": volc_auth(cfg) is not None, "voice": cfg.get("volc_voice_type", "") or DEFAULT_VOICE,
                                            "tts": cfg.get("volc_tts", True) is not False, "asr": cfg.get("volc_asr", True) is not False}})
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
        if self.path not in ("/api/chat", "/api/tts", "/api/asr"):
            self.send_error(404)
            return
        # 只接受本页面发来的请求，防止别的网站偷偷用你的 Key
        origin = self.headers.get("Origin")
        if not self._host_ok() or (origin is not None and origin not in self._allowed()):
            self._json(403, {"error": "拒绝了来自其他网页的请求"})
            return
        if self.path == "/api/tts":
            return self._tts()
        if self.path == "/api/asr":
            return self._asr()
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
        # 豆包 Seed 系列默认先“深度思考”再回答，语音对话会很慢，这里关掉；不支持这个参数的模型会自动去掉重试
        if provider == "doubao" and cfg.get("doubao_thinking", "disabled") != "enabled":
            payload["thinking"] = {"type": "disabled"}
        try:
            upstream = self._open_chat(p["url"], key, payload)
        except urllib.error.HTTPError as e:
            detail = e.read().decode("utf-8", "replace")[:500]
            if "thinking" in payload and e.code == 400 and "thinking" in detail.lower():
                payload.pop("thinking")
                try:
                    upstream = self._open_chat(p["url"], key, payload)
                except urllib.error.HTTPError as e2:
                    detail = e2.read().decode("utf-8", "replace")[:500]
                    self._json(502, {"error": f"{provider} 返回错误 {e2.code}：{detail}"})
                    return
                except Exception as e2:
                    self._json(502, {"error": f"连不上 {provider}：{e2}"})
                    return
            else:
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

    # ---------- 火山引擎：语音合成（贾维斯的声音） ----------
    def _tts(self):
        try:
            length = int(self.headers.get("Content-Length", "0"))
            body = json.loads(self.rfile.read(min(length, 100000)) or b"{}")
            text = str(body.get("text", "")).strip()[:600]
        except Exception:
            return self._json(400, {"error": "请求格式不对"})
        cfg = load_config()
        auth = volc_auth(cfg)
        if not auth:
            return self._json(400, {"error": "config.json 里还没填火山引擎的 volc_api_key，或 volc_app_id + volc_access_token"})
        if not text:
            return self._json(400, {"error": "没有要朗读的文字"})
        try:
            speed = float(cfg.get("volc_speed", 1.0) or 1.0)
        except (TypeError, ValueError):
            speed = 1.0
        speaker = (cfg.get("volc_voice_type", "") or DEFAULT_VOICE).strip()
        audio_params = {"format": "mp3", "sample_rate": 24000, "speech_rate": max(-50, min(100, round((speed - 1) * 100)))}
        payload = {"user": {"uid": "jarvis-boss"}, "req_params": {"text": text, "speaker": speaker, "audio_params": audio_params}}
        err = "没有返回音频"
        for resource in tts_resources(cfg, speaker):
            audio, err = self._tts_call(auth, resource, payload)
            if audio:
                break
        else:
            return self._json(502, {"error": f"火山引擎语音合成失败：{err}（音色 {speaker}，可能是这个音色在你的账号里还没开通）"})
        self.send_response(200)
        self.send_header("Content-Type", "audio/mpeg")
        self.send_header("Content-Length", str(len(audio)))
        self.end_headers()
        self.wfile.write(audio)

    @staticmethod
    def _open_chat(url, key, payload):
        req = urllib.request.Request(url, data=json.dumps(payload).encode("utf-8"), method="POST",
                                     headers={"Content-Type": "application/json", "Authorization": "Bearer " + key})
        return urllib.request.urlopen(req, timeout=60)

    @staticmethod
    def _tts_call(auth, resource, payload):
        """调用 V3 单向流式合成，把分块返回的音频拼成一个完整 mp3。返回 (音频, 错误信息)。"""
        headers = {"Content-Type": "application/json", "X-Api-Resource-Id": resource, "X-Api-Request-Id": str(uuid.uuid4()), **auth}
        req = urllib.request.Request(VOLC_TTS_URL, data=json.dumps(payload).encode("utf-8"), method="POST", headers=headers)
        audio = bytearray()
        try:
            with urllib.request.urlopen(req, timeout=40) as r:
                for line in r:
                    line = line.strip()
                    if line.startswith(b"data:"):
                        line = line[5:].strip()
                    if not line or not line.startswith(b"{"):
                        continue
                    msg = json.loads(line)
                    code = msg.get("code", 0)
                    if msg.get("data"):
                        audio += base64.b64decode(msg["data"])
                    if code not in (0, 20000000):
                        return None, f"{code} {msg.get('message', '')}"
        except urllib.error.HTTPError as e:
            body = e.read()[:300].decode("utf-8", "replace")
            return None, f"HTTP {e.code} {e.headers.get('X-Api-Message', '')} {body}".strip()
        except Exception as e:
            return None, f"连不上：{e}"
        return (bytes(audio), "") if audio else (None, "没有返回音频")

    # ---------- 火山引擎：语音识别（按住空格说的话） ----------
    def _asr(self):
        length = int(self.headers.get("Content-Length", "0"))
        if length <= 44 or length > 20 * 1024 * 1024:
            return self._json(400, {"error": "录音太短或太长"})
        audio = self.rfile.read(length)
        cfg = load_config()
        auth = volc_auth(cfg)
        if not auth:
            return self._json(400, {"error": "config.json 里还没填火山引擎的 volc_api_key，或 volc_app_id + volc_access_token"})
        payload = {"user": {"uid": "jarvis-boss"}, "audio": {"data": base64.b64encode(audio).decode(), "format": "wav"},
                   "request": {"model_name": "bigmodel", "enable_itn": True, "enable_punc": True}}
        req = urllib.request.Request(VOLC_ASR_URL, data=json.dumps(payload).encode("utf-8"), method="POST", headers={
            "Content-Type": "application/json", **auth,
            "X-Api-Resource-Id": "volc.bigasr.auc_turbo", "X-Api-Request-Id": str(uuid.uuid4()), "X-Api-Sequence": "-1"})
        try:
            with urllib.request.urlopen(req, timeout=30) as r:
                code = r.headers.get("X-Api-Status-Code", "")
                msg = r.headers.get("X-Api-Message", "")
                res = json.loads(r.read() or b"{}")
        except urllib.error.HTTPError as e:
            code, msg, res = e.headers.get("X-Api-Status-Code", str(e.code)), e.headers.get("X-Api-Message", ""), self._read_err(e)
        except Exception as e:
            return self._json(502, {"error": f"连不上火山引擎语音识别：{e}"})
        if code == "20000003":          # 没检测到说话
            return self._json(200, {"text": ""})
        if code and code != "20000000":
            return self._json(502, {"error": f"火山引擎语音识别失败（{code}）：{msg or res}"})
        self._json(200, {"text": ((res.get("result") or {}).get("text") or "").strip()})

    @staticmethod
    def _read_err(e):
        try:
            return json.loads(e.read() or b"{}")
        except Exception:
            return {"error": f"HTTP {e.code}"}

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
