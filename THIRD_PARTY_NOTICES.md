# 第三方来源与授权

本项目包含经过适配的微信 iLink 连接实现（位于 `upstream-v1.2.0/`），输入源码中保留了 wx-bridge 的历史来源或技术标识。保留原有源码注释与声明。

输入协议模块 `src/ilink.js` 的注释还标明参考腾讯官方仓库 [Tencent/openclaw-weixin](https://github.com/Tencent/openclaw-weixin)，并标注 `@tencent-weixin/openclaw-weixin@2.4.10` 为 MIT。这里保留的是源码所述来源与标注，未将其当作已独立核验的完整许可证明；早期 wechaty-puppet-claw-wechat 来源说明同样保留。

当前输入源码中未发现独立的 LICENSE 或 NOTICE 文件，因此此分发不自行声明上游使用 MIT 或其他开源许可。使用及再分发前应核对原作者授权。

内置角色及表情来自输入项目的内置示例目录，未包含任何本地聊天媒体。其来源与授权仍需由发布者核对。Python、Node.js 与 Python 依赖的许可随安装包所含运行环境另行保留。

语忆AI新增的人设导入、管理界面与本地适配修改使用根目录MIT许可；该许可不替代上游源码与素材自己的许可。输入分享版说明明确允许公开分享脱敏源文件及内置示例；上游未提供的许可证不由本项目补造。已另附腾讯协议参考项目当前官方LICENSE，保留其版权与许可，见 `licenses/Tencent-openclaw-weixin-LICENSE.txt`。

桌面窗口使用 Microsoft.Web.WebView2 SDK 1.0.4258.31，相关 LICENSE.txt 与 NOTICE.txt 随安装包保存在 runtime/webview2/。SDK 从微软 NuGet 包获取并校验固定 SHA256；Evergreen 运行组件安装程序来自微软官方链接并验证微软 Authenticode 签名，其安装与更新遵循微软许可。

QQ接入通过独立安装的 [NapCatQQ](https://github.com/NapNeko/NapCatQQ) 和 OneBot 11 通信。本次验证版本 v4.18.41 使用 Limited Redistribution License，并非MIT，适用非商业使用与再分发限制，详见[原许可证](https://github.com/NapNeko/NapCatQQ/blob/v4.18.41/LICENSE)。本仓库与语忆AI安装包不复制、修改或附带该组件或QQ客户端；用户按官方说明另行安装。参考项目 make-your-qq-ai-group-member 仅用于架构学习，未集成AstrBot或复制其群聊插件代码。

QQ预置“大肥鱼”角色卡采用 [mtshang/make-your-qq-ai-group-member 的 persona_dafeiyu.md](https://github.com/mtshang/make-your-qq-ai-group-member/blob/main/templates/persona_dafeiyu.md)，原项目MIT版权与完整许可保存在 licenses/qq-persona-MIT.txt。该文本作为可编辑角色资料使用，不包含真实用户聊天资料；不代表本软件与DeepSeek官方存在关联。
