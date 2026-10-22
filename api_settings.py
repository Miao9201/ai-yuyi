"""Local console API settings bridge. JSON stdin/stdout; never return API keys."""
import json
import math
import sys
import time
from urllib.parse import urlsplit

import settings

UPSTREAM_CONFIG = settings.ROOT / 'upstream-v1.2.0/data/config.json'
DEFAULT_MODEL = 'deepseek-flash'


class APISettingsError(ValueError):
    def __init__(self, message, status=400):
        super().__init__(message)
        self.status = status


def _read(path):
    if not path.exists():
        return {}
    try:
        value = json.loads(path.read_text(encoding='utf-8'))
        if not isinstance(value, dict):
            raise ValueError()
        return value
    except (ValueError, OSError, UnicodeError):
        raise APISettingsError('本地配置无法读取，请保留原文件后修复', 409) from None


def get_config():
    local = _read(settings.CONFIG)
    upstream = _read(UPSTREAM_CONFIG)
    model = local.get('model') or upstream.get('chatModel') or DEFAULT_MODEL
    transport = local.get('transport') or 'desktop'
    cfg = {
        'base_url': local.get('api_base_url') or upstream.get('chatBaseUrl') or 'https://api.deepseek.com',
        'chat_model': model,
        'vision_model': upstream.get('visionModelDeepseek') or model,
        'temperature': upstream.get('chatTemperature', 0.75),
        'timeout_ms': upstream.get('taskTimeoutMs', 45000),
        'has_key': settings.KEYFILE.is_file(),
        'transport': transport,
    }
    if transport == 'desktop':
        cfg['contact'] = str(local.get('contact') or '')
    return cfg


def _validated(payload):
    if not isinstance(payload, dict):
        raise APISettingsError('请求必须是 JSON 对象')
    current = get_config()
    cfg = {**current, **{k: payload[k] for k in ('base_url', 'chat_model', 'vision_model', 'temperature', 'timeout_ms') if k in payload}}
    try:
        cfg['base_url'] = settings.validate_base_url(cfg['base_url'])
    except ValueError as exc:
        raise APISettingsError(str(exc)) from None
    for field in ('chat_model', 'vision_model'):
        value = cfg[field]
        if not isinstance(value, str) or not value.strip() or len(value) > 200 or any(c.isspace() or ord(c) < 32 for c in value):
            raise APISettingsError('聊天和视觉模型名称不能为空，且不能含空白或控制字符')
        cfg[field] = value.strip()
    value = cfg['temperature']
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or not 0 <= value <= 2:
        raise APISettingsError('温度必须在 0 到 2 之间')
    value = cfg['timeout_ms']
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or not 5000 <= value <= 300000 or int(value) != value:
        raise APISettingsError('超时必须是 5000 到 300000 之间的整数毫秒')
    cfg['timeout_ms'] = int(value)
    key = payload.get('key', '')
    if not isinstance(key, str) or len(key) > 8192 or any(ord(c) < 32 for c in key):
        raise APISettingsError('API Key 格式无效')
    return cfg, key.strip()


def save_api_config(payload):
    cfg, key = _validated(payload)
    # Validate and encrypt before changing either configuration file.
    encrypted = settings.protect(key.encode('utf-8')) if key else None
    local = _read(settings.CONFIG)
    upstream = _read(UPSTREAM_CONFIG)
    local.update(model=cfg['chat_model'], api_base_url=cfg['base_url'])
    upstream.update(chatBaseUrl=cfg['base_url'], chatModel=cfg['chat_model'],
                    visionModelDeepseek=cfg['vision_model'], chatTemperature=cfg['temperature'],
                    taskTimeoutMs=cfg['timeout_ms'])
    if encrypted is not None:
        settings.atomic_write(settings.KEYFILE, encrypted)
    settings.atomic_write(UPSTREAM_CONFIG, json.dumps(upstream, ensure_ascii=False, indent=2).encode('utf-8'))
    settings.save_config(local)
    return get_config()


def _request(endpoint, payload, body=None):
    cfg, key = _validated(payload)
    if not key:
        try:
            key = settings.load_key()
        except (OSError, ValueError, UnicodeError):
            raise APISettingsError('无法解密本机 API Key，请重新填写', 409) from None
    if not key:
        raise APISettingsError('请填写 API Key')
    try:
        response = settings.request_api(endpoint, key, body(cfg) if body else None,
                                        timeout=cfg['timeout_ms']/1000, base_url=cfg['base_url'])
    except settings.APIRequestError as exc:
        raise APISettingsError(str(exc), exc.status) from None
    return cfg, response


def test_connection(payload):
    started = time.monotonic()
    cfg, response = _request('chat/completions', payload, lambda cfg: {
        'model': cfg['chat_model'], 'messages': [{'role': 'user', 'content': 'reply OK'}],
        'temperature': cfg['temperature'], 'max_tokens': 8, 'stream': False,
        **({'thinking': {'type': 'disabled'}} if urlsplit(cfg['base_url']).hostname.lower() == 'api.deepseek.com' else {}),
    })
    try:
        content = response['choices'][0]['message']['content']
        if not isinstance(content, str) or not content.strip():
            raise ValueError()
    except (TypeError, KeyError, IndexError, ValueError):
        raise APISettingsError('API 未返回有效聊天内容', 502) from None
    # A custom server may reflect the supplied key: never return its text.
    return {'ok': True, 'model': cfg['chat_model'], 'ms': round((time.monotonic()-started)*1000)}


def list_models(payload):
    _, response = _request('models', payload)
    if not isinstance(response, dict) or not isinstance(response.get('data'), list):
        raise APISettingsError('API 未返回有效模型列表', 502)
    models = []
    for row in response['data']:
        ident = row.get('id') if isinstance(row, dict) else None
        if isinstance(ident, str) and ident.strip() and ident not in models:
            models.append(ident)
    return {'models': models}


def main():
    try:
        operation = sys.argv[1] if len(sys.argv) == 2 else ''
        if operation not in ('get', 'save', 'test', 'models'):
            raise APISettingsError('命令必须是 get、save、test 或 models')
        raw = sys.stdin.read(65537) if operation != 'get' else ''
        if len(raw) > 65536:
            raise APISettingsError('请求内容过大')
        try:
            payload = json.loads(raw) if raw.strip() else {}
        except (ValueError, UnicodeError):
            raise APISettingsError('请求必须是有效 JSON') from None
        if not isinstance(payload, dict):
            raise APISettingsError('请求必须是 JSON 对象')
        result = get_config() if operation == 'get' else {
            'save': save_api_config, 'test': test_connection, 'models': list_models,
        }[operation](payload)
        status = 0
    except APISettingsError as exc:
        result, status = {'error': str(exc), 'status': exc.status}, 1
    except Exception:
        result, status = {'error': '本机 API 配置操作失败，请检查文件权限和密钥状态', 'status': 500}, 1
    print(json.dumps(result, ensure_ascii=True))
    return status


if __name__ == '__main__':
    raise SystemExit(main())
