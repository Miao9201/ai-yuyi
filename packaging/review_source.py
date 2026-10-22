"""Review tracked/public-manifest source files before updating the packaging manifest."""
import argparse
import hashlib
import json
from pathlib import Path,PurePosixPath
import re
import subprocess
from build_portable import source_files


def main():
    parser=argparse.ArgumentParser();parser.add_argument('--update-manifest',action='store_true');args=parser.parse_args()
    root=Path(__file__).resolve().parents[1]
    manifest=root/'PUBLIC-SOURCE-MANIFEST.json'
    previous=json.loads(manifest.read_text(encoding='utf-8'))
    try:
        names=subprocess.check_output(['git','ls-files','-z'],cwd=root,stderr=subprocess.DEVNULL).decode('utf-8').split('\0')
        names=[n for n in names if n and n!='PUBLIC-SOURCE-MANIFEST.json']
    except (OSError,subprocess.CalledProcessError):names=list(previous['files'])
    if not names:raise ValueError('没有待检查的公开源文件')
    secrets=re.compile(rb'\b(?:sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----')
    entries={}
    for name in names:
        relative=PurePosixPath(name)
        if relative.is_absolute() or '..' in relative.parts or ':' in name:raise ValueError('非法清单路径')
        file=root/name
        if not file.is_file() or file.is_symlink():raise ValueError('源文件缺失或为链接：'+name)
        raw=file.read_bytes()
        if secrets.search(raw):raise ValueError('发现疑似密钥：'+name)
        entries[name]=hashlib.sha256(raw).hexdigest()
    candidate={**previous,'files':entries}
    temporary=root/'PUBLIC-SOURCE-MANIFEST.review-backup'
    if temporary.exists():raise ValueError('已有审核备份，请先检查上一次结果')
    original=manifest.read_bytes();temporary.write_bytes(original)
    try:
        manifest.write_text(json.dumps(candidate,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
        source_files(root)
        if not args.update_manifest:manifest.write_bytes(original)
    except BaseException:
        manifest.write_bytes(original);raise
    finally:temporary.unlink(missing_ok=True)
    print('审核通过：'+str(len(entries))+'个文件'+('，已更新清单' if args.update_manifest else '，清单未改动'))


if __name__=='__main__':main()
