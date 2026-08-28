# 「我们的日常」前端视觉设计评估报告

> 评估方式：通读 `public/style.css`（748 行）与页面结构，启动本地服务后用真实浏览器截取桌面端（1440px）与移动端（390px）的登录页、时间轴、动态卡片、相册、账号页、设置页，并对关键配色做了 WCAG 对比度实测。
> 评估日期：2026-08-28

---

## 一、总体评价

这套视觉系统的底子很好：设计 token 化程度高（色板/圆角/阴影/缓动均变量化）、暖纸基底 + 墨色 + 珊瑚红的调性统一且贴合「情侣日常」的产品气质、动效曲线统一为 `--spring` 且完整处理了 `prefers-reduced-motion`、滚动条/选区/灯箱等细节都有考量。主要问题集中在 **辅助色对比度不达标（可读性硬伤）**、**圆角与字号体系失控**、**键盘焦点态缺失** 三类，均可用小成本修正。

---

## 二、问题清单（按优先级排序）

### 🔴 P0-1 辅助文字色对比度严重不足，影响可读性【关键问题】

实测数据（WCAG AA 要求正文 ≥ 4.5:1）：

| 用途 | 当前值 | 实测对比度 | 是否达标 |
|---|---|---|---|
| 导航链接 / 时间戳 / 表单标签（`--muted`） | `#a2968e` | **2.68–2.84:1** | ❌ 远低于 4.5:1 |
| 评论时间 / 输入占位符（`--faint`） | `#c4b9b1` | **1.89:1** | ❌ 几乎不可读 |
| 导航激活态（`--accent` 文字） | `#e5636f` | **3.08:1** | ❌ 14.5px 正文不达标 |
| 正文（`--text`） | `#3b3531` | 11.90:1 | ✅ |

讽刺的是账号页自定义的 `--account-muted: #716966`（4.99:1）是达标的——同一产品存在两套辅助色，且全局那套恰恰是不合格的。

### 🔴 P0-2 键盘焦点指示大面积缺失【关键问题】

全站只有 4 处定义了 `:focus-visible`（account-back、more-btn、account .btn、comment-reply-cancel）。导航链接、铃铛、头像菜单、工具栏按钮、表情、reaction 等高频交互元素均依赖浏览器默认 outline，而多处又写了 `outline: none`。键盘/无障碍用户会「迷路」。

### 🟠 P1-3 圆角体系失控

Token 只定义了 18px / 10px 两档，实际代码中出现 **4 / 7 / 8 / 9 / 10 / 11 / 12 / 13 / 14 / 18 / 999px 共 11 种**。同类组件不一致：

- 下拉菜单 `.dropdown` 14px vs 动态菜单 `.post-menu` 13px
- 输入框：登录页 12px vs 设置页 11px vs 账号页 10px（同一组件三种值）

### 🟠 P1-4 移动端触控目标普遍小于 44px

more-btn 26px、工具栏按钮 29–30px、评论表情钮 30px、reaction 选项 30px、铃铛 32px。移动端截图可见工具栏已折成两行，小热区 + 高密度排布容易误触。

### 🟠 P1-5 桌面端空间浪费，相册桌面端过挤

容器固定 640px：时间轴保持 640px 阅读宽度是合理的，但相册页桌面端（1440px 截图实测）也只有 4 列、单图约 150px，两侧大片空白，浏览体验明显被移动端布局拖累。

### 🟡 P2-6 字号层级过碎

全站共 13 档字号：21 / 19 / 17 / 15.5 / 15 / 14.5 / 14 / 13.5 / 13 / 12.5 / 12 / 11.5 / 9.5px，其中 12–15.5px 区间挤了 8 档，视觉差异人眼不可辨，徒增维护成本。

### 🟡 P2-7 语义色与变量重复

- 成功绿有两个：`--success: #2a9d4a`（设置页）vs `--account-success: #397348`（账号页），同义不同色。
- 账号页重复定义 `--account-accent`（= `--accent-deep`）等变量，与全局 token 冗余。

### 🟡 P2-8 样式耦合：`!important` 滥用

`.more-btn`、`.post-menu-comment` 用 `!important` 覆盖基础样式，说明按钮基类与特例之间职责不清，后续改动容易连锁破版。

### 🟡 P2-9 其他细节

- 未处理 iPhone 刘海/底部指示条安全区（无 `env(safe-area-inset-*)`）。
- 无暗色模式（`theme-color` 固定 `#e5636f`）——可选增强，非缺陷。

---

## 三、改进方案

### P0-1 修正辅助色对比度（改 3 个变量即可）

```css
:root {
  --muted: #7a6d63;   /* 原 #a2968e → 4.65:1，达标 */
  --faint: #a89b92;   /* 原 #c4b9b1 → 仅保留给占位符等装饰用途 */
  /* 评论时间、post-time 等信息性文字改用 --muted */
}
.site-nav a.active { color: var(--accent-deep); }  /* #b64d58 → 4.66:1，配合 font-weight:600 区分度更强 */
.comment-meta .comment-time { color: var(--muted); }  /* 原 --faint */
```

同步删除账号页的 `--account-muted`，统一回 `--muted`。预期效果：导航、时间戳、标签文字从「发虚」变为清晰可读，整体气质不变（色相同族，只是加深）。

### P0-2 统一键盘焦点环

```css
:focus-visible {
  outline: 2px solid var(--accent-deep);
  outline-offset: 2px;
  border-radius: inherit;
}
```

对图标按钮类（`.bell-btn`、`.avatar-btn`、`.emoji-btn`、`.reaction` 等）确认未被局部 `outline: none` 覆盖。预期效果：Tab 键浏览全程可见焦点，成本极低。

### P1-3 圆角收敛为四级 token

```css
:root {
  --radius-xs: 8px;    /* 小元素：工具栏按钮、标签、代码块 */
  --radius-sm: 12px;   /* 输入框、下拉、小面板（统一登录/设置/账号三处） */
  --radius: 18px;      /* 卡片 */
  --radius-pill: 999px;
}
```

将 13/14px 归并到 12px，9/10/11px 归并到 8px 或 12px。预期效果：组件边缘节奏统一，改动只涉及变量替换。

### P1-4 移动端扩大触控热区

不动视觉尺寸，用负 margin + padding 扩大热区，或在移动端媒体查询中提升高度：

```css
@media (max-width: 559px) {
  .md-toolbar button { min-width: 38px; height: 38px; }
  .more-btn { height: 32px; padding: 0 14px; }
  .bell-btn { width: 40px; height: 40px; }
  .comment-form .emoji-toggle { width: 38px; height: 38px; }
}
```

### P1-5 相册页桌面端放宽

```css
@media (min-width: 768px) {
  main:has(.gallery-grid) { max-width: 960px; }
  .gallery-grid { grid-template-columns: repeat(5, 1fr); gap: 10px; }
}
@media (min-width: 1200px) {
  .gallery-grid { grid-template-columns: repeat(6, 1fr); }
}
```

时间轴容器维持 640px 不动。预期效果：相册桌面端从「缩略图墙」变成可用的照片浏览页。

### P2-6 字号收敛为六级

| 层级 | 建议值 | 用途 |
|---|---|---|
| caption | 12px | 时间戳、角标（9.5px 徽章数字可升到 10px） |
| small | 13px | 辅助说明、hint |
| body-sm | 14px | 评论、导航 |
| body | 15.5px | 动态正文 |
| title-sm | 17px | 区块标题 |
| display | 21px + clamp(30–38px) | 站点名、登录 hero |

12.5/13.5/14.5px 就近归并。

### P2-7 合并语义色

```css
:root { --success: #2e8b4f; }  /* 取两绿的中间值，删 --account-success */
```

同时删除账号页的 `--account-accent / --account-muted` 局部变量，全部引用全局 token。

### P2-8 消除 `!important`

给 `.post-actions button` 与 `.more-btn` 建立明确的基类/变体结构（如 `.icon-chip`），用选择器特异性而非 `!important` 解决覆盖。

### P2-9 细节收尾

```css
.site-header { padding-top: env(safe-area-inset-top); }
.container { padding-bottom: calc(90px + env(safe-area-inset-bottom)); }
```

---

## 四、落地优先级建议

| 批次 | 内容 | 成本 | 收益 |
|---|---|---|---|
| 第一批（立即） | P0-1 改 3 个色值 + P0-2 加焦点环 | ~30 分钟 | 可读性与无障碍质的提升 |
| 第二批 | P1-3 圆角 token 化 + P1-4 触控热区 | 半天 | 组件一致性、移动端体验 |
| 第三批 | P1-5 相册桌面布局 + P2 各项 | 一天内 | 桌面端体验、长期可维护性 |
