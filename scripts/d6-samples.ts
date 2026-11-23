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
  title: '长对话：从通用导图工具到评委三分钟演示',
  summary: '十二轮对话中产品重心两次迁移，展示长对话里观点被取代、重述加年轮与焦点漂移。',
  startedAt: '2026-11-19T14:00:00.000Z',
  turns: [
    {
      user: '我想做一个把对话自动整理成思维导图的工具。',
      assistant: '可以先确定输入来源和分析粒度，再决定导图的交互方式。',
      ops: [{ op: 'ADD_NODE', node: { type: 'claim', label: '做思维导图工具', summary: '用户想自动把对话整理成思维导图' }, edges: [] }],
    },
    {
      user: '自动抽取观点是不是得靠大模型？怎么保证不出错？',
      assistant: '可以让模型只输出结构化操作，再由本地规则校验与折叠，出错时整包丢弃。',
      ops: [{ op: 'ADD_NODE', node: { type: 'question', label: '如何自动抽取观点', summary: '用户关心自动抽取观点的可靠性与校验方式' }, edges: [] }],
    },
    {
      user: '比赛 11 月底截止，我只有两周时间。',
      assistant: '时间有限时先做一条能演示的端到端链路，再补细节。',
      ops: [{ op: 'ADD_NODE', node: { type: 'fact', label: '比赛11月底截止', summary: '用户距离比赛截止只剩约两周' }, edges: [] }],
    },
    {
      user: '那我先做本地插件，不做网站，插件更容易演示。',
      assistant: '本地插件能直接读会话，但要考虑安装门槛与隐私边界。',
      ops: [{ op: 'ADD_NODE', node: { type: 'claim', label: '先做本地插件', summary: '用户决定优先做本地插件而不是网站' }, edges: [] }],
    },
    {
      user: '朋友说评委只看三分钟，插件安装太慢了。我改主意了，应该先保证三分钟能看懂。',
      assistant: '评委时间有限，首屏就要给出定义和一条可回放的样例，插件演示可以后置。',
      ops: [
        {
          op: 'ADD_NODE',
          node: { type: 'ai-voice', label: '评委只看三分钟', summary: 'AI 指出评委时间有限，首屏必须快速说明价值' },
          edges: [],
        },
        {
          op: 'MARK_SHIFT',
          nodeId: null,
          shift: {
            fromNodeId: 'n_0004',
            toSummary: '产品重心从通用插件转向评委三分钟演示',
            triggerNodeId: '@prev',
            triggerTurn: 5,
            retro: false,
          },
        },
      ],
    },
    {
      user: '那在线沙箱怎么做才不会被刷？',
      assistant: '按 IP 限制每日会话数，全站每日分析轮次设上限，相同输入走缓存，超限就给回放入口。',
      ops: [{
        op: 'ADD_NODE',
        node: { type: 'question', label: '沙箱怎么限流', summary: '用户关心在线沙箱如何防止滥用' },
        edges: [{ from: 'n_0005', to: '@new', kind: 'related', bornTurn: 6 }],
      }],
    },
    {
      user: '公开样例用合成的就行，真实对话太敏感。',
      assistant: '合成样例可以完整演示转变与长对话，但页面要明确标注合成，不能暗示是真实会话。',
      ops: [{ op: 'ADD_NODE', node: { type: 'claim', label: '合成样例就够', summary: '用户倾向公开样例只用合成数据' }, edges: [] }],
    },
    {
      user: '但作者要求真实样例必须逐段批准才能用。',
      assistant: '那就把批准做成硬闸：批准文件缺失或敏感扫描有命中时，只发布合成样例。',
      ops: [{ op: 'ADD_NODE', node: { type: 'fact', label: '真实样例需逐段批准', summary: '真实会话样例必须经作者逐段批准后才能替换' }, edges: [] }],
    },
    {
      user: '公网发布前还要验什么？',
      assistant: '至少验出网、Secret 不泄露、限流计数、冷打开时间和移动端布局，发布后再复测一次。',
      ops: [{ op: 'ADD_NODE', node: { type: 'question', label: '公网发布前验什么', summary: '用户询问发布前必须验证的项目' }, edges: [] }],
    },
    {
      user: '所以还是先把本地验收跑完再谈发布，对吧？',
      assistant: '对，本地全量测试与浏览器验收通过后再申请发布，避免把未验收的版本推上去。',
      ops: [
        {
          op: 'ADD_NODE',
          node: { type: 'claim', label: '先本地验收再发布', summary: '用户确认发布前必须先完成本地验收' },
          edges: [{ from: 'n_0009', to: '@new', kind: 'related', bornTurn: 10 }],
        },
        { op: 'REINFORCE', nodeId: 'n_0006', turn: 10 },
      ],
    },
    {
      user: '公开样例的结论也改一下：先用合成数据，真实样例以后补。',
      assistant: '这会把之前「合成就够」修正为可替换的流程：合成先行，真实样例经批准后替换。',
      ops: [{
        op: 'MARK_SHIFT',
        nodeId: null,
        shift: {
          fromNodeId: 'n_0008',
          toSummary: '公开样例先用合成数据，真实样例经批准后替换',
          triggerNodeId: null,
          triggerTurn: 11,
          retro: false,
        },
      }],
    },
    {
      user: '好，那演示就先讲评委路线，插件安装放后面。',
      assistant: '演示顺序可以是：一句话定义、三分钟路线、回放样例、沙箱，最后才是安装。',
      ops: [
        { op: 'REINFORCE', nodeId: 'n_0006', turn: 12 },
        { op: 'REINFORCE', nodeId: 'n_0010', turn: 12 },
      ],
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