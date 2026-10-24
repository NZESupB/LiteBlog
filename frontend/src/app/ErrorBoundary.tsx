import { Component, type ErrorInfo, type ReactNode } from 'react'
export class ErrorBoundary extends Component<{ children: ReactNode }, { error: string }> {
  state = { error: '' }
  static getDerivedStateFromError(error: Error) {
    return { error: error.message }
  }
  componentDidCatch(_error: Error, _info: ErrorInfo) {
    /* 错误正文展示在可恢复界面，不输出用户内容。 */
  }
  render() {
    if (this.state.error)
      return (
        <main className="container">
          <h1>页面暂时无法打开</h1>
          <p role="alert">{this.state.error}</p>
          <button onClick={() => location.reload()}>重新加载</button>
          <p>未发布草稿仍保存在此浏览器。</p>
        </main>
      )
    return this.props.children
  }
}
