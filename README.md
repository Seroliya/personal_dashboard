# Personal Dashboard

Windows 桌面悬浮仪表盘，把平台数据、模型用量、Markdown 待办、每日阅读和电脑使用统计放在一起。

## 下载与启动

在本仓库的 **Releases** 下载 `Personal-Dashboard-1.1.0-win-x64.zip`。

1. 将压缩包**完整解压**到一个固定目录，不要在压缩包内直接运行。
2. 双击 `启动.cmd` 或 `Personal Dashboard.exe`。免安装包已包含 Node.js、Electron 和 ccusage，无需另装 Node.js 或执行 npm。
3. 屏幕右侧出现三横杠悬浮按钮，点击展开/收起，拖动可移动，Esc 收起。托盘菜单可重新加载面板；“关闭悬浮窗”隐藏按钮和面板但保留托盘，点击托盘或“打开悬浮窗”恢复；“退出”结束整个应用。
4. 首次采集会打开浏览器，按出现的页面登录知乎、B站和 DeepSeek 开放平台。登录态会保留，后续正常采集在后台进行。
5. 打开右上角设置，选择自己的 Markdown 待办文件和文章目录；没有对应目录时先设置，再使用每日阅读。

支持 Windows x64。网页数据采集需要已安装的 Microsoft Edge；如果本机已有 Playwright Chromium，也可以使用它。没有浏览器时，其余模块仍可使用。该版本未做代码签名。

升级时，从托盘退出旧版本，再将新压缩包解压到新目录启动。设置、文章阅读记录和平台登录态保存在用户目录，解压新版本不会覆盖这些数据。默认使用 3456 端口；同一台电脑运行一份 Dashboard 服务即可。

## 四个页面

| 页面 | 用法 |
| --- | --- |
| 信息总结 | 查看 Clash 状态、知乎今日阅读/赞同/收藏、B站昨日统计、七天模型用量和城市天气；点击“更新数据”刷新。 |
| 日常待办 | 选择 Markdown 文件，勾选待办会回写原文件；下方是每日阅读，点击文章在面板内阅读。 |
| 电脑使用 | 选择日期，查看使用/离开时长、七天趋势、当天小时分布和应用排行；点击日期柱子切换到当天。 |
| 对话模式 | 切换本地 LM Studio 或 DeepSeek，支持保存和切换对话记录；需先配置对应模型或 API key。 |

天气默认有上海和重庆，点击城市切换。通过“⋯”添加或删除自定义城市。

每日阅读默认一次推荐 4 篇、每日目标 4 篇、前台阅读 30 秒后自动完成。三项可在设置中分别修改；切换页面或失去焦点会暂停计时。“刷新推送”更换推荐，完成数可跨批累计。点击 ☆ 收藏，会给原文章文件名前加一次 ⭐。点击右侧归档盒图标，文章会移入所选文章目录的“已归档”文件夹，保留原子目录和收藏星号，以后不再推送；归档不会把未读文章算成完成。阅读、收藏、归档和 Markdown 待办是桌面功能，普通网页不提供对应 Electron 功能。

## 模型用量

最近七天每天一根堆叠柱，悬停在色段可查看该来源的精确 token 明细与费用，聚焦整根柱子可查看所有来源。

| 颜色 | 来源 | 配置 |
| --- | --- | --- |
| 紫色 | DeepSeek | 在采集浏览器登录 `platform.deepseek.com`，读取后台实际用量和费用；仅有 API key 不够。 |
| 绿色 | Codex / ccusage | 自动读取当前用户的 Codex 本地会话记录。发行包包含 ccusage，源码运行通过 npm 安装。 |
| 粉色 | WorkBuddy | 本机 WorkBuddy 网关应运行在 `http://127.0.0.1:8788`，读取 analytics 的全部账号用量；默认登录密码 `admin`。 |

WorkBuddy 的消耗显示为后台原生积分。DeepSeek 和 Codex 按各自币种显示；Codex 金额按 ccusage 计算，不等于订阅扣款。没有接入某个来源时显示待采集或更新失败，其余来源正常展示。

如果 WorkBuddy 修改了面板密码，可以在 PowerShell 中设置后启动：

```powershell
$env:WORKBUDDY_PASSWORD = "你的面板密码"
& ".\Personal Dashboard.exe"
```

## Clash 代理状态

页面底部、Developed by kiro_kiya 上方以黑色文字显示出口 IP 所属位置和“普通代理 / TUN”，悬停查看完整 IP。默认自动读取本机 Clash Verge Rev 的运行接口，无需填写控制密码；使用其他配置位置时可通过 `CLASH_CONFIG_PATH` 指定 YAML 文件（需要启用控制接口）。仅查询状态，不修改代理设置。

模式每 15 秒检查，出口位置通过 Clash 本地代理查询并缓存 2 分钟；切换节点后可点击“更新数据”立即更新位置。系统代理关闭且未开启 TUN 时显示“未启用”；Clash 未运行或无法读取接口时显示“未连接”；位置服务暂时不可用时保留模式并显示“位置未知”。此功能为 v1.1.0 发布后的源码更新。

## ActivityWatch

先安装并启动 ActivityWatch，确认 `http://127.0.0.1:5600` 可打开，并启用窗口 watcher 和 AFK watcher。然后进入“电脑使用”页面即可自动读取。

统计使用当前电脑的窗口记录，并排除 AFK 离开时段。没有安装、没有启动或缺少 watcher 时，页面会提示原因；应用不会替你安装 ActivityWatch。

## 对话配置

### DeepSeek

在 `%APPDATA%\personal-dashboard-desktop\secrets.json` 创建文件：

```json
{
  "deepseekApiKey": "填入自己的 API key"
}
```

源码启动时，该文件放在 `desktop-panel\secrets.json`。也可以通过环境变量 `DEEPSEEK_API_KEY` 配置。API key 用于对话，平台用量采集使用浏览器登录。

### LM Studio

本地接口地址为 `http://127.0.0.1:1234`，默认使用项目的 `QiQi/qiqi-qwen27b-q3-no-thinking` 模型。需要先在 LM Studio 中准备该模型并开启 API 服务。设置中的“自动启动 LM Studio 模型服务”默认开启；不用本地对话时可关闭。CLI 默认位于当前用户的 `.lmstudio\bin\lms.exe`，可用环境变量 `LMS_EXE` 覆盖。

## 数据保存与重新登录

- 桌面设置、文章历史：`%APPDATA%\personal-dashboard-desktop\`。
- 免安装包的采集缓存和浏览器登录态：上述目录下的 `server\`。
- 源码运行的采集缓存和登录态：项目目录。可用 `DASHBOARD_DATA_DIR` 指定其他目录。
- 平台登录过期时，先退出 Dashboard 及已有网页服务，再双击发行包中的 `登录平台.cmd`，在可见浏览器中重新登录。完成后按 Ctrl+C 结束，再正常启动应用。
- 浏览器位置可通过 `DASHBOARD_BROWSER_PATH` 指定完整的浏览器 exe 路径。

## 从源码运行

需要 Windows x64、Node.js 22 和 npm：

```powershell
git clone https://github.com/Seroliya/personal_dashboard.git
cd personal_dashboard
npm ci
npm run desktop
```

只启动网页服务：`npm start`，然后访问 `http://127.0.0.1:3456`。第一次运行同样需要在采集浏览器中登录平台。如果没有 Edge，可执行 `npx playwright install chromium`。

源码模式也可以双击 `桌面悬浮窗.vbs` 启动。推荐先设置自己的文章目录和 Markdown 文件；默认位置是当前用户坚果云仓库下的目录。

## 测试与打包

```powershell
npm test
npx playwright install chromium
npm run test:ui
npm run package:windows
```

UI 测试可通过 `DASHBOARD_TEST_BROWSER` 指定现有 Chromium。打包需要 Windows x64、已安装的开发依赖；输出到 `dist\`，包含免安装目录、ZIP 和 `SHA256SUMS.txt`。打包脚本只复制发布所需文件，不包含个人密钥、登录态、统计缓存、日志或备份。

维护者可创建 `v1.1.0` 形式的标签并推送，GitHub Actions 会运行检查、打包并创建 Release。项目结构与长期约定见 [PROJECT.md](PROJECT.md)。
