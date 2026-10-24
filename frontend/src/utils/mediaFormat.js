// 兼容层:历史上的 mediaFormat 只导出 formatDuration(毫秒口径)且非法值给英文 'N/A'。
// 现已统一到 utils/displayFormat.js(中文界面用 '—',超过 1 小时正确折成 h:mm:ss)。
// 保留这个文件名避免外部引用中断。
// 注意:utils/format.js 这个路径被 scripts/sourceBoundary.test.mjs 列为"必须不存在"
// (早前重构遗留的边界约束),所以新模块命名为 displayFormat.js。
export { formatDurationMs as formatDuration } from './displayFormat';
