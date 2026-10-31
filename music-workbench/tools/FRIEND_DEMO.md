# 好友临时体验入口

`osmanthus_share_gateway.mjs` 是现有本机工作台前的一层访问网关，用于将音乐与 `/mv/` 一起提供给少量获邀朋友体验。它不改变原后端的本机 Origin 限制，也不提供独立账号或用户数据隔离。

## 运行条件

- 本机音乐服务已在 `127.0.0.1:8603` 运行，MV 已挂载到 `/mv/`。
- Node.js 22 或以上版本，以及自行安装的 Cloudflare Tunnel 客户端。
- 电脑持续开机联网。临时隧道结束后链接失效，重新启动可能更换地址。

## 配置与启动

配置应保存到 Git 忽略的 `.local/` 目录，文件权限设为 `0600`。以下用 Python 生成随机凭证，不要将实际配置或体验链接提交到仓库：

```sh
python3 - <<'PY'
from pathlib import Path
import json, secrets
p = Path('.local/friend-demo/config.json')
p.parent.mkdir(parents=True, exist_ok=True)
if p.exists():
    raise SystemExit('配置已存在，未覆盖现有访问凭证')
p.write_text(json.dumps({
    'origin': None,
    'invite': secrets.token_urlsafe(24),
    'session': secrets.token_urlsafe(32),
    'port': 8604,
    'upstream_port': 8603
}))
p.chmod(0o600)
PY
node tools/osmanthus_share_gateway.mjs .local/friend-demo/config.json
```

另开终端运行：

```sh
cloudflared tunnel --no-autoupdate --url http://127.0.0.1:8604 --protocol http2
```

将隧道返回的 HTTPS 地址写入配置文件的 `origin` 字段（不带尾部 `/`）。网关每次请求重新读取配置，无需重启。仅把 `https://隧道地址/__invite?code=invite字段的值` 发给获邀朋友。

入口校验凭证后设置 Secure、HttpOnly、SameSite=Lax Cookie，再跳转到不带凭证的主页。请求必须来自配置的域名；写操作还校验 Origin。会话 Cookie、访问凭证和客户端 Authorization 不转发给应用。网关保留音频 Range、逐段响应与上传流，不先等待完整音频下载。

这仍是**共用同一个本机工作台**：朋友可能看到已有歌曲，编辑同一工程，并使用宿主现有的模型额度。不要将它当作多用户正式部署。停止分享时结束网关及隧道进程；轮换 `invite` 与 `session` 可使旧入口和旧会话失效。

## 验证边界

```sh
node --test tools/test_osmanthus_share_gateway.mjs
```

隔离测试覆盖未授权访问、邀请 Cookie、Host 与 Origin 校验、凭证不向上游转发、MV 路由、音频 Range 和逐段响应。实际临时隧道已检查首页、脚本、MV 能力接口及请求校验。公网逐段响应可用不等于音潮上游的持续生成播放已稳定；歌曲流速与首声延迟仍待验收。

Cloudflare Quick Tunnel 的使用范围及限制见[官方说明](https://developers.cloudflare.com/tunnel/get-started/quick-tunnels/)。
