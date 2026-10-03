# personal_dashboard

## 背景与目标
个人 Windows 桌面仪表盘，集中展示创作平台数据、天气、本地 Markdown 待办、文章推荐及模型对话。主使用方式为 Electron 右侧悬浮面板；网页模式仅提供部分功能。

## 结构与运行流程
- `server.js`：HTTP 服务（3456 端口）、知乎/B站/DeepSeek 数据采集、中央气象台城市搜索和多城市天气刷新；结果保存在 `data.json`，默认每 10 分钟刷新。
- `dashboard.html`：单页界面，包含信息总结、日常待办、电脑使用和对话模式；设置入口在右上角。每日阅读位于日常待办。
- `model-usage.js`：DeepSeek 每日用量采集、ccusage Codex 采集和七天数据归一化；相关统计与图表测试为 `model-usage.test.js`、`model-usage-ui.test.js`。
- `workbuddy-usage.js`：本机 WorkBuddy 网关登录和每日统计采集。
- `activity-watch.js`：本机 ActivityWatch 按日查询和应用、小时统计；`/api/activity` 为页面数据入口。
- `clash-status.js`：Clash 运行模式与代理出口 IP 地理位置；独立 `/api/clash` 接口，不阻塞平台统计。
- `desktop-panel/main.js`：Electron 窗口、托盘、设置、Markdown 渲染与待办修改、文章 IPC、本地模型和 DeepSeek 对话。
- `desktop-panel/panel-preload.js`：隔离界面的 IPC 桥接。
- `desktop-panel/articles.js`：文章扫描、抽样、阅读历史和收藏重命名。
- `desktop-panel/secrets.json` 与 `.auth.json`：本地密钥和登录态，不应提交或写入文档。
- `backups/`：修改前的备份；工作区可能有用户未提交的更改，不能直接回退。
- `runtime-paths.js`：当前用户的默认目录、可写数据路径和采集浏览器选择；`scripts/package-windows.cjs` 构建 Windows x64 免安装 ZIP，包含 Electron、Node 运行时及生产依赖（包括 ccusage）。`.github/workflows/release.yml` 在版本标签推送后测试、打包并创建 GitHub Release。

通过 `npm start` 启动网页服务；通过 `npm run desktop` 或“桌面悬浮窗.vbs”启动桌面模式。Electron 会检查并按需启动服务。桌面主进程和预加载代码变更后需要重启应用；服务启动时缓存页面，更新页面后也需要重启服务。

发行包双击 `Personal Dashboard.exe` 或 `启动.cmd`，使用 `resources/runtime/node.exe` 启动后台服务。设置与文章历史在 `%APPDATA%/personal-dashboard-desktop`，采集缓存与登录态在其 `server` 子目录；源码模式维持项目目录，可用 `DASHBOARD_DATA_DIR` 覆盖。采集浏览器支持 `DASHBOARD_BROWSER_PATH`，兼容已有 Chromium 并回退到本机 Edge；没有登录态时首次窗口可见。固定个人路径改为当前用户目录；README.md 和包内使用说明描述全部接入条件。

后台启动（`SILENT=true`）且登录态含 cookie 或 localStorage 时，浏览器使用真正的 `headless: true`，取消移到屏幕外的窗口方式。首次没有登录态、空登录态及手动运行 `npm start`/`登录平台.cmd` 时使用可见浏览器。Persistent context 启动后显式补回保存的会话 cookie 和缺失的按来源 localStorage，不覆盖 profile 中较新的值。无头模式遇到平台登录页立即报出重新登录提示，不等待不可见窗口中的人工操作；单项采集失败保留已有数据，汇总错误可悬停主状态查看。本调整在 v1.1.0 发布之后进行，旧发行包仍使用屏幕外窗口。

## 功能约定
### 悬浮窗与托盘
- 托盘与菜单图标使用 `desktop-panel/icons` 的 PNG 和 @2x 资源，避免 Windows nativeImage 解码 SVG 为空；打包脚本显式包含资源目录。`scripts/generate-tray-icons.cjs` 可重新生成图标。
- 托盘菜单包括展开/收起、重新加载面板、关闭悬浮窗和退出。关闭悬浮窗隐藏面板与按钮、取消未完成动画及拖动、恢复按钮原位置，后台与托盘继续运行；菜单随后显示“打开悬浮窗”，托盘单击也可恢复。退出才结束应用。动画目标状态独立记录，避免快速切换或关闭途中使窗口重新出现。

### Markdown 与设置
复用现有 `marked` 和 `sanitize-html` 渲染。日常待办保留独立的文件选择和复选框回写功能，文章预览不改变待办文件选择。桌面设置保存在 Electron `userData/dashboard-settings.json`；开机启动与模型自动启动维持原有设置。

### 信息总结排版
- 各模块使用紧凑分区和细分隔线，取消独立背景卡片；知乎和 B站各一行，阅读/播放、赞同/点赞、收藏的标签与数值横排。400px 以下平台名称另起一行，三个指标仍保持同一行。
- 模型用量保留七天堆叠图和悬停明细，减少标题、合计和图表留白；不显示时区、日期统计口径、API 估价说明及采集时间等解释文案。
- 天气当前和明日信息横排，长描述可悬停查看全文，空错误区域不占高度。

### Clash 状态
- 页面底部、Developed by kiro_kiya 上方以一行黑色文字显示模式与出口地区，悬停查看完整 IP；没有独立卡片。模式读取 Mihomo `/configs` 的 `tun.enable`，普通代理同时核对 Windows 当前用户系统代理是否启用且指向 Clash 端口；未开启显示“未启用”，接口不可用显示“未连接”，地理位置失败只显示“位置未知”。
- 默认读取 `%APPDATA%/io.github.clash-verge-rev.clash-verge-rev/clash-verge.yaml`；`CLASH_CONFIG_PATH` 可覆盖。优先命名管道，适配 Verge 生成配置与实际管道名称不同的版本（按配置哈希匹配唯一运行管道），否则使用 TCP 控制接口。认证密钥仅留在服务端内存，不向页面返回。
- HTTPS 地理查询 `https://ipwho.is/` 显式经过本地 Clash HTTP/mixed 端口，不回退直连。运行状态缓存 15 秒、出口位置缓存 2 分钟，合并并发请求，“更新数据”强制刷新；关闭/失败时清除旧出口，网络请求有超时。只读，不修改 Clash 配置。打包包含新模块及 `yaml`、`https-proxy-agent` 生产依赖；v1.1.0 旧压缩包未包含此更新。

### 城市天气
- 内置上海（`WwcJd`）和重庆（`UkfaS`），在天气卡片内切换；当前选择使用浏览器 `localStorage` 持久化。
- 默认只显示城市切换和“⋯”管理入口；添加、删除在展开菜单后使用。搜索输入显式遵守 `hidden`，点击外部收起菜单，取消或 Escape 关闭搜索并中止未完成查询。
- 可按城市名或拼音调用中央气象台 autocomplete 接口搜索，从包含省份的候选列表中添加，避免同名城市误选；自定义城市最多 20 个且可删除，内置城市不可删除。
- 站点 ID、名称、省份和预报路径由服务端校验；天气按站点缓存在 `data.json` 的 `weatherByCity`，旧版上海 `weather` 数据自动兼容迁移。
- 自动更新和“更新数据”会刷新所有已添加城市；单城失败保留其上次有效数据并写入独立错误状态，不影响其他城市或仪表盘功能。

### 平台数据
- 知乎“今日”卡片读取知乎创作中心的结构化接口，不依赖容易随改版变化的页面文字。阅读量使用 `today_read_count`，赞同使用“今日新增赞同”口径（不扣除当日取消赞同），收藏使用当日数据行；任一关键字段异常时保留上一次完整有效结果。
- 知乎、B站或 DeepSeek 单项采集失败不能清空已有值，也不能阻断天气、待办、文章或对话功能。

### 模型用量
- 模型用量卡片合并 DeepSeek、Codex、WorkBuddy，按北京时间展示含今天的最近七天，每天一根堆叠柱：紫色 DeepSeek、绿色 Codex、粉色 WorkBuddy 从下到上堆叠，共用 token 纵轴，柱高为三者合计。总 token 包含缓存，推理 token 属于输出，不能再次加到总量中。
- DeepSeek 复用已登录的后台请求认证，读取 `/api/v0/usage/by_api_key/amount` 和 `cost` 的 GMT+8 每日分桶，汇总所有 API key 与模型；仅保存聚合结果，不持久化认证头或 API key 元数据。费用采用后台实际币种，不与 Codex 美元直接相加。
- Codex 使用本地或全局安装的 `ccusage codex daily --json --config ccusage.dashboard.json --since YYYY-MM-DD --until YYYY-MM-DD --timezone Asia/Shanghai --no-offline`，每分钟独立刷新，手动更新也触发；更新价表失败时回退离线执行。不依赖浏览器采集成功，命令有超时且隐藏窗口，不在每次网页轮询时启动进程。
- `ccusage.dashboard.json` 补充 GPT-6.1 Sol 官网价格（2026-10-02 核对 `https://developers.openai.com/api/docs/models/gpt-6.1-sol`）：每百万 token 标准输入 $2、缓存读取 $0.10、缓存写入 $2.50、输出 $10；超过 272K 输入的整次请求为 $4/$0.20/$5/$15，Priority 为 2 倍。配置字段 `Above200kTokens` 是 ccusage 的通用字段名，实际阈值由 ccusage 模型价表控制；不根据每日累计 token 选择长上下文档位。
- Codex 费用采用 ccusage 计价，不代表订阅实际扣款；界面只展示数值和必要的“价格未知”，不添加估价解释。悬停或键盘聚焦柱子可查看精确 token、缓存、输出、推理和费用。每日悬停总览跳过总 token 为 0 的供应商，三者均为 0 时不显示空浮层；数据缺失仍保留待采集提示。
- WorkBuddy 读取 `http://127.0.0.1:8788/usage/analytics` 的 `realm=all&range=custom&since=秒时间戳&until=秒时间戳`，每天独立读取 `summary.window`，不使用 `all_time`。网关上下界均包含，结束值减一微秒以避免午夜重复；输入总量已含缓存，未缓存输入为 prompt 减 cached，推理包含在 completion 中。`credit` 是积分，只显示积分，不换算为货币。
- WorkBuddy 默认使用用户授权的本地 admin 密码，环境变量 `WORKBUDDY_PASSWORD` 可覆盖；通过 `/panel/login` 获得的 token 仅保留在采集器内存，统计使用 `X-Panel-Token`，失效后自动重新登录。每分钟独立刷新，手动更新也触发，单次请求有超时。
- `data.json` 的 `deepseek.daily`、`codex.daily`、`workbuddy.daily` 缓存成功结果，采集失败保留已有明细并记录各自错误。`/api/data` 动态生成 `modelUsage` 七天视图，旧 30 天总量不推算每日数据；未采集日期与有效零用量分开显示。

### 电脑使用
- 依赖本机运行的 ActivityWatch，读取 `http://127.0.0.1:5600/api/0`。选择同一主机的 currentwindow 与 afkstatus bucket，优先当前电脑；通过原生 query API 的字符串数组查询，使用 `filter_period_intersect` 排除 AFK 时段。
- 页面可选择日期、前后切换、刷新及点击七天柱子，展示当天使用/离开时长、应用数量、最近七天使用时长、24 小时分布和应用排行。按北京时间切日，拒绝未来和无效日期，区间裁剪到当天与当前时刻，重叠记录按时间并集计时；只返回应用名与统计，不返回窗口标题。
- 从 `/api/0/settings` 读取有效分类（支持旧 `classes` 和按 `active_set_ids` 优先级合并的分类集），交给 ActivityWatch 原生 `categorize` 对已排除 AFK 的窗口事件分类；不在 Dashboard 另写正则匹配器。返回 `categories`、`categoryTree` 及 `hours[].categories` 的聚合时长，配置颜色沿父级继承，未配置颜色稳定分配。
- 小时时间线按分类堆叠，共用 0–1h 纵轴；分类树默认折叠，可逐层展开并切换为全天使用占比，刷新保留展开状态。分类旭日图使用本地 SVG，无外部图表服务，内外环对应分类层级，悬停/键盘聚焦查看完整路径、精确时长和全天占比。
- 分类统计将重叠事件拆成互斥时段，最新开始的事件优先，结束后恢复仍有效的旧事件；分类、小时堆叠及树根总和均等于有效使用时长。父节点记录包含子分类的 `seconds` 以及仅本级的 `directSeconds`，分类树展开后用“本级”显示直接时长，旭日图保留对应空外环，避免重复计时。
- 应用使用中不足 300 秒的应用放入默认折叠的“5 分钟以下的应用”分组；正好 300 秒及以上正常显示。折叠仅影响列表展示，不改变统计、应用数量和图表；用户展开后刷新/换日保留本次会话的选择。
- 同一天请求合并，结果缓存 30 秒，强制刷新跳过缓存；查询超时 10 秒。页面仅在显示时每分钟更新；连接失败或记录缺失显示明确错误，零记录显示空态。

### 每日文章推荐
- 位于日常待办页面的 Markdown 待办下方；只有该页面显示且窗口处于前台时累计阅读时间。
- 默认根目录：`C:\Users\15300\Nutstore\1\默认仓库\01. Zhihu_collections`。注意 `Zhihu_collections` 为一个目录名。可从右上角选择其他目录。
- 递归扫描 `.md`、`.markdown`、`.txt`，排除隐藏条目、符号链接与 `_目录`/README/index 索引文件；不限制推荐来自不同子目录。
- 知乎文章和回答按文件名中的 `article-数字` / `answer-数字` 去重，改名后可回退到正文元数据 `zhihu_id`；其他文件按内容哈希识别，内容未变时移动/改名不丢阅读记录。已有路径 ID 在扫描时迁移，普通文件内容变更视为新文章。
- “一次推荐篇数”（`articleBatchCount`）与“每日目标篇数”（`dailyArticleGoal`）独立设置，均默认 4、允许 1–50；兼容旧设置 `dailyArticleCount`，两个新值未设置时各自沿用旧值。推荐数量只控制列表长度，每日目标只控制完成判定。每篇达到阅读时长独立计数，按北京时间累计当天完成的不同文章，达到每日目标才算完成。刷新、目录变动和重启不清空当天计数，同一篇不重复计数；次日重新累计，已读排除记录继续保留。
- “每日阅读”标题下只显示“今日已完成 X/Y 篇”，X 为当天实际完成篇数（可超过目标），Y 为每日目标；不再显示日期、批次篇数、阅读时长或排除期说明。阅读器内保留计时反馈，异常时仍显示错误信息。
- “刷新推送”立即重新扫描并更换列表，优先选择当前可见列表以外的未读文章，候选不足时允许复用部分旧推荐，但不突破 90 天已读排除期。自动检查只补充失效推荐，不主动打乱保留项。改变篇数时增加则补充、减少则隐藏尾部。
- 每 30 秒及窗口重新获得焦点时检查目录新增、删除、移动和改名；目录暂时不可用时保留列表与历史并重试。已打开的正文不被目录刷新关闭，即使原文件随后删除也可完成阅读。
- 面板内预览复用 Markdown 渲染，移除 YAML 元数据，支持根目录内的本地常见位图；不执行文章脚本。
- 默认累计前台阅读 30 秒后勾选、划线，秒数可设为 1–3600。切换模式、失去焦点、打开设置或隐藏页面时暂停；关闭或重新打开文章会重新计时。
- 已读文章在当前列表中保留，手动刷新后排除；读完时间起 90×24 小时内不进入后续新推荐；候选不足时只展示实际可用文章，不降低任务目标。阅读历史、当天完成记录与推送列表写入 `userData/article-history.json`，通过临时文件替换保存，状态未变不重复写盘；损坏记录报错而不静默覆盖。
- 收藏给被推荐的原文件名前加一次 `⭐`，不改正文，重名报错且不覆盖；阅读 ID 不变。不会改写外部收藏夹同步工具的配置或索引。
- 归档图标通过 `articles-archive` IPC 将文件移入所选根目录的“已归档/原相对路径”，保留收藏星号，重名不覆盖。扫描跳过所有“已归档”目录，历史保存 `archived` 身份集合永久排除相同文章（包括其他目录的重复副本）；不会增加未读完成数，也不减少已完成计数。归档当前文章关闭阅读器并停止计时，列表补齐候选；历史写入失败尝试回滚移动。
- 推荐是桌面功能；普通浏览器显示桌面使用提示。

## 工作流程与验收
修改前给出方案并备份相关文件，保留已有改动；长期约定发生变化时同步本文件。

- 语法检查：`node --check desktop-panel/main.js` 和 `node --check desktop-panel/panel-preload.js`。
- 托盘：`node --test desktop-panel/tray.test.js`，验证关闭/恢复、动画中关闭及快速切换，并在真实 Electron 中检查 PNG 解码和原生菜单图标。
- 发布：`npm test`、`npm run test:ui`、`npm run package:windows`；源码与压缩包均不包含密钥、登录态、个人缓存、日志、测试截图或备份。Node.js 运行时许可证位于 `scripts/licenses/node-LICENSE.txt`；CI 固定 Node 22.17.1 与该许可证版本一致。
- 模型用量：`node --test model-usage.test.js workbuddy-usage.test.js model-usage-ui.test.js`；UI 测试同样支持 `DASHBOARD_TEST_BROWSER`，覆盖跨月/换日、缓存和价格口径、WorkBuddy 登录与积分、缺失/失败状态、三色堆叠、悬停和键盘提示以及窄面板布局。
- 电脑使用：`node --test activity-watch.test.js activity-watch-ui.test.js`，覆盖跨日和时段裁剪、重叠统计及分类时长守恒、父子直接时间、颜色继承、分类集优先级、缓存、原生 AFK/分类查询、日期切换、刷新、分类树展开和百分比、堆叠比例、旭日图/悬停、错误与空态、360px 排版。
- Clash：`node --test clash-status.test.js clash-status-ui.test.js`，验证运行模式与系统代理、缓存和失败清理、强制刷新、真实 HTTP CONNECT 路由，以及状态行/悬停 IP/360px 长位置排版。
- 推荐逻辑：`node --test desktop-panel/articles.test.js`，覆盖默认读完 4 篇才完成任务、跨批次累计、同篇去重计数、换日、刷新换批、目录更新和中断恢复、身份迁移，以及数量调整、收藏幂等、重启、90 天边界、同名保护和损坏记录。
- 界面集成：`node --test desktop-panel/articles-ui.test.js`，使用临时文章与真实 IPC 处理函数，验证图片、暂停计时、自动完成、收藏、设置持久化与原有待办。
- 界面测试需要可用 Playwright Chromium，可用环境变量 `DASHBOARD_TEST_BROWSER` 指定浏览器程序。本机已有浏览器位于 `%LOCALAPPDATA%\ms-playwright\chromium-1124\chrome-win\chrome.exe`。
- 验收：470px 面板无横向溢出；每日推荐可打开、阅读后划线、重启保留；收藏文件只加一个星星；普通网页和目录不可用时有清楚提示。测试使用临时目录，不批量修改真实文章。
