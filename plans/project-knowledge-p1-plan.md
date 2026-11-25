# Kettu: 项目代码知识库 P1 技术规划

## 背景

会话搜索索引（SearchIndex）只覆盖会话消息文本。Agent 检索项目代码依赖 FilesService 的 `git grep`:每次调用起一个 git 子进程实时扫描全仓库,无持久索引,跨会话不复用,非仓库项目退化为有界遍历(depth 20 / 5000 文件)。

P1 目标:为每个项目建立一个可持久化、可增量更新、跨 Agent 会话复用的源代码全文索引(SQLite FTS5),通过 Kettu 自有 MCP 服务器暴露给所有 Agent。检索结果带文件路径、行号和匹配行内容。首次使用时建立索引,后续按需增量更新。

范围之外(明确不做):Embedding、向量数据库、RAG、Tree-sitter/AST、代码知识图谱、自动上下文注入、前端管理界面、云端知识库、自动会话记忆提取。

## 1. 现有架构分析

调研方式:直读 `src/agent-host/` 下 search、memory、threads、usage、artifacts、files、projects、sessions、host、start 的源码,结论与三个并行探索代理的报告交叉验证一致。

### 1.1 会话搜索索引(P1 蓝本)— `src/agent-host/search/`

- **驱动**: `node:sqlite`(`DatabaseSync`)同步 API,因此全部运行在 worker 线程内,绝不阻塞宿主事件循环(`search/index.ts:1-3`)。
- **存储**: FTS5 外部内容表(`content='message', content_rowid='id'`)加 trigram 分词器;索引列 `folded` 是折叠文本(`foldBulk`:NFD 去重音加小写,定义在 `src/shared/search-fold.ts`),原文 `text` 留在内容表供 snippet 使用。三个触发器(INSERT/DELETE/UPDATE)维持 FTS 与内容表同步(`search/index.ts:42-55`)。
- **FTS5 运行时容错**: `runsTrigram()` 探测当前 Node 是否带 FTS5(22.13 至 22.15 不带);缺失时退回 `instr(folded, ?)` 全表扫描,`meta.fts` 记录降级状态;在无 FTS5 的运行时打开一个带 FTS5 的文件,按损坏处理并重建(`search/index.ts:112-120, 200-202`)。
- **数据库文件**: `<userData>/state/search-1.db`,文件名带格式版本,新格式换文件名。损坏(SQLITE_CORRUPT=11 / NOTADB=26 / 格式不符)时连同 `-wal`/`-shm` 删除重建——索引是派生数据,重建无损失(`search/index.ts:100-103, 172-174`)。
- **PRAGMA**: WAL、`synchronous=NORMAL`、`busy_timeout=5000`;reader 只读打开仅设 busy_timeout(`search/index.ts:159, 194-196`)。
- **增量核心(mark CAS)**: `source` 表记录每个 session 的 `updated_at`,写入时 compare-and-set——mark 只在 session 于 `from` 时刻是最新时才推进到 `to`,漏写的由周期 reconcile 补齐(`search/index.ts:259-281`)。这是崩溃安全的关键设计。
- **Indexer**: 线程写入即时 apply;reconcile 循环(单飞 working/again 标志、newest-first、WINDOW=100 一批、批间 2ms unref 休息)兼作首次构建与修复路径。失败非致命:记录日志 30 秒后重试,损坏时删除重建(`search/indexer.ts`)。
- **查询**: 无 bm25,按 session 更新时间倒序;长词(>= 3 字符)走 FTS MATCH 短语 AND,短词走 instr(`search/index.ts:365-423`);`snippetOf` 手工截取 LEAD=24/SPAN=160,折叠索引映射回原文,不切断代理对(`search/snippet.ts:13-29`)。

### 1.2 Worker Thread 模式(threads/usage 两处现成参考,结构一致)

- 宿主创建点:Electron main 在 `src/agent-host/start.ts:68-71`(`new Worker(message.threadWorkerPath, { workerData })`,路径由 main 用 `?modulePath` 构建并在 `host:init` 传入);daemon 在 `src/daemon/hosts.ts:222-223`(bundle 文件名,构建入口注册于 `vite.daemon.config.mts:48-49`);测试 harness 在 `src/agent-host/testing/harness.ts:450-451`(同线程替身 `inThreadWorker`)。
- worker 入口(`threads/worker.ts`、`usage/worker.ts`): `parentPort.postMessage` 作 reply 回调,`port.on('message')` 分发给 `startXxxService(workerData, reply)` 返回的 handler。
- 协议:请求 `{ id, op, ... }`,回复 `ready / log / result / error`;worker 日志经 `{type:'log', level, message}` 回宿主。
- 宿主 store:单调 id、pending map、崩溃重启(3 次/60 秒窗口)、close 时先 reader 后 writer 各等 2 秒折叠 WAL 再 terminate。
- 新增 worker 需要三处接线:`host:init` 成员(`MainToHost` union 的内联成员,`src/shared/host-control.ts:93-115`;代码库里没有 `HostInitMessage` 这个名字)加路径字段——`threadWorkerPath`/`usageWorkerPath` 同为必填,新字段同样必填,将迫使 main 与 daemon 在同一提交里同步改动;`HostOptions` 加 factory(`src/agent-host/host.ts:352-355`);三处入口(main、daemon、测试 harness)各传 factory。

### 1.3 Kettu 自有 MCP(工具暴露通道)

- **形态**: agent-host 进程内一个 HTTP 服务器(127.0.0.1 随机端口,`/mcp` 路径,StreamableHTTP stateless transport,`enableJsonResponse`),SDK(`@modelcontextprotocol/sdk`)懒加载(`artifacts/service.ts:172-178`)。每个请求新建 `sdk.Server` 加 transport,响应关闭即销毁(`artifacts/service.ts:702-746`)。
- **授权**: 每会话一个 bearer token(`SessionGrant`),OpenCode 按进程-folder 一个(`FolderGrant`,调用在 `_meta` 里带会话名)。token 为 32 字节随机,SHA-256 索引加 timing-safe 比较,并注册为日志秘密(`artifacts/service.ts:265-269, 691-700`)。HTTP 守卫:拒带 Origin 头的请求(浏览器)、校验 Host 头(DNS rebinding)、404/405/401/403。
- **工具注册模式**(以 `src/agent-host/memory/tools.ts` 为最佳模板):模块导出 `XXX_TOOLS: Tool[]`(name/title/description/inputSchema/annotations)加 `isXxxToolName()` 加 `class XxxTools { call(caller, name, input): Promise<CallToolResult> }`。参数校验:白名单拒未知键,再手工逐字段校验;错误以 `isError: true` 的 CallToolResult 返回 `{code, message}`。全库没有 `registerTool`/`server.tool()`,全是静态数组加按名分发。
- **完整注册触点**(本方案实际要动的):
  1. 工具对象入组(`SERVICE_TOOLS` 无条件或 `allTools()` 按开关拼接,`artifacts/service.ts:118-127, 508-518`);
  2. `isXxxToolName` 加 `call(caller, name, input)`;
  3. `callTool()` 加分发分支(`artifacts/service.ts:844-977`);
  4. `TOOL_GROUPS` 加组(`artifacts/service.ts:130-150`,新组需扩展 `McpToolGroup`,定义在 `src/shared/agent-host.ts:730-741`);
  5. `entry()` 的 `autoAllow` 列表(`artifacts/service.ts:285-297`)——**是否加入是安全决策**:免询问工具不得越过 Kettu 自有数据(白名单测试 `artifacts/service.test.ts:36-88` 钉死这一点);search_code 读取项目文件内容,故不加入(见第 5 节触点 4 的裁决);
  6. `src/agent-host/tool-schemas.test.ts` 的 `ALL` 数组(每个数组 schema 必须带 `items`,Gemini 要求);
  7. `ArtifactServiceDeps` 加 deps,`host.ts` 构造时传入。
- **Caller**(`src/agent-host/artifacts/tools.ts:99-106`): `{ sessionId, project, folder?, subagent? }`。worktree 会话的 `folder` 是其 worktree 路径(`artifacts/service.ts:686-689` 的 `withFolder` 替换),`caller.folder ?? caller.project` 即该会话的工作目录(现有用法见 `artifacts/tools.ts:1391`)。注意子代理的调用经 `callerOf` 解析回其父会话(两种 grant 形态都如此),所以子代理拿到的也是父会话的 folder。
- **会话线程的工具行标签**: 每个工具调用在会话线程里显示为 `session:kettuTool` 本地化动词加 `mcp-tools.ts` 的 TARGETS 目标参数(`src/renderer/src/features/session/entries/mcp-tools.ts`),现有全部 97 个工具在 en 与 zh-CN 两份 `session.json` 里都有键、在 TARGETS 里都有条目;未知工具退化为显示裸工具名(运行时 `Object.hasOwn` 检查,typecheck 拦不住)。托盘面板与 island 视图消费同一目录。
- **Marketplace 内置服务器页面**: 分组渲染与组名是另两处硬编码——renderer 的 `GROUPS` 数组(`src/renderer/src/features/marketplace/builtin.tsx:36-48`,11 组)与 `builtin.groups.<id>` 语言键(`src/shared/locales/{en,zh-CN}/marketplace.json`);页头工具总数按 `tools.length` 计,组行只渲染 GROUPS 列出的组。
- **各适配器注入点无需改动**: Claude Code(`claude/connection.ts:372-391`,secret server 经 `query.setMcpServers` 不上命令行)、Codex(`codex/connection.ts:264-341`)、ACP(`acp/connection.ts:368-385`)、OpenCode(`opencode/connection.ts:826-875`)等。工具挂到 kettu 服务器后,所有适配器自动获得。
- **服务器 instructions 与工具可发现性**: `serviceInstructions`(`guide/guide.ts:162-225`)对每个工具组都有一行说明;memory 的真实先例是"无 topic 但 instructions 里有一行"(按 `GuideFlags.memory` 门控,`guide.ts:204-209`),并非完全靠 description——Claude Code 把 MCP 工具押后到搜索之后(这正是少数工具带 `anthropic/alwaysLoad` 的原因,`plan-tool.ts:81-82`),不搜就看不到 description。
- 总开关:settings 的 `mcp.kettu.off`(per-agent,`src/shared/settings-catalog.ts:1025-1042`);会话注入门槛在 `sessions.ts:4032-4042`。

### 1.4 FilesService 不直接复用,原因

- 它是 Files 面板的 IPC 专用 CRUD 服务(`host.ts:3588-3606` 的 `files.*` handlers),从未暴露给 MCP;Agent 读项目文件走自己的 harness。
- `search()` 每次调用起 `git grep -z -n -i -F --untracked` 子进程实时扫描全仓库(10 秒超时),无持久层、无增量概念;非仓库时退化为有界 BFS walk(depth 20 / scanFiles 5000)。
- 各项 limits 为 UI 设计:500 匹配行、1MiB 单文件读上限、5 万文件列表上限;返回的是 UI 形状(`FileContent` 带 media grant)。
- 代码索引需要大批量遍历(远超上述上限)、持久派生数据、worker 内 SQLite 分批加让出——与它的同步 request-response 模型不同。
- **但复用其安全检查模式**: `normalize`(拒 NUL/绝对路径/`..`/Windows 冒号,`files.ts:640-658`)、`resolveInside`(realpath 后按 `pathKey` 前缀包含校验,防符号链接逃逸,`files.ts:758-772`)、`isBinary`(前 8000 字节 NUL 探测,`files.ts:126-128`)、`versionOf`(SHA-256,`files.ts:121`)、`readSource` 的"读 size+1 字节防文件读取中增长"技巧(`artifacts/sources.ts:25-75`)。

### 1.5 项目根解析与 Worktree

- 项目根 canonical 化: `Projects.resolveDirectory`(`projects.ts:95-108`)调用 `canonicalizePath`(resolve 加 realpath 加 Windows `\\?\` 前缀剥离,`paths.ts:38-47`),存于 `state/projects.json`。
- 路径比较统一走 `pathKey`(Windows 小写归一,`paths.ts:54-61`);`isInside` 判断包含关系(`paths.ts:68-74`)。
- open-folder 门禁: `filesCall` = `resolveDirectory` → `assertOpenFolder`(scratch 或会话 worktree 直通,否则必须在 projects.json 注册,`host.ts:3074-3100`)→ `env.ready()` → 执行。MCP 路径的 Caller 已带 project/folder,天然满足。
- 会话工作目录: `workDir(record)` = `record.worktree ? record.worktree.path : record.projectPath`(`sessions.ts:1006-1008`);`sessionFolder(sessionId)` 供工具使用(`sessions.ts:1598-1602`);`worktreeProject(folder)` 把 worktree 路径映射回主项目(`sessions.ts:1572-1581`)。注意 MCP Caller 路径上的 `sessionFolder` **不**检查 `worktree.removed`:worktree 被移除后该路径返回的是已从磁盘删除的死目录(检查 `removed` 的是 `workFolder`,只接给 SessionFiles,`sessions.ts:10903-10910`);外部删除 worktree 时 `removed` 根本不会被置位(启动时的 `checkWorktrees` 只填内存集合)。
- 子代理的 `agentWorktree`: `record.agentWorktree`(`storage.ts:339-340`)记录子代理自建的 worktree,`isSessionWorktree` 把它算作会话 worktree(`sessions.ts:1584-1592`),但 `workDir`/`sessionFolder` 从不返回它,子代理的 MCP 调用又解析回父会话的 folder——所以按 Caller 路由子代理永远拿到父会话的根。
- worktree 记录: `SessionRecord.worktree: { path, branch, base, baseOid, removed? }`(`storage.ts:287-294, 337-340`);WorktreeManager 把 worktree 建在项目旁(`<project>-worktrees`)或 `~/.kettu/worktrees/<name>-<sha256 前 8>`(`worktrees/git.ts:185-207`)。
- 两个现有先例,方向相反: `sessions.folderKey`(`sessions.ts:3878-3891`)按 `worktreeProject(canonical) ?? canonical` 把 worktree 折叠回主项目(项目 MCP 答复、hooks 用此约定);git service 则把 worktree 当作独立 ProjectState。P1 的选择见第 6 节。

### 1.6 数据目录布局与 MemoryService 边界

- `state/`:全部 JSON 状态加三个 worker 拥有的 SQLite(threads.db、search-1.db、usage.db)。
- `memory/`:Markdown 文件树(`global/`、`projects/<basename>-<pathKey 的 sha256 前 12>/`,每目录带 `project.json` 认领,`memory/service.ts:107-116, 286-291`)——唯一的按项目分目录先例。
- MemoryService 是纯 Markdown 加 YAML frontmatter,无 SQLite、无 FTS、不涉及代码;有 undo、秘密拒绝、容量上限。P1 与它零重叠:项目记忆归 MemoryService,代码检索归新服务,存储形态与生命周期完全独立。

## 2. P1 技术架构

新模块 `src/agent-host/knowledge/`:

```text
src/agent-host/knowledge/
├── index.ts        # CodeIndex:SQLite FTS5 索引类(worker 内),模式照 search/index.ts
├── scan.ts         # 扫描器:列文件/比 hash/分批增量(worker 内),模式照 search/indexer.ts
├── service.ts      # worker 内请求处理,模式照 threads/service.ts
├── worker.ts       # worker 入口,模式照 threads/worker.ts
├── protocol.ts     # KnowledgeRequest / KnowledgeReply,模式照 threads/protocol.ts
├── store.ts        # KnowledgeStore:宿主侧 promise 桥接,模式照 threads/store.ts(单 writer 简化)
├── tools.ts        # MCP 工具(search_code),模式照 memory/tools.ts
└── *.test.ts       # index.test / scan.test / tools.test
```

关键决策:

1. **独立 worker、独立 db**。不并入 threads worker(它有 writer/reader 双槽与会话写入依赖,不掺和)。P1 为单 writer worker,worker 惰性启动——无人使用就不起线程。**同步 SQLite 只保证语句级串行,不保证扫描级串行**:扫描是跨批间让出的异步操作(第 4 节步骤 6),`last_scan` 又要到扫描结束才写,并发的 ensure(一个 Agent 一轮并行发多个工具调用、或两个会话共享同一库,都是常见路径)都会通过 30 秒门槛、对同一库重复开扫——两把扫描各按开扫时刻的索引快照算 P-I,同一 path 双份 INSERT 撞 `file_by_path` 唯一索引,晚到者失败。因此每库一个扫描单飞(照 Indexer 的 working/again 标志,`search/indexer.ts:27-31`:扫描进行中时新的 ensure 只置 again,不开第二把),并定 ensure 的返回语义为**立即返回**:门槛不过或已有扫描在飞就直接返回当前 `meta.build` 进度,search 照读已提交状态,由在飞的扫描收敛,后续请求通过 `indexing {done, total}` 看到部分结果。不要用 usage service 的整条排队(查询不排队、扫描排队是对的,但 ensure 排队会让触发首次构建的那个 `search_code` 等上几分钟,违背"构建期间查询不阻塞")。本设计没有重试定时器:失败的扫描由下一次 ensure 兜底重触发。
2. **存储位置**: `<userData>/knowledge/<projectDirName>/code-1.db`。`projectDirName` 复用 MemoryService 的命名法(项目名加 pathKey 的 sha256 前 12 hex,目录内放 `project.json {version, path}` 认领)。不进 `state/`(state 是全局单库目录;knowledge 按项目分库,与 `memory/projects/` 的先例对齐)。索引是派生数据:`meta.format` 校验,损坏删除重建。注意 MemoryService 的生命周期安全不可照搬:它只为 projects.json 里用户注册的项目建目录(`memory/service.ts:193-216`),knowledge 则为每个被搜索过的工作目录建库,含临时 worktree——每个库约为仓库文本的两倍大小,需要清理规则(见第 6 节)。
3. **worker factory 三处接线**: `HostOptions.knowledgeWorker?: KnowledgeWorkerFactory`、`host:init` 消息加 `knowledgeWorkerPath`(注意代码库里没有 `HostInitMessage` 这个名字——`host:init` 是 `MainToHost` union 的内联成员,`src/shared/host-control.ts:93-115`,新字段与 `threadWorkerPath` 同为必填)、main(`?modulePath` 导入)、daemon(`vite.daemon.config.mts` 加构建入口,bundle 名 `knowledge-worker.cjs`)、测试 harness(同线程替身)各传 factory。daemon 与 main 两条运行路径都要接:远程场景同样需要代码检索。
4. **文件枚举在宿主侧跑 git,列表传给 worker**。全代码库没有任何 worker 起子进程(threads/usage 两个 worker 只碰文件系统),git 执行的全部基础设施都在宿主侧且刻意如此:`createExec` 的 env getter 取 `this.env.agentEnv()`(登录 shell 解析出的 PATH,桌面启动时 PATH 很小,`host.ts:590`)、Windows 的 `findWindowsExecutable`/PATHEXT 查找(因为 CreateProcess 会先查工作目录、而工作目录是不可信的仓库,`git/exec.ts:98-109`)、`CHILD_ENV`、超时加进程树击杀、shutdown 的 `killAll`(`host.ts:2980`)。worker 里按裸名 spawn git 在桌面启动的 mac/Linux 上大概率 not-found 且重新引入 Windows 安全洞,workerData 只传路径、store 是请求-回复协议也没有把 env 推给已启动 worker 的通道(env 变更见 `host.ts:1462-1480`)。因此枚举由宿主经现有 `execRunner` 执行(先 `await env.ready()`,同 `filesCall`),命令为 `git ls-files -z --cached --others --exclude-standard` **再减去** `git ls-files -z --deleted`(FilesService.list 的完整做法,`files.ts:204-219`;不减 deleted 会把"已从工作区删除但 index 仍 track"的文件留在索引里,见第 4 节),maxBuffer 取 64MiB(照 `GIT_MAX_BUFFER`,因 20 万级仓库输出可超默认),沿用 CHILD_ENV 与超时;宿主把文件清单放进 ensure 请求发给 worker,worker 只做 stat/读取/hash/写库——纯 fs,与 usage reader 和 search indexer 的 worker 先例一致。git 失败或非仓库时宿主改用 walk 生成列表(跳过 `.git`/`node_modules`,FilesService.walk 同款逻辑但上限放大:文件 20 万、深度 30;walk 仅作非仓库兜底)。
5. **读取与安全**: realpath 后按 `pathKey` 前缀包含校验(防符号链接逃逸,`resolveInside` 同款);二进制探测(前 8000 字节 NUL)跳过;超过 1MiB 跳过(与 FILE_READ_LIMIT 同值);UTF-8 严格解码失败按二进制处理。Caller 的 folder 与 project 在每条真实入口都已是 canonical 路径(创建时经 `resolveDirectory`/`canonicalizePath`,worktree.path 创建即 canonical),无需再规范化。
6. **触发前检查根目录存在**: `sessionFolder` 在 MCP Caller 路径上不退回 projectPath(见 1.5 节),worktree 被移除或外部删除时 Caller 拿到的是磁盘上已不存在的路径。ensure 前先检查根目录,不存在时返回明确错误(照 `readSource` 的 ENOENT 文案,`artifacts/sources.ts:35-46`),不建库、不返回空结果、不靠 30 秒阈值无限重试;也不退回 projectPath——那会索引到错误内容,违反第 6 节"内容跟着目录走"的原则。

## 3. 数据库和索引设计

```sql
-- code-1.db(INDEX_FORMAT = 1,文件名带版本,新格式换名)
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT, WITHOUT ROWID;
-- meta 键:format, fts, root(canonical 根路径), last_scan(上次扫描完成时间)

CREATE TABLE file (
  id      INTEGER PRIMARY KEY,
  path    TEXT NOT NULL,     -- 项目内相对路径,'/' 分隔
  hash    TEXT NOT NULL,     -- 内容 sha256 hex
  size    INTEGER NOT NULL,  -- 字节
  mtime   INTEGER NOT NULL,  -- 毫秒,增量快路径预判用
  text    TEXT NOT NULL,     -- 原文,行号定位与行内容返回用
  folded  TEXT NOT NULL      -- foldBulk 折叠文本,FTS 索引列
) STRICT;
CREATE UNIQUE INDEX file_by_path ON file (path);

CREATE VIRTUAL TABLE file_fts USING fts5(
  folded, content = 'file', content_rowid = 'id', tokenize = 'trigram');
-- 触发器 file_ai / file_ad 照 search/index.ts:45-50;file_au 限定列:
-- AFTER UPDATE OF folded, text ON file(content/hash 变更才重写 FTS),
-- 因为 stat-only 的 UPDATE(size/mtime 写回)不得触发 FTS 删插(见第 4 节步骤 5)
```

- **每文件一 row,不是每行一 row**: 数十万行的仓库按行存储会使行数爆炸;FTS 命中文件后,在 `text` 内定位词出现的行。
- **行号方案**: FTS 给出命中文件集;对每个命中文件读 `text`,逐行检查折叠后的行是否包含全部查询词(词折叠复用 `@shared/search-fold` 的 `queryWords`/`foldBulk`),命中行按 `path:line: 行内容` 返回(行内容截 300 字符,与 FILE_MATCH_CHARS 同值)。单文件命中行上限 10(防大文件刷屏),全结果上限 `limit`(默认 50)加 `capped` 标志。
- **行级过滤在内存中做的理由**: P1 查询语义是"词全出现"(AND),与会话搜索一致;单文件成本 O(行 x 词),有行数上限兜底,不需要行级 FTS。
- **FTS 缺失回退**: `meta.fts='0'` 时对全文件做 instr 扫描(照抄 search 的降级路径)。
- **P1 明确不做**: bm25 排序(按路径排序即可)、正则、symbol 提取、AST。

## 4. 增量更新机制

```text
search_code 调用 → KnowledgeStore.search(folder, query)
  → 宿主:检查根目录存在;超过 30 秒未扫时在宿主侧枚举文件
      (git ls-files --cached --others --exclude-standard 减 --deleted,或 walk;
       经 execRunner,先 env.ready()),文件清单放入 ensure 请求
  → worker {op:'ensure', folder, files}:若 (now - meta.last_scan) > 30 秒 → 增量扫描
      每库一个扫描单飞:扫描在飞时 ensure 只置 again,不开第二把,立即返回当前进度
      1. P = 请求带来的清单里 stat 成功的文件(带 size/mtime);
         stat 失败(ENOENT/ENOTDIR)的路径从 P 剔除,视同删除
      2. SELECT path, hash, size, mtime FROM file → 索引集 I
      3. P - I:读取 → hash → 插入(触发器进 FTS)
      4. I - P:DELETE(触发器清 FTS)——被剔除的 stat 失败路径在此清出
      5. P ∩ I 且 size 或 mtime 变化:重读比 hash。hash 变则 UPDATE 全行
         (触发器重写 FTS);hash 未变也必须把新 size/mtime 写回
         (UPDATE file SET size=?, mtime=? WHERE id=?),否则索引里的 stat 永久过期,
         touch 过的文件每轮都重读;stat-only 的 UPDATE 不触发 FTS(见第 3 节)
      6. 每批 50 文件后让出(sliceRestMs unref 休息,保 worker 响应其他请求)
      7. 写 meta.last_scan;批次进度写 meta(build_done/build_total,照抄 Indexer.setBuild)
  → worker {op:'search', folder, query, limit}
      → FTS MATCH(长词)+ instr(短词/无 FTS)→ 行定位 → 截断返回
```

- **首次构建即增量的全量版**: 同一条代码路径(照抄 Indexer 的 reconcile 兼作首次构建的设计),不做单独的建库模式。
- **构建期间查询不阻塞**: 增量批次各自成事务提交,查询读已提交状态(WAL 下读写不互斥);返回体带 `indexing: {done, total} | null`(与 SearchIndexing 同形状),Agent 知道结果可能不完整。
- **触发**: 纯按需(MCP 工具调用时),无常驻 watcher。P1 不做 fs.watch(跨平台问题多;`git/watch.ts` 里有 Windows recursive watch 的回退先例,留给 P2)。
- **失败非致命**: git 失败退 walk(宿主侧);单文件读取失败跳过并记录日志;损坏(11/26/格式不符)删除重建。索引是派生数据,符合约束"代码索引属于可重建的派生数据"。失败的扫描没有重试定时器,由下一次 ensure 兜底重触发。
- **不需要 mark CAS**: 会话索引的 mark 机制是为了对齐权威存储(threads.db)的写入流;这里没有权威写入流——磁盘本身就是权威,每次 ensure 做全量对账即可(对账只读 stat,开销可接受)。

## 5. MCP 接入方式

一个工具:`search_code`(照 memory/tools.ts 模式新建 knowledge/tools.ts)。

```ts
{
  name: 'search_code',
  title: 'Search the project code',
  description:
    "Searches the text of the files in this session's working directory. Returns " +
    'path:line: the line, up to 50 at a time. The index updates on demand and may lag ' +
    'the latest edits by seconds; grep yourself when you need exact freshness.',
  inputSchema: object(
    {
      query: { type: 'string', minLength: 1, maxLength: 200 },
      glob: { type: 'string', maxLength: 200, description: 'A path prefix to keep' },
      limit: { type: 'integer', minimum: 1, maximum: 200, description: 'Default 50' },
    },
    ['query'],
  ),
  annotations: { readOnlyHint: true, openWorldHint: false },
}
```

改动触点(裁剪到 P1 实际要动的):

1. `knowledge/tools.ts`(新): `KNOWLEDGE_TOOLS` 加 `isKnowledgeToolName` 加 `class KnowledgeTools { call(caller, name, input) }`。deps 只有一个闭包 `search(folder, query, opts): Promise<CodeSearchAnswer>`(宿主注入,内部走 KnowledgeStore)。
2. `artifacts/service.ts`: `ArtifactServiceDeps.knowledge?: KnowledgeToolsDeps`;构造器实例化;`allTools()` 无条件拼入 `KNOWLEDGE_TOOLS`;`callTool()` 加分发分支(memory 同款 try/catch 转 McpError)。
3. `TOOL_GROUPS`: 新增 'code' 组(扩展 `McpToolGroup`,`shared/agent-host.ts:730-741`)。Marketplace 页面分组要真正到达,还需三处硬编码接线:`src/renderer/src/features/marketplace/builtin.tsx` 的 `GROUPS` 数组(加 `{ id: 'code', icon }`),`src/shared/locales/en/marketplace.json` 与 `zh-CN/marketplace.json` 的 `builtin.groups` 各加 `code` 键(en/zh-CN 成对同步,项目惯例)。不做这三处,search_code 会计入页头工具总数却不出现在任何分组行,且 `builtin.groups.code` 是缺失键。不新增 guide topic(memory 工具确实没有 topic),但 memory 的真实先例是"无 topic 但 `serviceInstructions` 有一行"(`guide/guide.ts:204-209`,按 `GuideFlags` 门控)——Claude Code 把 MCP 工具押后到搜索之后,不搜就看不到 description。因此需显式决定:`serviceInstructions` 加一行 'code' 组的说明(样式照 memory 行,不带 topic 指针),或加 `anthropic/alwaysLoad`;二者都不做则它是全库第一个既无 instructions 行也无 alwaysLoad 的工具组,在 Claude Code 下大概率不被发现。
4. `entry()` 的 autoAllow: **不加入 search_code**。`service.ts:278-284` 的边界注释明写 "…the browser, computer use, devices, running and typing in terminals and artifacts still ask"——artifact 工具正是经 `readSource` 读会话工作目录文件的那类工具,它们的先例就是询问;免询问清单里越过 Kettu 自有数据的工具要么只返回元数据,要么被 Kettu 卡片拦住(`service.test.ts:35`:"Allowed tools run without asking the user, so none may reach past Kettu's own data")。search_code 返回项目文件内容、无任何用户门禁,加入即需重写这条安全不变量——P1 不动它:不进 autoAllow,agent 的 harness 首次使用时询问一次(同 read_artifact 的待遇),`service.test.ts` 的白名单测试与 entry() 注释**零改动**。代价是一次授权提示,换来安全边界不动;若日后摩擦确实疼,再显式重定义边界并把注释、测试名称与理由一起改,那是独立的有意决策。
5. 会话线程的工具行标签: `src/shared/locales/en/session.json` 与 `zh-CN/session.json` 的 `kettuTool` 块各加 `search_code` 键(两语言成对),`src/renderer/src/features/session/entries/mcp-tools.ts` 的 `TARGETS` 加 `search_code: ['query']`。不加不挂任何门禁(运行时 `Object.hasOwn` 检查),但线程行、托盘面板与 island 视图都会显示裸工具名——现有全部 97 个工具两处齐备,新工具应对齐。
6. `src/agent-host/tool-schemas.test.ts` 的 `ALL` 数组加入。
7. `host.ts`: 构造 KnowledgeStore 并注入 `deps.knowledge`;`shutdown()` 的 flush Promise.all 加 `this.knowledge?.close()`。
8. `src/shared/`: `CodeMatch`/`CodeSearchAnswer` 类型。
9. worktree 路由: `caller.folder ?? caller.project` 传入 KnowledgeStore;宿主侧先检查该根目录存在(见第 2 节决策 6),不存在返回明确错误。注意 Caller.project 恒为 string(scratch 会话拿到的是其 scratch 目录),**没有"无 project"的可报错分支**——scratch 会话照常按其 scratch 目录建索引、返回结果;与 memory 的区别是 memory 的 `projectOf` 用 `projects.find` 把 scratch 映射为 null 才抛 NO_PROJECT,知识库的路由刻意不这样做(工具描述承诺搜会话工作目录)。
10. gateway(agy 工具预算): 不加 CORE_TOOLS(非必需),经 `call_kettu_tool` 可达。

不新增 settings 开关:P1 常开,`mcp.kettu.off` 的 per-agent 总闸已覆盖。

## 6. Worktree 隔离方案

**隔离键 = `pathKey(caller.folder ?? caller.project)`,即会话的实际工作目录。**

- 不采用 `sessions.folderKey` 的"worktree 折叠回主项目"约定,理由:代码索引的内容就是工作目录里的文件本身,worktree 与主 checkout 在不同分支上内容可能相差很远,折叠会让 worktree 会话搜到主 checkout 的过期内容——**内容必须跟着目录走**。git service 的先例(worktree 是独立 ProjectState)支持此选择。
- **隔离键是调用所解析到的会话的目录**,不是"任何会话的实际工作目录":子代理的 MCP 调用解析回父会话(`callerOf` 两种 grant 形态都如此),拿到的是父会话的 worktree 或 projectPath;`workDir`/`sessionFolder` 从不返回 `record.agentWorktree`(`sessions.ts:1006-1008, 1598-1602`)。所以自建 worktree 的子代理搜的是父会话根的索引——git ls-files 把嵌套 worktree 列为单个目录条目(被 gitignore 时整个排除),其文件不在索引里,子代理拿到的是主 checkout 同相对路径的内容,正是本节要避免的过期内容。P1 接受此限制并写明;修复需要 Caller 路由感知 agentWorktree(且其路径通常要到子代理结束才在工具结果里报出来),留给 P2。
- db 目录 = `<userData>/knowledge/<basename>-<sha256(pathKey) 前 12>/code-1.db`;目录内 `project.json {version: 1, path}` 认领(命名法照 MemoryService),文件系统里可人工辨认属于哪个项目。注意 MemoryService 的生命周期安全不可照搬:它只为用户注册的项目建目录,knowledge 为每个被搜索过的工作目录建库,每个库约为仓库文本两倍大——**需要清理规则**:宿主启动时(或 removeWorktree 时)扫 `<userData>/knowledge/`,`project.json` 里认领的根已不存在于磁盘的目录整个删除(索引是派生数据);不做这条,每个临时 worktree 都会留下一个孤儿全库。
- 同一目录的多个会话共享一个索引(两个会话搜同一份代码,这是特性不是问题)。
- **单 worker 多库**: 一个 knowledge worker,内部 `Map<pathKey, {db, lastUse}>` 按请求路由,LRU 上限 3 个打开的库。驱逐关库是 worker 内的同步 `db.close()`——单连接关闭时 SQLite 自行折叠 WAL,不需要超时;ThreadStore 的 2 秒竞速只适用于宿主侧 `KnowledgeStore.close()` 的跨线程消息(发 close、限时、terminate)。批间让出使其他库的请求可与在途扫描交叠:**有在途扫描的库免于 LRU 驱逐**(否则 4 个以上并发活动目录时,扫描在途的库 lastUse 停在开扫那次请求,恰是最久未用候选,下一批会写进已关闭的 db)。worker 的 close op 先停扫描再关库(次序照 `threads/service.ts:146-149` 与 `usage/service.ts:197-203` 的先 abort 后 close)。宿主侧 KnowledgeStore 是薄桥接。
- **死根目录**: `sessionFolder` 在 MCP Caller 路径上不退回 projectPath——检查 `worktree.removed` 的是 `workFolder`(只接给 SessionFiles,`sessions.ts:10903-10910`),而 Caller 路径(`withFolder` ← `sessionFolder` ← `workDir`)返回 `record.worktree.path` 无论 removed(`sessions.ts:1002-1008`,注释明言 "A worktree that was removed or did not read is never swapped for the project's folder");外部删除的 worktree 连 removed 都不置位。缓解事实:Kettu 自删的 worktree 先撤销受影响会话的 MCP token,恢复路径 `cwdOf` 会重建 worktree 并清除 removed;但会话存活期间外部删除与 `checkRewind` 后台置 'branch' 两个窗口仍会把死路径传给 caller.folder。因此 ensure 前由宿主检查根目录存在(第 2 节决策 6),给可读的报错。

## 7. 文件修改清单

新增 `src/agent-host/knowledge/`:index.ts、scan.ts、service.ts、worker.ts、protocol.ts、store.ts、tools.ts、index.test.ts、scan.test.ts、tools.test.ts,外加 `src/agent-host/testing/knowledge-worker.ts` 测试替身。

修改(13 处):

| 文件                                                                          | 改动                                                                                                                           |
| ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `src/agent-host/host.ts`                                                      | HostOptions.knowledgeWorker;构造 KnowledgeStore;artifactService 的 deps.knowledge;shutdown 加 close;knowledge 目录的启动清理扫 |
| `src/agent-host/start.ts`                                                     | knowledgeWorker factory                                                                                                        |
| `src/shared/host-control.ts`                                                  | `host:init` 成员(MainToHost union 内联)加 knowledgeWorkerPath,必填                                                             |
| `src/main/agent-host.ts`                                                      | `?modulePath` 导入加传参                                                                                                       |
| `src/daemon/hosts.ts` 与 `vite.daemon.config.mts`                             | bundle 名加构建入口                                                                                                            |
| `src/agent-host/testing/harness.ts`                                           | TestHostOptions.knowledgeWorker 可选注入(照 harness.ts:314 threadWorker 写法)加 startTestHost 传 factory                       |
| `src/agent-host/artifacts/service.ts`                                         | deps、allTools、callTool、TOOL_GROUPS(autoAllow 不动,见第 5 节触点 4)                                                          |
| `src/agent-host/tool-schemas.test.ts`                                         | ALL 数组                                                                                                                       |
| `src/agent-host/guide/guide.ts`                                               | serviceInstructions 加 'code' 组一行(样式照 memory 行)                                                                         |
| `src/shared/agent-host.ts`                                                    | McpToolGroup 加 'code';CodeMatch/CodeSearchAnswer 类型                                                                         |
| `src/renderer/src/features/marketplace/builtin.tsx`                           | GROUPS 数组加 `{ id: 'code', icon }`                                                                                           |
| `src/shared/locales/{en,zh-CN}/marketplace.json` 与 `{en,zh-CN}/session.json` | marketplace 的 builtin.groups 加 code 键;session 的 kettuTool 加 search_code 键(两语言成对)                                    |
| `src/renderer/src/features/session/entries/mcp-tools.ts`                      | TARGETS 加 `search_code: ['query']`                                                                                            |

不动:search/(模式参考,允许少量结构性重复,两处各自演进,注释注明同源)、memory/、files.ts、threads/、全部适配器 connection 文件。

不引入新依赖(node:sqlite、node:worker_threads、node:crypto 均为现有标准库)。

## 8. 必要测试与验收标准

按 AGENTS.md 测试纪律:只测核心(存储数据、MCP 工具边界),bug 修复从失败测试开始;UI、文案、接线不加测试。任务拆分保持简洁,避免过多测试门禁。

新增测试:

1. `knowledge/index.test.ts`(照 search/index.test.ts 模式):
   - `describe.each([{fts: true}, {fts: false}])` 两种模式;
   - 建库、重开持久化、损坏重建(垃圾文件、异种 sqlite、错误 format);
   - 折叠匹配(大小写、重音、CJK);
   - 行号定位与行内容截断(含超长行、代理对);
   - 单文件行上限、总 limit 与 capped 标志。
2. `knowledge/scan.test.ts`(照 search/indexer.test.ts 模式):
   - 全量构建;改动单文件只重读该文件(mtime/size 快路径加 hash 慢路径);
   - **touch 不改内容后再扫,只重读一次,之后不再重读**(hash 未变时 stat 写回);
   - 删除文件清索引(以不 stage 删除的方式删文件,才测得到 git 路径上 stat 失败视同删除的剔除)、新增文件入索引;
   - 符号链接逃逸拒绝(相对路径出根、绝对路径在外、symlink 指向根外);
   - 二进制、超大文件、非 UTF-8 跳过;
   - 批间让出(onIdle 钩子,照抄 IndexerOptions);
   - 并发 ensure:扫描在飞时第二个 ensure 立即返回进度、不开第二把(单飞);
   - 根目录不存在的 ensure 返回明确错误、不建库。
3. `knowledge/tools.test.ts`(照 memory/tools.test.ts 模式):
   - 参数校验(未知键拒绝、query 类型与长度、glob 前缀过滤、limit 边界);
   - scratch 会话按其 scratch 目录照常索引返回;caller.folder 的 worktree 路由隔离;
   - indexing 部分结果标志。
4. 既有测试同步: `tool-schemas.test.ts` ALL 数组(autoAllow 白名单测试零改动:search_code 不进 autoAllow,见第 5 节触点 4)。

验收标准:

- 门禁全绿: `pnpm format:check`、`pnpm lint`、`pnpm typecheck`、`pnpm test` 全过;因动到 main 进程与构建配置,另跑 `pnpm build`。
- 人工验收(`pnpm dev`,fake-agent 或 Claude Code):会话内调用 `search_code` 得到 path/行号/行内容(首次使用 agent 的 harness 会先请求一次授权,同 read_artifact);修改一个文件后再查,日志显示只重读该文件;两个 worktree 各自隔离(一方改文件另一方查不到);scratch 会话照常返回其目录的结果;移除一个 worktree 后其会话调用 `search_code` 得到根目录不存在的报错而非空结果。

## 实施顺序(4 个提交,每个独立可验证)

1. **PR 1(核心,纯 worker 内)**: knowledge/ 的 index、scan、service、worker、protocol 加 index.test、scan.test。无宿主接线,测试直接驱动 `startKnowledgeService`(照 search 测试直驱模式)。验证: `pnpm test src/agent-host/knowledge`。
2. **PR 2(接线)**: store 加 host/start/main/daemon/harness 接线加 testing/knowledge-worker.ts。验证: typecheck 加既有测试不回归(此时尚无调用方)。
3. **PR 3(MCP 工具)**: tools 加 artifacts/service 挂载加类型加既有测试同步。验证: tools.test 加 `pnpm dev` 人工验收(autoAllow 白名单不动)。
4. **PR 4(文档)**: README 与 ROADMAP 中英文对同步提及(若产品层面需要)。

依赖关系:PR1 到 PR4 严格线性(PR2 无 PR1 无法编译,PR3 无 PR2 无 store 可挂)。

## 主要风险

1. **行号定位成本**(中): 大文件 O(行 x 词) 的内存过滤。缓解: 单文件命中行上限 10、超过 1MiB 的文件不入索引。
2. **首次全量扫描时长**(中高): 数万文件的仓库分钟级(git ls-files 快,读取、hash、插库慢)。缓解: 批间让出保 worker 响应、进度与部分结果可见;P1 接受,工具描述写明首次慢。
3. **单 worker 多库的句柄管理**(中): 批间让出使驱逐可与在途扫描交叠;有在途扫描的库免于 LRU 驱逐,worker 的 close 先停扫描再关库;宿主侧 close 用 2 秒竞速加 terminate(驱逐关库是同步调用,不需要)。P1 以单项目场景为主。
4. **索引滞后语义**(低): 30 秒阈值内的编辑搜不到。缓解: 工具描述明说,需要精确新鲜度的场景 Agent 自用 grep。
5. **node:sqlite FTS5 缺失的运行时**(低): 照抄 search 的降级路径,该模式已有测试覆盖。
6. **与 search/index.ts 的结构性重复**(低): 接受。抽公共基类是为未来过度设计;两处各自演进,注释注明同源。
7. **子代理的 agentWorktree 不被路由**(低,P1 接受): 子代理搜父会话根的索引,自建 worktree 的文件不在其中(见第 6 节);P2 在 Caller 路由上感知 agentWorktree。
8. **磁盘占用与孤儿库**(中): 每个被搜索过的工作目录一个全库,临时 worktree 频繁创建删除会留下孤儿;缓解: 启动清理扫认领根已不存在的 knowledge 目录(第 6 节)。
