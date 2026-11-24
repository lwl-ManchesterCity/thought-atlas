export class AppError extends Error {
  code: string;
  status: number;
  constructor(code: string, status: number) {
    super(code);
    this.code = code;
    this.status = status;
  }
}

const PUBLIC_MESSAGES: Record<string, string> = {
  invalid_input: '输入不合法',
  invalid_json: '请求格式不正确',
  payload_too_large: '内容过长',
  text_too_long: '单轮内容不能超过 2000 字',
  session_limit: '今天的体验会话次数已用完（每个 IP 每日 2 次）',
  session_turn_limit: '本会话已达 15 轮上限，请回到回放样例继续看星图',
  session_busy: '本会话正在处理上一条消息，请稍后再试',
  quota_exhausted: '今日额度已用完，请看回放',
  service_not_configured: '演示服务尚未配置模型密钥，暂不可用；回放样例不受影响',
  analysis_failed: '本轮分析失败，聊天不受影响，可以继续发送',
  model_unavailable: '模型服务暂时不可用，请稍后再试',
  database_unavailable: '演示服务暂时不可用，请稍后再试',
  not_found: '会话不存在',
  forbidden: '无权访问该会话',
};

export function publicMessage(code: string): string {
  return PUBLIC_MESSAGES[code] ?? '服务暂时不可用';
}

export function errorResponse(error: unknown): Response {
  if (error instanceof AppError) {
    return Response.json(
      { error: error.code, message: publicMessage(error.code) },
      { status: error.status },
    );
  }
  console.error('internal_error', error instanceof Error ? `${error.name}: ${error.message}` : String(error));
  return Response.json(
    { error: 'internal_error', message: '服务暂时不可用' },
    { status: 500 },
  );
}