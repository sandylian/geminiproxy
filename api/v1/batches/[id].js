import handler from '../../_handler.js';

export const maxDuration = 300;

// Node 运行时的入口格式：默认导出带 fetch 方法的对象（Edge 的裸函数格式在这里不被支持）
export default {
  fetch: (request) => handler(request),
};
