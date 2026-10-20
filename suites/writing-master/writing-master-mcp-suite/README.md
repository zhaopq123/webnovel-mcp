# WritingMaster 写作大师 · MCP 套装

**这是 MCP 套装，给 Claude Desktop / Cursor 等只认 MCP 协议的平台用。不确定装哪个，就去装 Skill 套装（满血版）。**

一句话介绍：本套装把 WritingMaster 的 13 条命令包成 13 个 MCP 工具（`wm_` 开头），让不支持 Skill 机制的平台也能用上建书、章纲门禁、审查门禁、提交台账、断点恢复、体检等硬机制。赛道口径为四大赛道（novel / screenplay / jubensha / toolbook），言情是 novel 下的「言情模式」（调用 `wm_init` 时加可选参数 `genre=romance`）。

- 版本：v2.0.0（2026-10-20，与主包 writing-master v2.0.0 同源同步）；自检状态：655/655 全绿（见 `tests/REPORT.md`，2026-10-20）。
- 环境要求：电脑上装了 Node.js（终端里 `node -v` 能打印版本号就行）。零第三方依赖。
- **提醒**：`skills/` 目录在本套装里用不上，留着无害，可无视（不要删，万一以后换 Skill 套装还能用）。

---

## 一、安装配置（三步走）

**第 1 步：放包。**
把**整个文件夹**放到一个固定位置，后续配置都指向它。下文以 `/path/to/writing-master-mcp-suite` 为例，**替换成你的实际绝对路径**。

**第 2 步：改客户端配置。**
把下面这段 JSON 复制进客户端的 MCP 配置文件，只改路径即可用：

```json
{
  "mcpServers": {
    "writing-master": {
      "command": "node",
      "args": ["/path/to/writing-master-mcp-suite/scripts/mcp-server.mjs"]
    }
  }
}
```

往哪儿贴：

- **Claude Desktop**：设置 → 开发者 → 编辑配置（`claude_desktop_config.json`），把 `"writing-master": {...}` 加进已有的 `mcpServers` 里。
- **Cursor**：设置 → MCP → Add new global MCP server（即 `~/.cursor/mcp.json`），加入同样的结构。
- **Windows 用户**：路径里的反斜杠要双写，如 `"C:\\path\\to\\writing-master-mcp-suite\\scripts\\mcp-server.mjs"`。
- **可选**：想固定作品目录，在 args 末尾追加 `"--root"` 和你的作品目录路径，之后所有工具调用默认在该目录下执行。

**第 3 步：重启客户端。** 去 MCP 工具列表里确认（见下方验证三步）。

---

## 二、启动验证（三步）

1. **看工具列表**：重启客户端后，MCP 工具列表里应看到 **13 个 `wm_` 开头的工具**：wm_init、wm_context、wm_commit、wm_review、wm_status、wm_archive、wm_restore、wm_doctor、wm_outline、wm_query、wm_pacing、wm_memory、wm_verify。
2. **命令行冒烟**（可选，不熟终端的可跳过）：

```bash
# 握手测试：输出里应看到 "writing-master" 和版本号 2.0.0
echo '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}' | node /path/to/writing-master-mcp-suite/scripts/mcp-server.mjs

# 工具清单测试：输出里应看到 wm_init、wm_verify 等工具名
echo '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}' | node /path/to/writing-master-mcp-suite/scripts/mcp-server.mjs
```

3. **实战验证**：在客户端里对 AI 说"用 writing-master 帮我开一本书"，让 AI 调一次 `wm_init`（参数：track=novel、title=书名、target_words=300000；写言情题材再加 `genre=romance`，即 novel「言情模式」），能正常建出作品目录和 `.wm/` 台账，即接入成功。

---

## 三、注意事项（必读）

- **v2.0 赛道口径变更**：`track` 只收四大赛道 `novel|screenplay|jubensha|toolbook`，言情改用 `track=novel + genre=romance`（言情模式）。旧参数 `track=romance` 仍是废弃别名，会自动映射并提示迁移，后续版本将移除。
- **依赖同包引擎，不能单拷文件**：`mcp-server.mjs` 只是个"翻译壳"，真正干活的是包里 `scripts/` 引擎（`wm.js`）。整个文件夹必须保持完整，**不能单拷 mcp-server.mjs 到别处用**。
- **只装 MCP = 七成功力**：13 个 MCP 工具全部可用，防崩设定、防烂尾的硬机制照常生效；但 82 张写作知识切片只给"该读哪几篇"的清单，**不会自动把内容喂给 AI**，方法论吃不到就全看模型自由发挥。
- **补救方案（补满血）**：给平台再加配一个官方 **filesystem 类文件读取 MCP**（Claude Desktop / Cursor 自带的文件系统访问即可），把访问范围指向本包目录——AI 就能自己读 `knowledge/` 和 `templates/`，两条通道一叠加，基本等于满血。
- 工具参数与命令行版本同名同参，用法详见各工具说明；八条基础命令的完整说明在 `skills/writing-master/SKILL.md` 第四节（AI 可自行读取）。
