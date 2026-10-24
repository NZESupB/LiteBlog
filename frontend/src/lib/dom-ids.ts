// 跨组件共享的 DOM id：Layout 通过 getElementById 观察 Timeline 渲染的节点，
// 用常量把这条隐式契约变成显式依赖，重命名时两处必须一起改。
export const JOURNAL_WRITE_ANCHOR_ID = 'journalWriteAnchor'
