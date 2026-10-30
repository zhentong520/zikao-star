# RSSHub HTTPS 接入指南（Cloudflare Tunnel 方案）

> 目标：让你服务器上的 RSSHub（`47.112.10.43:1200`）拥有一个 **https://** 地址，
> 手机 APK 才能抓取它（HTTPS WebView 禁止请求 HTTP 接口）。
>
> 原理：服务器上装一个 `cloudflared`，它主动「拨出」一条加密隧道连到 Cloudflare。
> 你访问 `https://rsshub.你的域名.top` 时，流量从 Cloudflare 走隧道进你的服务器。
> **不用开端口、不用备案、不用改 RSSHub 任何配置。**
>
> 全程 30~60 分钟，费用 = 一个便宜域名的钱。

---

## 第 0 步：SSH 登录服务器，确认 RSSHub 部署方式

用你平时连阿里云服务器的方式登录（阿里云控制台「远程连接」也行），依次跑：

```bash
docker ps 2>/dev/null | grep -i rsshub && echo "★ 是 Docker 部署"
pm2 list 2>/dev/null | grep -i rsshub && echo "★ 是 pm2 部署"
ps -ef | grep -i rsshub | grep -v grep
```

**能打印出 RSSHub 进程信息就够了**（本文档的方案不需要改动它，知道怎么确认即可）。
再确认端口活着：

```bash
curl -s http://localhost:1200/gov/gd/eea/kszs | head -c 200
```

有 XML/HTML 输出说明 RSSHub 正常，继续往下。

---

## 第 1 步：买一个便宜域名（约 5~15 元）

1. 打开阿里云域名页：https://wanwang.aliyun.com/domain/
2. 搜索一个好记的，推荐 `.top` / `.xyz` 后缀（首年几块钱，比如 `zikao-feed.top`）
3. 下单 → **完成实名认证**（不做实名域名无法解析，认证当天一般几分钟到几小时生效）

> 不用备案——我们走 Cloudflare 隧道，不占用大陆服务器的 80/443 端口对外服务。

---

## 第 2 步：把域名托管到 Cloudflare（免费）

1. 注册/登录 https://dash.cloudflare.com （邮箱注册即可）
2. 控制台点 **Add a site（添加站点）** → 输入你买的域名（如 `zikao-feed.top`）→ 选 **Free 免费套餐**
3. Cloudflare 会扫描你现有解析（没有就直接下一步），最后给你**两个 NS 服务器地址**，形如：
   ```
   xxx.ns.cloudflare.com
   yyy.ns.cloudflare.com
   ```
4. 回到**阿里云域名控制台** → 我的域名 → 管理 → **DNS 修改/修改 DNS 服务器** → 把原来的
   `dns1.hichina.com` 之类**替换成 Cloudflare 给的那两个** → 保存
5. 等 NS 生效（几分钟到几小时）。Cloudflare 控制台显示 **Active（绿色勾）** 就是好了，
   会给你发一封生效邮件。

---

## 第 3 步：服务器安装 cloudflared

SSH 到服务器，执行：

```bash
# 下载（amd64）
curl -L -o /usr/local/bin/cloudflared \
  https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64
chmod +x /usr/local/bin/cloudflared
cloudflared --version    # 打印版本号即安装成功
```

> GitHub 直连慢的话，先在本机下载再 scp 上去：
> 本机：`curl -L -o cloudflared https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64`
> 上传：`scp cloudflared root@47.112.10.43:/usr/local/bin/cloudflared`

---

## 第 4 步：创建隧道并绑定域名

```bash
# 4.1 授权（会打印一个 https://dash.cloudflare.com/... 的链接）
cloudflared tunnel login
```

复制链接到**你自己电脑的浏览器**打开 → 登录 Cloudflare → 选中你的域名 → 授权。
成功后服务器上会生成 `~/.cloudflared/cert.pem`。

```bash
# 4.2 创建隧道（名字随意，如 zikao-feed）
cloudflared tunnel create zikao-feed
# 输出里会给出一段 Tunnel UUID，记住它

# 4.3 写隧道配置
mkdir -p ~/.cloudflared
cat > ~/.cloudflared/config.yml <<'EOF'
tunnel: <把上面输出的 UUID 粘到这里>
credentials-file: /root/.cloudflared/<同样的 UUID>.json
ingress:
  - hostname: rsshub.你的域名.top
    service: http://localhost:1200
  - service: http_status:404
EOF

# 4.4 把域名指向隧道（自动在 Cloudflare 建 DNS 记录）
cloudflared tunnel route dns zikao-feed rsshub.你的域名.top

# 4.5 前台试跑
cloudflared tunnel run zikao-feed
# 看到 "Registered tunnel connection" 字样即成功
```

---

## 第 5 步：验收

在你自己电脑的浏览器打开：

```
https://rsshub.你的域名.top/gov/gd/eea/kszs
```

能看到一大段 XML（`<rss ...>` 开头）就大功告成 🎉
（地址栏有锁图标 = HTTPS 生效）

---

## 第 6 步：设为开机自启（别关 SSH 就断）

按 `Ctrl+C` 停掉前台试跑，然后：

```bash
cloudflared service install
systemctl enable cloudflared
systemctl start cloudflared
systemctl status cloudflared    # active (running) 即常驻成功
```

---

## 第 7 步：告诉我域名，我来改代码（1 分钟的事）

把你的域名发给 AI 助手即可，剩下的自动完成：

- `shared/store.js` 里两个 RSS 源 URL 换成 `https://rsshub.你的域名.top/...`
- 去掉 `pcOnly` 标记（手机端解锁 RSS 源）
- 重新打包签名 APK、更新 GitHub Release

---

## 常见坑

| 现象 | 原因与解法 |
|------|-----------|
| NS 修改后半天不生效 | 正常范围几分钟~24h；可用 `nslookup -type=ns 你的域名.top` 查是否已切换 |
| `tunnel login` 链接打开是空白 | 换 Chrome/Edge，别用微信内置浏览器 |
| 验收页 502 Bad Gateway | 服务器上 RSSHub 挂了 → 回第 0 步 `curl localhost:1200` 检查并重启它 |
| 验收页 1033 错误 | 隧道没在跑 → `systemctl status cloudflared` 看日志 |
| 手机 APK 还是不抓 RSS 源 | 正常——等你把域名发给我，代码侧还没切换 |
