# MUSE Design Guide

这份文档提炼自 `beauty-gallery.html` 的视觉风格和交互语言。以后设计新网页时，可以把它作为设计规范或提示词上下文使用。

## 1. 风格定位

关键词：

- 暗色奢华画廊
- 电影感光影
- 编辑式留白
- 金色细线与微光
- 慢速、克制、优雅的交互
- 人像摄影、作品集、品牌形象、艺术展示类页面优先适用

核心感受：

页面像一本深色高级摄影画册，不像普通商业落地页。它的记忆点不是复杂组件，而是暗背景、衬线大标题、低饱和图片、金色点缀、缓慢出现的文字和柔和的悬浮反馈。

设计方向：

- 用真实图片承载情绪，装饰只做氛围。
- 用大字号衬线标题建立高级感。
- 用极少的金色强调层级。
- 用细线、微边框、低透明背景制造质感。
- 动效慢一点，像镜头推近，而不是像按钮弹跳。

## 2. 设计原则

### 必须保留

- 深色暖黑背景，而不是纯黑。
- 金色作为唯一主强调色。
- 标题使用高对比衬线字体，正文使用干净无衬线或中文宋体。
- 图片整体低饱和、高对比、略暗，hover 时恢复一点鲜活感。
- section 之间使用大间距和细边框分隔。
- 卡片圆角很小，通常 `2px` 到 `4px`。
- 动效使用 `cubic-bezier(0.16, 1, 0.3, 1)` 这类缓出曲线。

### 尽量避免

- 大面积亮白背景。
- 过度彩色渐变。
- 紫蓝科技感渐变。
- 大圆角卡片和过厚阴影。
- 过多图标和复杂控件。
- 普通 SaaS 风格的卡片堆叠。
- 动效太快、太弹、太可爱。

## 3. 色彩系统

推荐直接使用这组 CSS 变量：

```css
:root {
  --bg: #0e0c0b;
  --bg-warm: #151210;
  --surface: #1a1714;
  --surface-lift: #211e1a;

  --fg: #f0ece4;
  --fg-cream: #e8e0d4;
  --muted: #8a8078;
  --muted-light: #a69e94;

  --border: #2a2520;
  --border-light: #3a342e;

  --accent: #c9a96e;
  --accent-soft: #b89858;
  --accent-glow: oklch(72% 0.10 75 / 0.15);
  --rose: #c47d7d;
}
```

使用比例：

- 背景色占 70% 到 80%。
- 图片占 15% 到 25%。
- 金色强调不超过 5%。
- 玫瑰色只做极少量辅助，不要和金色争主角。

## 4. 字体系统

推荐变量：

```css
:root {
  --font-display: "Cormorant Garamond", Georgia, "Times New Roman", serif;
  --font-body: "Instrument Sans", -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
  --font-cn: "Noto Serif SC", "STSong", "SimSun", "Songti SC", serif;
}
```

标题：

- 使用 `--font-display`。
- 字重以 `300` 或 `400` 为主。
- 英文标题可使用 italic 强调一个关键词。
- 大标题行高偏紧，推荐 `0.95` 到 `1.08`。

小标签：

- 使用无衬线字体。
- 全大写。
- 字号 `10px` 到 `12px`。
- 字距 `0.2em` 到 `0.35em`。
- 颜色使用 `--accent`。

中文正文：

- 使用中文宋体或衬线字体。
- 行高 `1.8` 到 `2`。
- 字距 `0.04em` 到 `0.1em`。
- 颜色不要太亮，优先 `--muted-light` 或 `--fg-cream`。

## 5. 布局语言

### 页面骨架

```css
section {
  position: relative;
  z-index: 3;
}

.section-inner {
  max-width: 1300px;
  margin: 0 auto;
  padding: clamp(100px, 14vh, 180px) clamp(24px, 6vw, 80px);
}
```

布局节奏：

- Hero 使用接近满屏高度。
- 普通 section 使用很大的上下留白。
- 内容最大宽度控制在 `1200px` 到 `1300px`。
- 横向留白使用 `clamp(24px, 6vw, 80px)`。
- section 分隔用 `1px` 暖灰边框，不用厚分割块。

### Hero

Hero 必须第一眼传达品牌或作品气质。

结构建议：

```html
<section class="hero">
  <div class="hero-bg"><img src="hero.jpg" alt=""></div>
  <div class="hero-eyebrow">Beauty × Grace × Light</div>
  <h1 class="hero-title">
    <span class="line"><span class="line-inner">The Art of</span></span>
    <span class="line"><span class="line-inner"><em>Being</em></span></span>
    <span class="line"><span class="line-inner">Seen</span></span>
  </h1>
  <p class="hero-subtitle-cn">光影之间，捕捉真实的美</p>
</section>
```

视觉规则：

- 背景图片全屏铺满，`object-fit: cover`。
- 图片初始 `opacity: 0.22` 到 `0.3`。
- 使用上下渐变遮罩，让图片融入背景。
- H1 使用超大衬线字体，推荐 `clamp(52px, 10vw, 140px)`。
- Hero 内容居中，但不要放进卡片。

## 6. 组件模式

### 导航栏

特征：

- 固定顶部。
- 顶部时透明，滚动后有磨砂背景。
- 向下滚动隐藏，向上滚动显示。
- logo 使用宽字距衬线英文。

CSS 方向：

```css
nav {
  position: fixed;
  inset: 0 0 auto 0;
  height: 72px;
  padding: 0 clamp(32px, 5vw, 80px);
  display: flex;
  align-items: center;
  justify-content: space-between;
  backdrop-filter: blur(24px) saturate(140%);
  background: oklch(10% 0.015 50 / 0.7);
  border-bottom: 1px solid oklch(25% 0.02 50 / 0.3);
}
```

### 按钮

按钮应像画廊邀请函，不像普通系统按钮。

规则：

- 高度适中，横向 padding 较宽。
- 全大写，小字号，大字距。
- 圆角 `2px`。
- 主按钮用金色底，深色文字。
- 次按钮透明底，细边框。
- hover 只轻微上移和变色。

```css
.btn {
  display: inline-flex;
  align-items: center;
  gap: 10px;
  padding: 16px 36px;
  font-size: 12px;
  font-weight: 600;
  letter-spacing: 0.15em;
  text-transform: uppercase;
  border-radius: 2px;
  transition: all 0.5s var(--ease-out-expo);
}
```

### 作品瀑布流

适合图片作品集。

```css
.gallery-masonry {
  columns: 3;
  column-gap: 20px;
}

.gallery-item {
  position: relative;
  break-inside: avoid;
  margin-bottom: 20px;
  border-radius: 2px;
  overflow: hidden;
  cursor: pointer;
}

.gallery-item img {
  width: 100%;
  display: block;
  filter: saturate(0.8) contrast(1.05);
  transition: filter 0.8s var(--ease-out-expo), transform 1.2s var(--ease-out-expo);
}
```

Hover 覆盖层：

- 从底部到透明的黑色渐变。
- 默认透明。
- hover 时显示标题、标签、中文副标题。
- 图片轻微放大到 `scale(1.04)`。

### 系列卡片

用于精选系列、项目入口、服务入口。

规则：

- 图片比例 `4 / 5`。
- 文字压在图片底部渐变上。
- hover 时整体上移 `6px`。
- 可加 3D tilt，但角度要轻，最大 `8deg`。

### 引言区

用于制造停顿。

规则：

- 居中。
- 大号 italic 衬线文字。
- 背景使用 `--bg-warm`。
- 上下边框分隔。
- 引号或符号使用金色，透明度降低。

### 跑马灯

用于品牌关键词或情绪词。

规则：

- 背景用 `--surface`。
- 文字使用大号 italic 衬线。
- 无限横向滚动，速度慢，约 `40s`。
- 分隔点用金色，透明度 `0.4`。

## 7. 图片处理规则

图片是这个风格的主角。

默认图片处理：

```css
img {
  filter: saturate(0.75) contrast(1.05);
}

.image-card:hover img {
  filter: saturate(1) contrast(1.1);
  transform: scale(1.04);
}
```

选图建议：

- 使用真实主体清晰的图片。
- 光影要有方向性。
- 避免过亮、过白、过商业图库感。
- 同一页图片色温要统一，偏暖更贴合当前体系。
- 如果图片色彩太杂，降低饱和度，让金色强调色保持主导。

## 8. 动效系统

推荐缓动：

```css
:root {
  --ease-out-expo: cubic-bezier(0.16, 1, 0.3, 1);
  --ease-out-quint: cubic-bezier(0.22, 1, 0.36, 1);
  --ease-in-out: cubic-bezier(0.76, 0, 0.24, 1);
}
```

### 入场动画

Hero 标题使用逐行上滑 reveal。

```css
.hero-title .line {
  display: block;
  overflow: hidden;
}

.hero-title .line-inner {
  display: block;
  transform: translateY(110%);
}
```

节奏：

- eyebrow 先出现。
- 标题逐行延迟 `0.15s`。
- 中文副标题、英文副标题、分割线、按钮依次出现。
- 整个 Hero 入场时间约 `2s`。

### 滚动 reveal

普通元素：

```css
.reveal {
  opacity: 0;
  transform: translateY(50px);
  transition: opacity 1s var(--ease-out-expo), transform 1s var(--ease-out-expo);
}

.reveal.visible {
  opacity: 1;
  transform: translateY(0);
}
```

子元素错峰：

- 每个子元素延迟 `0.1s`。
- 最多延迟到 `0.8s` 左右即可。

### 自定义鼠标

桌面端可使用：

- 金色小点。
- 金色细环。
- 低透明大范围光晕。
- hover 到可交互元素时，环扩大。

移动端必须关闭自定义鼠标。

### Magnetic 按钮

按钮跟随鼠标移动一点点，幅度控制在 `20%` 位移以内。

```js
button.addEventListener("mousemove", event => {
  const rect = button.getBoundingClientRect();
  const x = event.clientX - rect.left - rect.width / 2;
  const y = event.clientY - rect.top - rect.height / 2;
  button.style.transform = `translate(${x * 0.2}px, ${y * 0.2}px)`;
});
```

### Lightbox

作品点击后进入沉浸式灯箱。

规则：

- 背景接近黑色，透明度 `0.96`。
- 使用 `backdrop-filter: blur(24px)`。
- 图片最大 `90vw` 和 `88vh`。
- 打开时从 `scale(0.92)` 到 `scale(1)`。
- `Esc` 和点击背景都能关闭。

## 9. 响应式规则

断点建议：

```css
@media (max-width: 1024px) {
  .gallery-masonry { columns: 2; }
  .collections-grid { grid-template-columns: 1fr; }
}

@media (max-width: 768px) {
  body { cursor: auto; }
  .cursor-dot,
  .cursor-ring,
  .cursor-glow { display: none; }
  .nav-links { display: none; }
  .about-grid,
  .contact-grid { grid-template-columns: 1fr; }
}

@media (max-width: 480px) {
  .gallery-masonry { columns: 1; }
  .hero-cta { flex-direction: column; width: 100%; }
  .btn { width: 100%; justify-content: center; }
}
```

移动端注意：

- Hero 字号需要降低。
- 按钮可以全宽。
- 图片覆盖层 padding 减小。
- 不要保留自定义鼠标。
- 卡片 tilt 在触屏设备上可以关闭。

## 10. 文案语气

适合的文案：

- 短句。
- 有画面感。
- 允许中英文并置。
- 英文偏诗性，中文偏克制。
- 不做硬销售，不堆功能点。

示例：

- Beauty × Grace × Light
- Moments in Light
- Every frame is a quiet conversation between light and soul.
- 光影之间，捕捉真实的美
- 美，始于你决定做自己的那一刻

## 11. 可复用页面结构

推荐顺序：

1. 固定导航
2. 全屏 Hero
3. About 或品牌叙事
4. Portfolio 瀑布流
5. Quote 情绪停顿
6. Collections 或 Featured 系列
7. Marquee 品牌关键词
8. Contact 或行动入口
9. Footer

## 12. 生成新网页时的提示词模板

可以直接复制下面这段给设计或编码模型：

```text
请按照 MUSE Design Guide 设计一个网页。整体风格是暗色奢华画廊、电影感光影、编辑式留白和金色微光。使用暖黑背景、低饱和真实图片、大号衬线标题、细金色强调线、极小圆角、慢速缓出动效。

页面不要做普通 SaaS 卡片风，也不要用亮白背景、紫蓝渐变或大圆角。Hero 必须使用真实图片全屏铺底，标题居中且有逐行 reveal。图片列表使用瀑布流或大图卡片，hover 时低饱和图片轻微放大并出现底部渐变文字。交互包括滚动 reveal、导航滚动隐藏、lightbox 或沉浸式查看、按钮轻微 magnetic 效果。移动端关闭自定义鼠标并保持文字不溢出。

请使用这些 CSS token：
--bg #0e0c0b, --bg-warm #151210, --surface #1a1714, --fg #f0ece4, --fg-cream #e8e0d4, --muted #8a8078, --accent #c9a96e, --border #2a2520。
标题字体使用 Cormorant Garamond 或 Georgia，正文使用 Instrument Sans，中文使用 Noto Serif SC 或宋体。
```

## 13. 设计检查清单

完成前逐项确认：

- 第一屏是否立刻看出主题，而不是只有导航文字。
- Hero 是否使用真实图片，不是纯渐变或抽象 SVG。
- 金色强调是否克制，没有变成大面积金色。
- 标题是否有衬线字体和足够大的视觉气势。
- section 间距是否足够，不拥挤。
- 图片 hover 是否只做轻微放大和色彩恢复。
- 动效是否慢、顺、优雅。
- 文字是否没有溢出按钮、卡片或窄屏容器。
- 移动端是否关闭自定义鼠标和复杂 hover 依赖。
- 页面是否避免了普通模板感。

