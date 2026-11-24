import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { ThoughtGraph } from '../site/functions/lib/core/graph.ts';
import type {
  EventRecord,
  FailureRecord,
  GraphMap,
  MapOp,
  SessionMeta,
  TurnPayload,
} from '../site/functions/lib/core/types.ts';
import type { Storage } from '../site/functions/lib/core/ports.ts';

const OUT = fileURLToPath(new URL('../site/samples/', import.meta.url));
const SYNTHETIC_NOTICE = '合成演示数据：由脚本生成，不含任何真实用户会话内容。';

interface ScriptedTurn {
  user: string;
  assistant: string;
  ops: MapOp[];
}

interface SessionSpec {
  id: string;
  title: string;
  summary: string;
  startedAt: string;
  turns: ScriptedTurn[];
}

class CollectingStorage implements Storage {
  events: EventRecord[] = [];
  failures: FailureRecord[] = [];
  map: GraphMap | null = null;

  async appendTurn(_payload: TurnPayload): Promise<void> {}
  async appendEvent(record: EventRecord): Promise<void> {
    this.events.push(structuredClone(record));
  }
  async appendFailure(record: FailureRecord): Promise<void> {
    this.failures.push(structuredClone(record));
  }
  async saveMap(map: GraphMap): Promise<void> {
    this.map = structuredClone(map);
  }
  async loadMap(): Promise<GraphMap | null> {
    return this.map ? structuredClone(this.map) : null;
  }
  async loadEvents(): Promise<EventRecord[]> {
    return structuredClone(this.events);
  }
  async saveMeta(_meta: SessionMeta): Promise<void> {}
}

function stamp(startedAt: string, turnIndex: number): string {
  const base = Date.parse(startedAt);
  return new Date(base + (turnIndex - 1) * 95_000).toISOString();
}

async function build(spec: SessionSpec) {
  const storage = new CollectingStorage();
  const graph = new ThoughtGraph(spec.id, storage);
  const turns: { turnIndex: number; timestamp: string; userText: string; assistantText: string }[] = [];
  for (let i = 0; i < spec.turns.length; i++) {
    const turnIndex = i + 1;
    const scripted = spec.turns[i];
    const timestamp = stamp(spec.startedAt, turnIndex);
    const result = await graph.applyTurn(turnIndex, scripted.ops, timestamp);
    if (!result.ok) throw new Error(`${spec.id} turn ${turnIndex} rejected: ${result.reason}`);
    turns.push({ turnIndex, timestamp, userText: scripted.user, assistantText: scripted.assistant });
  }
  const map = graph.getMap();
  const shifts = map.nodes.filter((node) => node.type === 'shift').length;
  const influences = map.edges.filter((edge) => edge.kind === 'influence').length;
  return {
    synthetic: true,
    notice: SYNTHETIC_NOTICE,
    session: {
      id: spec.id,
      title: spec.title,
      summary: spec.summary,
      turns,
      events: storage.events,
      map,
      stats: {
        turns: turns.length,
        nodes: map.nodes.length,
        edges: map.edges.length,
        shifts,
        influences,
        types: map.nodes.reduce<Record<string, number>>((acc, node) => {
          acc[node.type] = (acc[node.type] ?? 0) + 1;
          return acc;
        }, {}),
      },
    },
  };
}

const learning: SessionSpec = {
  id: 'sample-learning',
  title: '学习场景：从「JS 的 bug」到 IEEE754 精度取舍',
  summary: '概念讨论由浅入深，包含一次立场转折、AI 关键发言与其 influence 边，最后转向面试表达。',
  startedAt: '2026-11-20T09:00:00.000Z',
  turns: [
    {
      user: '0.1 + 0.2 为什么不等于 0.3？我一直以为这是 JS 的 bug。',
      assistant: '这是二进制浮点数的表示限制，不是 JavaScript 独有。0.1 在二进制里是无限循环小数，只能存近似值。',
      ops: [{
        op: 'ADD_NODE',
        node: { type: 'claim', label: '浮点误差是JS bug', summary: '用户最初认为 0.1+0.2 不等于 0.3 是 JavaScript 的缺陷' },
        edges: [],
      }],
    },
    {
      user: '听懂了，所以这是 IEEE754 的精度取舍，不是 bug？我之前的判断反了。',
      assistant: '对。IEEE754 定义了二进制浮点的存储与舍入规则，误差是标准取舍；需要精确十进制时应改用 decimal 或整数分。',
      ops: [
        {
          op: 'ADD_NODE',
          node: { type: 'ai-voice', label: 'IEEE754精度取舍', summary: 'AI 解释二进制无法精确表示 0.1，误差是标准取舍而非缺陷' },
          edges: [],
        },
        {
          op: 'MARK_SHIFT',
          nodeId: null,
          shift: {
            fromNodeId: 'n_0001',
            toSummary: '浮点误差是IEEE754精度取舍，不是JS的bug',
            triggerNodeId: '@prev',
            triggerTurn: 2,
            retro: false,
          },
        },
      ],
    },
    {
      user: '那为什么银行系统不用浮点数存钱？',
      assistant: '金额通常用整数最小货币单位或十进制定点类型，避免二进制舍入在累计与对账时产生偏差。',
      ops: [{ op: 'ADD_NODE', node: { type: 'question', label: '银行为何不用浮点', summary: '用户好奇银行系统如何避免浮点误差来存钱' }, edges: [] }],
    },
    {
      user: '我下周要参加算法考试，本来还打算用浮点数处理金额题。',
      assistant: '考试里处理金额可以用整数分或明确说明使用十进制类型；关键是不要用浮点直接比较相等。',
      ops: [{ op: 'ADD_NODE', node: { type: 'fact', label: '下周算法考试', summary: '用户下周参加算法考试，原本计划用浮点数处理金额题' }, edges: [] }],
    },
    {
      user: '如果面试官问十进制精度，我该怎么回答？',
      assistant: '先说明二进制浮点的表示限制，再给出业务选型：金额用整数分或 decimal，并指出相等比较要带容差。',
      ops: [{
        op: 'ADD_NODE',
        node: { type: 'question', label: '面试如何解释精度', summary: '用户想知道面试中如何解释十进制精度问题' },
        edges: [],
      }],
    },
    {
      user: '比起 JS 的 bug，我现在更关心面试怎么把这件事讲清楚。',
      assistant: '可以把回答压缩成三步：现象、原因、选型。用一个金额例子收尾，比背定义更有说服力。',
      ops: [
        {
          op: 'ADD_NODE',
          node: { type: 'claim', label: '面试表达更重要', summary: '用户把关注点从定位 bug 转向面试中的表达方式' },
          edges: [{ from: 'n_0004', to: '@new', kind: 'related', bornTurn: 6 }],
        },
        { op: 'REINFORCE', nodeId: 'n_0006', turn: 6 },
      ],
    },
    {
      user: '我打算试一下 decimal.js，看看它和整数分在金额场景的差别。',
      assistant: '可以各写一个小例子：累加、除法和相等比较，观察 decimal 的精度配置与整数分的取整策略。',
      ops: [
        { op: 'ADD_NODE', node: { type: 'fact', label: '试用decimal.js', summary: '用户计划用 decimal.js 对比整数分处理金额的差别' }, edges: [] },
        { op: 'REINFORCE', nodeId: 'n_0004', turn: 7 },
      ],
    },
    {
      user: '明白了，谢谢，我先去准备考试。',
      assistant: '祝考试顺利。需要时可以把金额例子发来一起检查。',
      ops: [{ op: 'SKIP' }],
    },
  ],
};

const focus: SessionSpec = {
  id: 'sample-focus',
  title: '人生决策：毕业先工作还是读研',
  summary: '十轮单链：纠结 → 顾虑 → 倾向 → 硬约束 → 立场转变 → 行动与兜底，每一步都由上一步引出。',
  startedAt: '2026-11-19T14:00:00.000Z',
  turns: [
    {
      user: '毕业先工作还是先读研？我纠结了一个月了。',
      assistant: '先把两条路各自给你什么、要你付什么摆出来，再看哪一条是你放不下的。',
      ops: [{ op: 'ADD_NODE', node: { type: 'claim', label: '先工作还是读研', summary: '用户在毕业先工作与先读研之间纠结' }, edges: [] }],
    },
    {
      user: '家里希望我读研，说本科出去起薪低。',
      assistant: '家人的建议基于平均回报；但个体差异很大，值得把自己的情况单独算一遍。',
      ops: [{
        op: 'ADD_NODE',
        node: { type: 'fact', label: '家里希望读研', summary: '家人以起薪为由希望用户读研' },
        edges: [],
      }],
    },
    {
      user: '我怕先工作之后，就再也回不到读书的状态了。',
      assistant: '先工作的成本主要是学习节奏中断；但也要看岗位本身有没有积累，有积累的经验会复利。',
      ops: [{
        op: 'ADD_NODE',
        node: { type: 'question', label: '怕回不到读书状态', summary: '用户担心工作后无法再回到学习状态' },
        edges: [],
      }],
    },
    {
      user: '那我倾向先工作：三年能复利的经验，比一纸学历更实在。',
      assistant: '这个推理对看重经验的岗位成立；但先确认你的目标岗位有没有硬门槛。',
      ops: [{
        op: 'ADD_NODE',
        node: { type: 'claim', label: '倾向先工作', summary: '用户以经验复利为由倾向先工作' },
        edges: [],
      }],
    },
    {
      user: '我想做的是算法研究岗，硕士学历是简历关，绕不开。',
      assistant: '那读研就是你目标岗位的入场券，不是可选项；这条硬约束会覆盖一般性的比较。',
      ops: [{
        op: 'ADD_NODE',
        node: { type: 'ai-voice', label: '学历是入场券', summary: 'AI 指出目标岗位以学历为硬门槛，读研是入场券' },
        edges: [],
      }],
    },
    {
      user: '那我之前的推理反了：拿「经验复利」论证先工作，可目标岗位根本不给我积累经验的机会。我改主意了，先读研。',
      assistant: '对。之前的比较只在不设门槛的岗位里成立；约束清楚之后，结论就翻转了。',
      ops: [{
        op: 'MARK_SHIFT',
        nodeId: null,
        shift: {
          fromNodeId: 'n_0004',
          toSummary: '目标岗位有学历硬门槛，决定先读研',
          triggerNodeId: 'n_0005',
          triggerTurn: 5,
          retro: false,
        },
      }],
    },
    {
      user: '那读研期间怎么避免混学历？',
      assistant: '把学历当入场券、把实习与项目积累当真正目标，两者不冲突。',
      ops: [{
        op: 'ADD_NODE',
        node: { type: 'question', label: '读研怎么不混', summary: '用户追问读研期间如何避免只为混学历' },
        edges: [],
      }],
    },
    {
      user: '明白了：学历解决门槛，积累解决天花板，读研期间我也会找实习。',
      assistant: '这样「经验复利」没有被丢掉，只是被后置：先拿入场券，再复利。',
      ops: [
        {
          op: 'ADD_NODE',
          node: { type: 'claim', label: '学历门槛积累天花板', summary: '用户把学历与积累分工：门槛与天花板各归其位' },
          edges: [],
        },
        { op: 'REINFORCE', nodeId: 'n_0005', turn: 8 },
      ],
    },
    {
      user: '再问一句：万一考研失败，先工作这条路还在吗？',
      assistant: '在。入场券逻辑只说读研更稳，没说工作无价值；留兜底不影响主线。',
      ops: [{
        op: 'ADD_NODE',
        node: { type: 'question', label: '考研失败的兜底', summary: '用户确认考研失败时先工作仍是兜底选项' },
        edges: [],
      }],
    },
    {
      user: '好，我去查目标院校的考试科目和实习窗口了，谢谢。',
      assistant: '祝顺利。需要时可以把 offer 与读研的取舍再拿来一起复盘。',
      ops: [{ op: 'SKIP' }],
    },
  ],
};

const built = [await build(learning), await build(focus)];
await mkdir(OUT, { recursive: true });
for (const sample of built) {
  const name = sample.session.id === learning.id ? 'learning.json' : 'focus.json';
  await writeFile(join(OUT, name), JSON.stringify(sample, null, 2) + '\n');
}
const manifest = {
  synthetic: true,
  notice: SYNTHETIC_NOTICE,
  generatedAt: new Date().toISOString(),
  realSamplesApproved: false,
  sessions: built.map((sample, index) => ({
    file: index === 0 ? 'learning.json' : 'focus.json',
    id: sample.session.id,
    title: sample.session.title,
    summary: sample.session.summary,
    stats: sample.session.stats,
  })),
};
await writeFile(join(OUT, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
console.log(JSON.stringify(manifest, null, 2));