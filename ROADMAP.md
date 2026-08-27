# AICommit Roadmap

> 规划周期：2026-08-24 ～ 2027-02-28
> 规划依据：当前工作区代码、README、测试、打包结果与未提交的安全增强；不假设尚未实现的云端服务或团队后台。

## 1. 产品定位

AICommit 的下一阶段目标不是扩展成通用 Git 助手，而是成为一个**安全、可控、兼容多模型的本地 commit 工作流工具**：

- 用尽量少的上下文生成符合仓库规范的 commit message；
- 在自动暂存、拆分和提交时不破坏用户的 Git 状态；
- 在把代码发送给模型之前明确控制隐私、成本和 provider 行为；
- 同时服务交互式个人工作流与可审计的脚本/CI 工作流。

北极星指标：**有效提交率**——成功生成、经用户或策略确认并最终创建的 commit，占生成尝试的比例。

护栏指标：

- 敏感内容未经明确授权发送：0；
- 工具导致用户原有暂存状态丢失：0；
- 官方支持环境中的关键流程成功率：≥ 99%；
- 首次安装到完成首次 commit：≤ 5 分钟；
- 非交互模式输出必须可机器解析、失败必须非零退出。

## 2. 当前能力基线（路线图启动时）

截至 2026-08-24、路线图开始执行前，系统已经具备可用的核心闭环：

| 领域        | 已有能力                                                                                     | 当前边界                                                             |
| ----------- | -------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| Commit 生成 | 读取 staged diff，生成 Conventional Commit，支持中英文、编辑、重写与失败重试                 | 类型和格式规则基本写死；缺少仓库历史与团队规范感知                   |
| Git 工作流  | 交互式暂存全部/部分文件，检测并发 index 变化，失败时恢复工具拥有的 staging                   | 主流程分支较多，端到端覆盖仍薄弱                                     |
| 拆分提交    | 按文件生成多个逻辑 commit，可审核、编辑计划、批量重写消息                                    | 仅支持文件级拆分；中途失败后需要手工完成剩余 commit                  |
| 自动化      | `--dry-run`、`--yes`、目标目录、连通性检查与 debug 输出                                      | 终端输出面向人，不适合稳定的脚本消费                                 |
| Provider    | OpenAI-compatible endpoint、多 provider 配置、OpenAI/OpenRouter/DeepSeek/MiniMax 推理适配    | provider 规则集中在请求层，新增协议或模型容易增加条件分支            |
| 成本控制    | diff 总量/单文件截断、锁文件和生成物剥离、重写时默认不重发 diff、token 展示                  | 没有跨运行的本地统计和质量/成本基线                                  |
| 安全        | 不可信项目配置过滤、HTTPS 限制、API key 环境变量、敏感 diff 保护、终端控制字符清理、状态指纹 | setup 仍可保存明文 key；项目 prompt 与模型输入的信任边界需要继续收紧 |
| 工程质量    | 130 个测试全部通过，依赖审计无已知漏洞，npm tarball 可正常生成                               | 总行覆盖率 68.51%；没有 CI、跨 OS/Node 矩阵、发布流程和覆盖率门禁    |

这意味着当前产品已经越过 MVP 阶段。未来六个月的优先顺序应是：**发布可信度 → 兼容性与可观测性 → 生成质量 → 拆分安全 → 分发与扩展**。

## 3. 版本路线

实施进度（2026-08-24）：

| 版本   | 状态      | 结果摘要                                                                                |
| ------ | --------- | --------------------------------------------------------------------------------------- |
| v1.0.x | ✅ 已完成 | 发布文件、跨平台 CI、质量门禁、打包 smoke、安全补丁与发布文档已落地                     |
| v1.1   | ✅ 已完成 | Provider 契约、重试、机器输出、稳定退出码、doctor、凭据助手与最小化本地指标已分阶段落地 |
| v1.2   | ✅ 已完成 | 版本化策略、受控仓库上下文、不可信数据边界、本地 eval 与质量趋势统计已分阶段落地        |
| v1.3   | ✅ 已完成 | 显式 split 边界、计划工件、严格预检、checkpoint/resume、hunk 实验模式与故障矩阵已落地   |
| v1.4   | ✅ 已完成 | 配置与 completion、团队 policy、独立 preset、隔离扩展、npm 分发及双语采用文档已落地     |

### v1.0.x：可发布基线（2026-08-24 ～ 2026-09-13）

状态：✅ 已于 2026-08-24 提前完成；功能、CI 配置、覆盖率门禁、依赖审计与安装包 smoke 均已验证。

目标：把当前“本地可用”状态变成可重复构建、可验证、可维护的正式发行版。本阶段冻结新功能。

交付：

- 合入并回归当前 split 模式的未跟踪文件脱敏、符号链接隔离和 `split run --scope=all --yes` fail-closed 增强；
- 建立 Linux/macOS/Windows × Node 18/20/22/24 CI 矩阵；
- 增加 lint、格式检查、测试覆盖率报告和最低门禁，首个行覆盖率门槛设为 70%；
- 为 `main.js`、`setup.js`、`ui.js` 增加关键路径 smoke/integration tests；
- 增加 tarball 安装测试：`npm pack` → 全局/临时安装 → `--help`、`--version`、stub provider dry-run；
- 补齐 `repository`、`bugs`、`homepage`、发布文件清单、CHANGELOG、SECURITY 和 CONTRIBUTING；
- 定义 SemVer、release checklist、tag/release notes 与 npm provenance 流程；
- 文档明确数据会发送到哪里、哪些内容会被过滤、split 的文件级限制和失败恢复方式。

退出门槛：

- 所有支持环境 CI 全绿；
- 130 个现有测试无回归，新增发布与关键交互测试通过；
- `npm audit --omit=dev` 无 high/critical 漏洞；
- 从干净环境按 README 可在 5 分钟内完成首次 dry-run。

### v1.1：Provider 可靠性与机器接口（2026-09-14 ～ 2026-10-18）

状态：✅ 已于 2026-08-24 提前完成；六类 provider fixture 全部通过契约解析，JSON schema/标准输出、错误退出码及 env/helper/keyless 凭据路径均有自动化测试。

目标：降低 provider 差异带来的维护成本，并让 AICommit 能安全进入脚本和 CI。

交付：

- 把请求层拆为“统一生成契约 + provider capability adapter”，能力至少覆盖 streaming、reasoning、token budget、usage 和 finish reason；
- 建立 OpenAI、OpenRouter、DeepSeek、MiniMax、Ollama/自定义兼容端点的 fixture/contract test 矩阵；
- 对 429、可恢复的 5xx 和网络中断加入有上限、尊重 `Retry-After` 的退避重试；认证、参数与内容安全错误不自动重试；
- 为错误建立稳定分类和退出码：配置、Git 状态、网络、provider、响应格式、敏感信息、并发修改；
- 新增 `--output=text|json`，JSON schema 包含 message/plan、provider、model、latency、usage、warnings 和 exit reason，不输出 reasoning 或 diff；
- 新增 `aicommit doctor`，检查 Node/Git、配置来源、endpoint 安全性、provider 能力与连通性，所有凭据保持脱敏；
- 支持 OS keychain/credential helper，环境变量仍为无状态环境的首选方式；
- 将运行指标设计为本地、最小化、默认不上传：只记录延迟、token、结果类型、是否编辑/重写，不记录 diff、reasoning、commit message 或文件名。

退出门槛：

- provider contract suite 的有效响应解析成功率 ≥ 99.5%；
- JSON 输出通过 schema 校验，stdout 无装饰字符，诊断信息进入 stderr；
- 同一失败在交互和非交互模式下具有一致错误分类与退出码；
- keychain、env key 和 keyless localhost 三种凭据路径均有测试。

### v1.2：仓库规范感知与生成质量（2026-10-19 ～ 2026-11-29）

状态：✅ 已于 2026-08-24 提前完成工程交付；本地 eval 合规率为 100%，上下文预算和项目配置安全边界均有自动化测试。真实使用的 20% 改善门槛由 `aicommit stats` 在累计至少 10 次成功运行后持续评估，不以合成数据代替真实基线。

目标：让“第一次生成即可采用”的比例可测量、可提升，同时保持上下文最小化。

交付：

- 新增版本化 `commitPolicy`：允许配置 types、scope 规则、subject 长度、body、breaking change 与语言；
- 在明确预算内读取最近 commit 风格、目录/包边界和受信任的规范文件；发送前展示上下文摘要，并允许关闭；
- 自动识别 commitlint/Conventional Commit 约束，但仓库规则不能改变 endpoint、凭据或提高发送预算；
- 将仓库拥有的自定义 prompt 改为显式 opt-in，默认采用结构化 policy，避免克隆仓库后静默改变模型指令；
- 对 diff、文件内容和仓库规范使用明确的“不可信数据”边界，补充 prompt-injection 回归语料；
- 建立匿名化本地 eval 集：单一变更、混合变更、重命名、生成文件、超长 diff、中英文和弱模型异常输出；
- 增加候选质量校验：格式、长度、与 diff 的关键词/文件范围一致性；校验失败只做一次低成本纠正；
- 提供 `aicommit stats` 查看本地接受、编辑、重写、失败、延迟和 token 趋势，并支持完全关闭/清空。

退出门槛：

- eval 集上的格式合规率 ≥ 99%；
- 建立真实使用基线后，“生成后需编辑或重写率”相对下降 ≥ 20%；
- 新增上下文不突破配置预算，且每一类上下文都能被用户禁用；
- 项目配置的信任边界拥有专门安全测试。

### v1.3：可恢复的拆分提交（2026-11-30 ～ 2027-01-17）

状态：✅ 已于 2026-08-24 提前完成；split 的 staged/all 边界、plan/apply 工件、事务 checkpoint、resume、默认关闭的 hunk 模式及跨故障场景 E2E 矩阵均有自动化测试。

目标：让 split 从“方便的批量操作”升级为可审计、可中断、可恢复的 Git 事务。

交付：

- 支持 `split run --scope=staged|all`，让用户明确选择是否越过当前 index 边界；
- 把计划与执行拆成两阶段：计划可导出/导入 JSON，apply 前重新校验工作区指纹；
- 在执行前检查空组、重复路径、重命名两端、submodule、冲突状态、hooks 和 unborn branch；
- 每完成一个 group 写入不含代码内容的本地 checkpoint，支持 `aicommit split resume`；
- hook 或 Git 失败时准确报告已完成、待完成与工作区状态，禁止静默重排或重复提交；
- 实验性支持同文件 hunk 拆分：使用临时 index/patch 校验，不修改工作树；默认关闭；
- 对 crash、Ctrl+C、并发编辑、rename、删除、二进制、submodule、hook failure 建立端到端故障注入测试。

退出门槛：

- 执行第一个 group 之前失败时创建 0 个 commit，index 与进入前一致；
- 任一 group 后失败时可通过 checkpoint 恢复，且不会重复或遗漏已提交内容；
- hunk 模式无法无损应用时必须 fail closed 并退回文件级计划；
- split 关键路径在支持平台上通过同一套故障注入测试。

### v1.4：分发、团队采用与轻量扩展（2027-01-18 ～ 2027-02-28）

状态：✅ 已于 2026-08-24 提前完成；npm 安装带有自动 smoke，版本 tag 与 npm provenance 形成发布链路，团队 policy 本地/CI 结果一致，preset 与三类无凭据扩展接口具备兼容和回滚边界。

目标：降低安装和团队推广成本，在不膨胀核心的前提下开放扩展点。

交付：

- 提供版本化 GitHub Release、npm provenance、npm 安装与升级说明；
- 增加 Bash/Zsh/Fish completion 和 `aicommit config show|validate|path`；
- 提供可提交到仓库的安全 policy 模板，以及团队迁移/示例文档；
- 将 provider preset 与核心请求逻辑解耦，preset 可独立更新并带版本与兼容性声明；
- 定义最小扩展接口：context provider、message validator、provider adapter；第三方扩展默认无凭据读取权限；
- 补充中英文文档、故障排查矩阵、隐私模型和 provider 兼容表。

退出门槛：

- npm 安装路径有自动 smoke test；
- 新增 provider 不需要修改核心 Git/交互流程；
- 团队 policy 在本地和 CI 产生一致的校验结果；
- 发布、回滚和 preset 兼容性流程都有可执行文档。

## 4. 优先级与依赖

| 优先级 | 工作项                                              | 依赖                   |
| ------ | --------------------------------------------------- | ---------------------- |
| P0     | 当前安全补丁、跨平台 CI、发布门禁、关键流程集成测试 | 无，立即执行           |
| P0     | Provider capability adapter 与 contract tests       | v1.0.x 发布基线        |
| P1     | JSON 输出、稳定退出码、doctor、本地指标             | 错误分类与 adapter     |
| P1     | commitPolicy、受控仓库上下文、prompt-injection 防护 | JSON schema 与指标基线 |
| P1     | split 计划/apply 分离、checkpoint 与 resume         | Git 故障注入测试       |
| P1     | OS keychain/credential helper                       | 稳定配置与凭据抽象     |
| P2     | shell completion、npm 分发文档                      | 稳定配置与发布流程     |
| P2     | 实验性 hunk 拆分、第三方扩展接口                    | split 事务与权限模型   |

关键依赖链：

`发布门禁 → provider 抽象 → 机器接口/指标 → 质量策略 → split 事务 → 扩展生态`

## 5. 六个月内明确不做

- 不默认上传遥测、diff、文件名、reasoning 或 commit message；
- 不自动 push、不创建 PR、不改写远端历史；
- 不在 split 事务成熟前默认开启 hunk 自动拆分；
- 不先做 GUI/IDE 插件，除非 CLI 指标证明存在明确瓶颈；
- 不在核心中硬编码易过期的模型价格或完整模型清单；
- 不把 changelog、PR 描述、代码审查等相邻场景塞进主 commit 命令。

## 6. Roadmap 复盘机制

每个版本开始前只锁定一个主结果，版本结束时按以下顺序复盘：

1. 安全护栏是否有回归；
2. Git 状态是否可恢复；
3. 有效提交率、编辑/重写率是否改善；
4. provider 成功率、P50/P95 延迟与 token 是否改善；
5. 新能力是否增加了配置和维护复杂度。

若没有真实使用基线，v1.2 之后的百分比目标应先由本地 opt-in 指标校准，再决定是否进入 v1.3；日期可以调整，退出门槛不应取消。
