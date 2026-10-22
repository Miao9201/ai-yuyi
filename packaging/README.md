# 语忆AI Windows 完整离线安装包

发布包内置官方 Python 3.12.10（64 位）、Node.js 和 Pillow / numpy / jieba / qrcode。
用户无需安装 Python、Node.js 或运行命令；双击 `语忆AI-Setup.exe` 即安装到当前用户的
`%LOCALAPPDATA%\Programs\AIYuYi`，创建桌面快捷方式并打开本地控制台。
便携版解压后双击 `语忆AI.exe`。升级保留既有 `data`、`private` 和设置。

仅支持 Windows 10/11 64 位。安装无需管理员权限。安装完成后不依赖下载目录；
联网仅用于微信登录和用户配置的模型接口。程序首次使用仍需用户自己的登录与 API 配置。
默认浏览器打不开时，启动器会尝试系统已有的 Microsoft Edge；都不可用时会显示本地网址。

## 构建

必须先建立独立的、已审查的公开源码目录。绝不能将私人工作目录作为构建来源。
源码目录须有 `.clean-release-source` 和 `PUBLIC-SOURCE-MANIFEST.json`，后者格式：

```json
{"files": {"launcher.py": "文件的SHA256", "runtime_paths.py": "文件的SHA256"}}
```

清单应覆盖实际应用源码、默认角色与素材、前端、`desktop-launcher.cs` 和 `packaging`。
构建器仅复制清单文件，逐项校验 SHA256，并拒绝日志、运行缓存、密钥、登录库和私人目录。
`data/` 仅允许经过审查的新配置、默认公开角色配置及空素材目录。
隐私审查仍须由源码整理者完成；路径过滤不能识别正文中的私人信息。

```powershell
./packaging/build-portable.ps1 -SourceRoot D:\clean\source -OutputRoot D:\build\release
```

构建机需要 Python 3.12（64 位，含 pip）、Node.js 和 .NET Framework 的 C# 编译器。
`-PythonExecutable`、`-NodeExecutable`、`-CacheRoot` 可指定构建机路径。
源码和输出必须独立，输出目录必须为空。构建不安装系统依赖、不修改全局 Python。
首次构建从官方 Python / Node 网站以及 PyPI 获取运行时和依赖；用户安装过程全离线。
SHA256 清单随产物输出，运行时版本、官方来源和摘要写入 `RUNTIME-MANIFEST.json`。

产物：`YuYiAI/`、`语忆AI-portable.zip`、`语忆AI-Setup.exe`、`SHA256SUMS.txt`。
构建器会在移除 PATH 中 Python 和 Node 的情况下检查内置解释器和四个依赖导入。
完整控制台与微信流程还需针对独立构建目录另做验收。

测试安装命令（普通用户无需这些参数）：

```powershell
./语忆AI-Setup.exe /quiet /target D:\build\install-test /no-launch /no-shortcut
```

暂未提供自动卸载；退出程序后可手动移除安装目录和快捷方式。
移除前请自行保存其中的配置和聊天数据。

Python 官方说明：[嵌入式发行版](https://docs.python.org/3.12/using/windows.html#the-embeddable-package)、
[Python 3.12.10](https://www.python.org/downloads/release/python-31210/)。
