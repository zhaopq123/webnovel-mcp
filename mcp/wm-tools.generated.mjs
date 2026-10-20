/**
 * 自动生成，请勿手改：`node scripts/gen-wm-tools.mjs`
 * 来源：suites/writing-master/writing-master-mcp-suite/scripts/mcp-server.mjs（唯一的 schema 事实源）
 * 门禁：test/wm-bridge.test.mjs 会重新拉一次上游清单与本文件逐字段比对，漂移即红。
 */

/** WritingMaster 的 13 个工具（wm_*），由上游 mcp-server.mjs 生成。 */
export const WM_TOOLS = [
  {
    name: "wm_init",
    description: "初始化作品项目（创建 .wm/ 账本）。track 四大赛道：novel 长篇小说 / screenplay 剧本 / jubensha 剧本杀 / toolbook 工具书；novel 下可选 genre=romance 开启言情模式（v8.1 引擎，恋爱为绝对主线的题材用）",
    inputSchema: {
      "type": "object",
      "required": [
        "track",
        "title",
        "target_words"
      ],
      "properties": {
        "track": {
          "type": "string",
          "enum": [
            "novel",
            "screenplay",
            "jubensha",
            "toolbook"
          ]
        },
        "genre": {
          "type": "string",
          "enum": [
            "general",
            "romance"
          ],
          "description": "仅 novel 支持；romance=言情模式"
        },
        "title": {
          "type": "string"
        },
        "target_words": {
          "type": "number",
          "minimum": 1
        },
        "mode": {
          "type": "string",
          "enum": [
            "auto",
            "collab"
          ]
        },
        "dir": {
          "type": "string"
        },
        "no_outline_gate": {
          "type": "boolean",
          "description": "开关（无值参数）"
        }
      }
    },
  },
  {
    name: "wm_context",
    description: "动笔前上下文装配。含章纲门禁（outline_gate 启用时无章纲将 BLOCKER 拦截）、写作记忆自动注入、本章章纲展示、状态尾锚点 [state]",
    inputSchema: {
      "type": "object",
      "properties": {
        "dir": {
          "type": "string"
        },
        "task": {
          "type": "string",
          "enum": [
            "plan",
            "write",
            "review",
            "report"
          ]
        },
        "chapter": {
          "type": "number",
          "minimum": 1
        },
        "budget": {
          "type": "number",
          "minimum": 200
        }
      }
    },
  },
  {
    name: "wm_commit",
    description: "事实增量提交（名词锁校验 + 三线 strand 标记）。更新 JSON 支持 names/characters/foreshadow/timeline/suspense/info_gap/plotlines/summary/words_count",
    inputSchema: {
      "type": "object",
      "required": [
        "file"
      ],
      "properties": {
        "dir": {
          "type": "string"
        },
        "file": {
          "type": "string"
        }
      }
    },
  },
  {
    name: "wm_review",
    description: "稿件机械审查门禁：AI味黑名单/英繁混排/标点/句长/专名笔误/引号专名/伏笔超期/钩子承接。红级打回 exit≠0",
    inputSchema: {
      "type": "object",
      "required": [
        "file"
      ],
      "properties": {
        "dir": {
          "type": "string"
        },
        "file": {
          "type": "string"
        },
        "chapter": {
          "type": "number"
        }
      }
    },
  },
  {
    name: "wm_status",
    description: "进度面板：字数进度条 + 台账健康红绿灯",
    inputSchema: {
      "type": "object",
      "properties": {
        "dir": {
          "type": "string"
        }
      }
    },
  },
  {
    name: "wm_archive",
    description: "部归档：压缩活跃区台账/摘要至 .wm/archive/part-N/，开启新部",
    inputSchema: {
      "type": "object",
      "required": [
        "part"
      ],
      "properties": {
        "dir": {
          "type": "string"
        },
        "part": {
          "type": "number",
          "minimum": 1
        }
      }
    },
  },
  {
    name: "wm_restore",
    description: "断点恢复包：新会话开工前重建上下文",
    inputSchema: {
      "type": "object",
      "properties": {
        "dir": {
          "type": "string"
        }
      }
    },
  },
  {
    name: "wm_doctor",
    description: "账本体检 D01-D08（结构/JSON/引用/伏笔/部链/流水一致性）",
    inputSchema: {
      "type": "object",
      "properties": {
        "dir": {
          "type": "string"
        }
      }
    },
  },
  {
    name: "wm_outline",
    description: "四级大纲管理（master 总纲/part 部纲/volume 卷纲/chapter 章纲）+ 无章纲不动笔门禁开关（--enable/--disable）。context --task write 前须先存章纲",
    inputSchema: {
      "type": "object",
      "properties": {
        "dir": {
          "type": "string"
        },
        "save": {
          "type": "string",
          "enum": [
            "master",
            "part",
            "volume",
            "chapter"
          ]
        },
        "show": {
          "type": "string",
          "enum": [
            "master",
            "part",
            "volume",
            "chapter"
          ]
        },
        "file": {
          "type": "string"
        },
        "num": {
          "type": "number",
          "minimum": 1
        },
        "list": {
          "type": "boolean",
          "description": "开关（无值参数）"
        },
        "enable": {
          "type": "boolean",
          "description": "开关（无值参数）"
        },
        "disable": {
          "type": "boolean",
          "description": "开关（无值参数）"
        }
      }
    },
  },
  {
    name: "wm_query",
    description: "七类台账查询 + 全文检索（归档区感知）：characters/foreshadow/suspense/info-gap/plotlines/timeline/names/fulltext。支持 --name/--id/--keyword 定点查询",
    inputSchema: {
      "type": "object",
      "required": [
        "what"
      ],
      "properties": {
        "dir": {
          "type": "string"
        },
        "what": {
          "type": "string",
          "enum": [
            "characters",
            "foreshadow",
            "suspense",
            "info-gap",
            "plotlines",
            "timeline",
            "names",
            "fulltext"
          ]
        },
        "name": {
          "type": "string"
        },
        "id": {
          "type": "string"
        },
        "keyword": {
          "type": "string"
        },
        "top": {
          "type": "number"
        }
      }
    },
  },
  {
    name: "wm_pacing",
    description: "三线节奏体检：quest 主线/fire 感情线/constellation 世界观 占比与断档检测，按赛道（言情模式专用 40:40:20）换算理想配比，输出修复建议",
    inputSchema: {
      "type": "object",
      "properties": {
        "dir": {
          "type": "string"
        },
        "window": {
          "type": "number",
          "minimum": 3
        }
      }
    },
  },
  {
    name: "wm_memory",
    description: "长期写作记忆（五类 style/technique/setting/feedback/character）：--add 沉淀 / --list 列举（可 --kind/--tag 过滤）/ --search 检索。context 装配时自动注入最近 5 条",
    inputSchema: {
      "type": "object",
      "properties": {
        "dir": {
          "type": "string"
        },
        "add": {
          "type": "string"
        },
        "list": {
          "type": "boolean",
          "description": "开关（无值参数）"
        },
        "search": {
          "type": "string"
        },
        "kind": {
          "type": "string"
        },
        "tag": {
          "type": "string"
        }
      }
    },
  },
  {
    name: "wm_verify",
    description: "包完整性门禁：V1 知识切片 sha 锁（以 index.json 当前内容动态计算，--update-lock 生成/刷新锁）/ V2 模板引用 / V3 命令齐备+CLI↔MCP 双形态一致 / V4 全链路冒烟",
    inputSchema: {
      "type": "object",
      "properties": {
        "root": {
          "type": "string"
        },
        "update_lock": {
          "type": "boolean",
          "description": "开关（无值参数）"
        },
        "no_smoke": {
          "type": "boolean",
          "description": "开关（无值参数）"
        }
      }
    },
  },
];

/** 按上游顺序的工具名清单。 */
export const WM_TOOL_NAMES = WM_TOOLS.map((t) => t.name);

export default WM_TOOLS;
