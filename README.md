# DiscFlow

DiscFlow 是一个面向局域网的刻录任务系统。局域网内的用户通过浏览器选择文件或上传 ISO，Windows 刻录服务器按提交顺序把任务送入唯一的刻录机。

## 组成

- `src/`：NestJS API、上传处理、持久化任务队列和 SSE 实时状态。
- `client/`：React Web 客户端，生产构建后由 NestJS 直接托管。
- `windows/`：运行在刻录服务器上的 IMAPI2 PowerShell 代理。
- `docs/architecture.md`：部署拓扑、状态机、接口和扩展方案。

## 本地开发

需要 Node.js 20 或更高版本。

```bash
npm install
cp .env.example .env
npm run dev
```

开发机不是 Windows 时会自动启用模拟刻录。浏览器访问 `http://localhost:5173`，API 运行在 `http://localhost:3000/api`。

## 构建与运行

```bash
npm run typecheck
npm run build
npm start
```

生产模式默认监听 `0.0.0.0:3000`，构建后的 Web 界面也由同一个端口提供。局域网客户端访问 `http://<刻录服务器IP>:3000`。

## Windows 刻录服务器

1. 在服务器安装 Node.js 20 LTS，并允许 Node.js 程序通过 Windows 防火墙的专用网络访问。
2. 在 `.env` 中把 `BURN_SIMULATION` 设为 `false`。可用 `BURN_DRIVE=D:` 固定刻录机盘符；留空时脚本选择第一台已连接刻录机。
3. 先用一张可丢弃的 CD/DVD 执行一次真实刻录，确认 IMAPI2 驱动、盘片和刻录机组合正常。
4. 生产环境建议用 NSSM 或 Windows 任务计划程序把 `npm start` 注册为开机服务，并把 `DATA_DIR` 指向有足够空间的本地磁盘。

不要将端口直接暴露到互联网。当前最小版本默认信任局域网用户；如需跨网段使用，应在反向代理层增加身份认证和 HTTPS。

## 数据与恢复

任务快照保存在 `data/jobs.json`，源文件保存在 `data/jobs/<job-id>/`。写入采用临时文件加原子替换。

服务重启时，排队任务会继续排队；正在准备或刻录的任务会标记为失败，避免服务器在不知道光盘状态时自动重复刻录。确认盘片状态后，用户可以在界面中重试。

