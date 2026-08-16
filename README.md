# frp-panel

一个可以部署在公网服务器上的轻量 FRP 控制面板。它把常用的 frps 运维工作放进浏览器：管理员登录、客户端/隧道管理、frps 配置生成、一键客户端安装命令、服务启停/重启、配置下载和最近操作审计。

## 功能

- 管理 TCP、UDP、HTTP、HTTPS、STCP、XTCP 隧道。
- 每个客户端生成独立令牌和一键 Linux / Windows PowerShell 安装命令；命令会下载对应架构的 frpc 和 frpc.toml，并注册为系统服务/开机任务。
- 在线编辑 frps 监听端口、Dashboard、认证令牌和日志级别，下载生成的 frps.toml。
- 面板可以直接调用镜像内置的 frps 进程启停；数据和生成文件持久化到 data/、generated/。
- JSON 原子写入、HttpOnly 会话 Cookie、审计记录、健康检查和 Docker 更新流程。

## 一键部署（推荐）

在一台全新 Ubuntu/Debian 公网服务器执行（脚本会自动尝试代码仓库镜像）：

    curl -fsSL https://raw.githubusercontent.com/sx120609/frp-panel/main/scripts/install.sh \
      | sudo bash
    sudo nano /opt/frp-panel/.env
    cd /opt/frp-panel
    sudo docker compose up -d --build

.env 至少设置：

    ADMIN_PASSWORD=一段至少16位的强密码
    SESSION_SECRET=openssl rand -hex 32 的输出
    PUBLIC_BASE_URL=https://panel.example.com

如果服务器无法访问 GitHub，可在执行安装脚本前设置 `FRP_PANEL_REPO_MIRRORS`（逗号分隔）或直接设置 `FRP_PANEL_REPO` 为可访问的仓库地址。

打开 http://服务器IP:8080，用 ADMIN_PASSWORD 登录。公网防火墙至少放行面板端口 8080、FRP 服务端口 7000，以及你在面板给 TCP/UDP 隧道分配的远端端口；生产环境建议用 Caddy/Nginx 将 8080 反代为 HTTPS。

镜像构建时会从 FRP 官方 Release 下载 frps，默认版本为 0.61.1。客户端一键脚本针对中国大陆网络会依次尝试可用的 GitHub 加速源和官方源；也可以在 `FRP_DOWNLOAD_MIRRORS` 中填写逗号分隔的自建/国内镜像基础 URL。升级版本可执行：

    docker compose build --build-arg FRP_VERSION=0.61.1
    docker compose up -d

## 更新

    cd /opt/frp-panel
    sudo ./scripts/update.sh

更新脚本使用 git pull --ff-only，重新构建镜像并清理无用镜像，不会删除 data/ 和 generated/。

## 手动运行

需要 Node.js 20+：

    cp .env.example .env
    # 编辑 .env，必须设置 ADMIN_PASSWORD
    npm start

若手动运行且服务器上已有 frps，把 FRPS_BIN 设置为其绝对路径；面板中的启动/停止按钮会直接管理该进程。Docker 方式则使用镜像内置的 frps。
设置 FRPS_AUTO_START=true 后，面板进程启动时会自动拉起 frps，适合 systemd 部署。

## 客户端使用

1. 在“客户端”页新建客户端。
2. 在“隧道”页添加一个或多个映射。
3. 点击“一键命令”，选择 Linux 或 Windows PowerShell。
4. Linux 命令会自动识别架构、下载对应版本的 frpc、校验配置并创建 systemd 服务；Windows 命令需要在“管理员 PowerShell”中执行，会自动校验配置、下载对应架构的 frpc、写入 `%ProgramData%\\frp-panel` 并创建 Windows 开机任务。Windows 原生 `frpc.exe` 不是 Service Control Manager 服务程序，因此使用任务计划程序托管，避免直接 `New-Service` 导致启动失败。
5. 客户端配置默认开启断线重连，并使用 TCP 多路复用 keepalive 维持长连接，避免部分网络环境下应用层心跳误判超时；Linux 服务和 Windows 任务都会在 frpc 异常退出后自动拉起。新增或修改隧道后重新执行同一个一键命令即可拉取最新配置并重启客户端。
6. macOS 或不希望使用系统服务的机器，可在“配置”中复制 TOML，下载对应版本的 frpc 后运行 `frpc -c frpc.toml`。

客户端安装脚本使用带令牌的 URL。令牌等同于访问权限，请不要公开分享；删除客户端前先删除该客户端下的隧道。

## API 摘要

| 方法 | 路径 | 作用 |
| --- | --- | --- |
| GET | /api/health | 无需登录的存活检查 |
| POST | /api/login | 管理员登录 |
| GET | /api/bootstrap | 面板初始化数据 |
| POST/PATCH/DELETE | /api/clients、/api/tunnels | 资源管理 |
| GET | /api/clients/:id/install-command | 生成一键命令和配置 |
| GET | /api/config/frps | 下载服务端配置 |
| POST | /api/service/start\|stop\|restart | 管理 frps 进程 |

## 安全建议

- 使用长随机 ADMIN_PASSWORD 和 SESSION_SECRET，不要把 .env 提交到 Git。
- 用 HTTPS 反向代理保护面板；不要把 Dashboard 端口直接暴露给全网。
- 定期备份 data/db.json，变更认证令牌后重新生成所有客户端配置。
- 生产环境可在反向代理增加 IP 白名单、Basic Auth 或 SSO。
