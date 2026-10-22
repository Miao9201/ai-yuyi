"""Bundle the checksum-pinned Microsoft SDK and a signed runtime bootstrapper."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import urllib.request
import zipfile

VERSION = '1.0.4258.31'
SDK_URL = f'https://api.nuget.org/v3-flatcontainer/microsoft.web.webview2/{VERSION}/microsoft.web.webview2.{VERSION}.nupkg'
SDK_SHA256 = '56f7f4b8bf9aee4b8efefbbdd4f67d5f74ebd1b100ed0806da71bf76af481aa9'
BOOTSTRAPPER_URL = 'https://go.microsoft.com/fwlink/p/?LinkId=2124703'

def sha(path):
    with path.open('rb') as stream:return hashlib.file_digest(stream,'sha256').hexdigest()

def fetch(url,path):
    request=urllib.request.Request(url,headers={'User-Agent':'YuYiAI-build/1.1.0'})
    temporary=path.with_suffix(path.suffix+'.download')
    try:
        with urllib.request.urlopen(request,timeout=90) as source,temporary.open('wb') as out:shutil.copyfileobj(source,out)
        temporary.replace(path)
    finally:temporary.unlink(missing_ok=True)

def prepare(destination,cache):
    destination=Path(destination).resolve();cache=Path(cache).resolve()
    destination.mkdir(parents=True,exist_ok=True);cache.mkdir(parents=True,exist_ok=True)
    sdk=cache/f'microsoft.web.webview2.{VERSION}.nupkg'
    if not sdk.exists():fetch(SDK_URL,sdk)
    if sha(sdk)!=SDK_SHA256:raise ValueError('Microsoft WebView2 SDK checksum mismatch')
    selected={'lib/net462/Microsoft.Web.WebView2.Core.dll':'Microsoft.Web.WebView2.Core.dll','lib/net462/Microsoft.Web.WebView2.WinForms.dll':'Microsoft.Web.WebView2.WinForms.dll','runtimes/win-x64/native/WebView2Loader.dll':'WebView2Loader.dll'}
    with zipfile.ZipFile(sdk) as package:
        for source,target in selected.items():(destination/target).write_bytes(package.read(source))
        for name in package.namelist():
            if '/' not in name and ('license' in name.lower() or 'notice' in name.lower()) and not name.endswith('/'):
                (destination/name).write_bytes(package.read(name))
    bootstrapper=cache/'MicrosoftEdgeWebview2Setup.exe'
    if not bootstrapper.exists():fetch(BOOTSTRAPPER_URL,bootstrapper)
    env={**os.environ,'YUYI_WEBVIEW_BOOTSTRAPPER':str(bootstrapper)}
    command="$s=Get-AuthenticodeSignature -LiteralPath $env:YUYI_WEBVIEW_BOOTSTRAPPER; if($s.Status -ne 'Valid' -or $s.SignerCertificate.Subject -notmatch 'O=Microsoft Corporation'){throw 'Invalid Microsoft runtime installer signature'}"
    subprocess.run(['powershell.exe','-NoProfile','-NonInteractive','-Command',command],env=env,check=True,capture_output=True,timeout=45)
    shutil.copy2(bootstrapper,destination/bootstrapper.name)
    metadata={'sdkVersion':VERSION,'sdkUrl':SDK_URL,'sdkSha256':SDK_SHA256,'runtimeBootstrapperUrl':BOOTSTRAPPER_URL,'runtimeBootstrapperSha256':sha(bootstrapper),'runtimeBootstrapperMicrosoftSignatureVerified':True}
    (destination/'WEBVIEW-MANIFEST.json').write_text(json.dumps(metadata,indent=2)+'\n',encoding='utf-8')
    return metadata

if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('--destination',required=True,type=Path);parser.add_argument('--cache',required=True,type=Path);args=parser.parse_args()
    print(json.dumps(prepare(args.destination,args.cache)))
