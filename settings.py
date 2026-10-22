import ctypes
from ctypes import wintypes
import json
import ipaddress
import socket
from pathlib import Path
import tempfile
import urllib.request
import urllib.error
import urllib.parse

ROOT = Path(__file__).resolve().parent
DATA = ROOT/'data'
DATA.mkdir(exist_ok=True)
CONFIG = DATA/'config.json'
KEYFILE = DATA/'api-key.dpapi'


class Blob(ctypes.Structure):
    _fields_ = [('cbData',wintypes.DWORD),('pbData',ctypes.POINTER(ctypes.c_ubyte))]


def protect(data, decrypt=False):
    buf = ctypes.create_string_buffer(data)
    src = Blob(len(data),ctypes.cast(buf,ctypes.POINTER(ctypes.c_ubyte)))
    dst = Blob()
    crypt = ctypes.windll.crypt32
    if decrypt:
        ok = crypt.CryptUnprotectData(ctypes.byref(src),None,None,None,None,1,ctypes.byref(dst))
    else:
        ok = crypt.CryptProtectData(ctypes.byref(src),'WeChat companion API key',None,None,None,1,ctypes.byref(dst))
    if not ok:
        raise OSError('Windows DPAPI operation failed')
    try:
        return ctypes.string_at(dst.pbData,dst.cbData)
    finally:
        ctypes.windll.kernel32.LocalFree(dst.pbData)


def load_key():
    return protect(KEYFILE.read_bytes(),True).decode('utf-8') if KEYFILE.exists() else ''


def load_config():
    base = {'contact':'','model':'','poll_seconds':2.5,'enabled':False}
    if CONFIG.exists():
        base.update(json.loads(CONFIG.read_text(encoding='utf-8')))
    return base


def save_config(config):
    atomic_write(CONFIG, json.dumps(config,ensure_ascii=False,indent=2).encode('utf-8'))


def atomic_write(target, data):
    target = Path(target)
    target.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(dir=target.parent, prefix=target.name+'.', suffix='.tmp', delete=False) as stream:
        temp = Path(stream.name)
        try:
            stream.write(data)
            stream.flush()
        except BaseException:
            stream.close()
            temp.unlink(missing_ok=True)
            raise
    try:
        temp.replace(target)
    finally:
        temp.unlink(missing_ok=True)


def validate_base_url(value):
    message = 'API 地址必须为 HTTPS 基址，或本机 HTTP 地址；不能包含凭据、查询参数或 chat/completions 路径'
    if not isinstance(value, str) or not value.strip() or any(c.isspace() or ord(c) < 32 for c in value) or '\\' in value:
        raise ValueError(message)
    value = value.strip().rstrip('/')
    try:
        parsed = urllib.parse.urlsplit(value)
        host = parsed.hostname
        port = parsed.port
        if not host or parsed.username is not None or parsed.password is not None or parsed.query or parsed.fragment or '?' in value or '#' in value:
            raise ValueError(message)
        if port is not None and not 1 <= port <= 65535:
            raise ValueError(message)
        loopback = host.lower() == 'localhost'
        if not loopback:
            try:
                loopback = ipaddress.ip_address(host).is_loopback
            except ValueError:
                pass
        if parsed.scheme != 'https' and not (parsed.scheme == 'http' and loopback):
            raise ValueError(message)
        if parsed.path.rstrip('/').lower().endswith('/chat/completions'):
            raise ValueError(message)
    except ValueError:
        raise ValueError(message) from None
    return value


class APIRequestError(RuntimeError):
    def __init__(self, message, status=502):
        super().__init__(message)
        self.status = status


class NoAuthRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def request_api(endpoint, key, payload=None, timeout=35, base_url=None):
    base = validate_base_url(base_url if base_url is not None else load_config().get('api_base_url', 'https://api.deepseek.com'))
    req = urllib.request.Request(base+'/'+endpoint.lstrip('/'),
        data=json.dumps(payload,ensure_ascii=False).encode('utf-8') if payload is not None else None,
        headers={'Authorization':'Bearer '+key,'Content-Type':'application/json'})
    try:
        with urllib.request.build_opener(NoAuthRedirect()).open(req,timeout=timeout) as res:
            raw = res.read(1024*1024+1)
        if len(raw) > 1024*1024:
            raise APIRequestError('API 响应过大')
        try:
            return json.loads(raw)
        except (ValueError, UnicodeError):
            raise APIRequestError('API 返回了无效 JSON') from None
    except urllib.error.HTTPError as e:
        # Do not include a response body: an upstream might echo submitted private data.
        e.close()
        raise APIRequestError('API HTTP '+str(e.code)) from None
    except (TimeoutError, socket.timeout):
        raise APIRequestError('API 请求超时', 504) from None
    except urllib.error.URLError as e:
        if isinstance(e.reason, (TimeoutError, socket.timeout)):
            raise APIRequestError('API 请求超时', 504) from None
        raise APIRequestError('API 网络连接失败') from None
    except (OSError, ValueError):
        raise APIRequestError('API 请求失败') from None


def setup_window():
    import launcher
    launcher.open_console(launcher.main(False) + '/#api')


if __name__=='__main__':
    setup_window()
