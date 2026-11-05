---
name: Agent Autoloop 每日处理记录
description: 暖纸、深墨、朱红索引的本机只读记录界面
colors:
  paper: "#f4efe4"
  ink: "#2d302e"
  muted: "#65665e"
  accent: "#a94432"
  line: "#ded8cc"
  panel: "#fffdf8"
  selected: "#ebe2d5"
  green: "#3b6251"
  amber: "#785818"
  control-line: "#b8b0a2"
typography:
  display:
    fontFamily: "-apple-system, BlinkMacSystemFont, \"PingFang SC\", \"Microsoft YaHei\", sans-serif"
    fontSize: "29px"
    fontWeight: 650
    lineHeight: 1.25
    letterSpacing: "-.03em"
  title:
    fontFamily: "-apple-system, BlinkMacSystemFont, \"PingFang SC\", \"Microsoft YaHei\", sans-serif"
    fontSize: "22px"
    fontWeight: 650
    lineHeight: 1.4
    letterSpacing: "-.02em"
  section:
    fontFamily: "-apple-system, BlinkMacSystemFont, \"PingFang SC\", \"Microsoft YaHei\", sans-serif"
    fontSize: "17px"
    fontWeight: 650
    lineHeight: 1.6
  metric:
    fontFamily: "-apple-system, BlinkMacSystemFont, \"PingFang SC\", \"Microsoft YaHei\", sans-serif"
    fontSize: "18px"
    fontWeight: 550
    lineHeight: 1.6
  body:
    fontFamily: "-apple-system, BlinkMacSystemFont, \"PingFang SC\", \"Microsoft YaHei\", sans-serif"
    fontSize: "14px"
    fontWeight: 400
    lineHeight: 1.6
  prose:
    fontFamily: "-apple-system, BlinkMacSystemFont, \"PingFang SC\", \"Microsoft YaHei\", sans-serif"
    fontSize: "13px"
    fontWeight: 400
    lineHeight: 1.75
  label:
    fontFamily: "-apple-system, BlinkMacSystemFont, \"PingFang SC\", \"Microsoft YaHei\", sans-serif"
    fontSize: "12px"
    fontWeight: 400
    lineHeight: 1.6
  micro:
    fontFamily: "-apple-system, BlinkMacSystemFont, \"PingFang SC\", \"Microsoft YaHei\", sans-serif"
    fontSize: "11px"
    fontWeight: 400
    lineHeight: 1.6
rounded:
  flat: "0"
  control: "5px"
  detail: "6px"
spacing:
  step-6: "6px"
  step-8: "8px"
  step-10: "10px"
  step-12: "12px"
  step-14: "14px"
  step-16: "16px"
  step-18: "18px"
  step-20: "20px"
  step-24: "24px"
  step-28: "28px"
components:
  button-standard:
    textColor: "{colors.ink}"
    rounded: "{rounded.control}"
    padding: "7px 12px"
  button-primary:
    backgroundColor: "{colors.ink}"
    textColor: "{colors.panel}"
    rounded: "{rounded.control}"
    padding: "7px 12px"
  button-quiet:
    textColor: "{colors.muted}"
    rounded: "{rounded.control}"
    padding: "7px 12px"
  filter-field:
    backgroundColor: "{colors.panel}"
    textColor: "{colors.ink}"
    rounded: "{rounded.control}"
    padding: "5px 8px"
  date-field:
    backgroundColor: "{colors.panel}"
    rounded: "{rounded.control}"
    padding: "5px 9px"
    width: "158px"
  record-selected:
    backgroundColor: "{colors.selected}"
    textColor: "{colors.ink}"
    rounded: "{rounded.control}"
    padding: "13px 14px"
    width: "100%"
  detail-panel:
    backgroundColor: "{colors.panel}"
    textColor: "{colors.ink}"
    rounded: "{rounded.detail}"
    padding: "22px 24px"
  timeline:
    textColor: "{colors.ink}"
    typography: "{typography.label}"
  disclosure:
    padding: "12px 0"
    typography: "{typography.label}"
---
# Design System: Agent Autoloop 每日处理记录

## Overview

**Creative North Star: "结果与依据并读"**

这份系统记录独立的每日处理记录插件，不是中台内核的界面规范。它沿用已选 sketch/2 的暖纸、深墨、朱红索引与标准网页控件，以中文事实、稳定列位和细线组织信息。

这是用于查阅和核对的界面：文字密度紧凑，标题、结论、状态和数字有清楚的层次；材料保持平面，识别依靠排印与选中对应关系。所有值均取自已实现的原生 HTML、CSS、JavaScript，确认方向见 PRODUCT.md 与 docs/daily-overview-surface.md。

**Key Characteristics:**

- 暖纸页面与浅色依据面板，深墨承载主体内容。
- 系统中文字体、按列对齐的数字、标准日期与筛选控件。
- 细线分组，选中背景和朱红对应线标明阅读关系。

## Colors

暖纸和深墨形成阅读底座，朱红承担对应标记；状态色低调且有文字陪伴。颜色值以前置 tokens 为准。

### Primary

- **朱红索引（accent）**：选中行到依据的连线、记录编号、来源链接、键盘焦点，以及等待本人、停止中和结果待确认的状态。

### Secondary

- **状态绿（green）**：执行结束、无事可做的状态文字。
- **状态赭黄（amber）**：等待重试、等待复查的状态文字。

### Neutral

- **暖纸（paper）**：页面背景；**浅纸（panel）**：依据面板、日期与筛选字段。
- **深墨（ink）**：主体文字与主要按钮；**次墨（muted）**：说明、时间、辅助状态。
- **纸线（line）**：区域与记录分隔；**控件线（control-line）**：表单边界与滚动条。
- **选中纸（selected）**：选中记录与按钮悬停背景。

**The 文字与颜色并行 Rule.** 状态始终保留中文名称；朱红、绿和赭黄辅助辨认，不替代文字。

## Typography

**Display Font / Body Font:** 系统无衬线字体栈，中文优先使用系统可用的苹方或微软雅黑。没有外载字体和独立装饰展示字体。

**Character:** 靠字号与字重区分层级，不靠装饰性字形。前置 typography 记录实际角色；同一字体栈贯穿标题、正文和控件。

### Hierarchy

- **Display**：页面标题；窄窗口改用（26px）。
- **Title**：事情详情标题；窄窗口改用（21px）。
- **Section**：记录分组；品牌文字也使用相同字号和字重，但字距为（-.02em）。
- **Metric**：详情双耗时数字，使用等宽数字；窄窗口为（17px）。
- **Body**：记录标题和基础控件；记录标题使用（600）字重。
- **Prose**：回执正文，行宽上限（70ch），保留换行；相同字号也用于说明和详情小标题，小标题加重。
- **Label / Micro**：状态、过程文字、元资料和列头。时间线时间及进行中附注局部使用（10px）。

**The 数字同列 Rule.** 日期、时间和耗时使用等宽数字特性；列内对齐保持可比较。

## Layout

页面横向留白为（3vw）；小于等于（560px）时改为（20px）。页首、日期导航、筛选和同步信息均使用标准文档布局，不放入浮层。常用间距来自前置 spacing；它记录已重复使用的尺寸，不要求页面套用单一等比尺度。

当前每日记录桌面视图以（1.65fr / 1fr）分栏，依据列最小宽（340px），栏间距（28px）。记录行对齐为一列自适应文字，加（88px / 80px / 82px）的状态与双耗时列。小于等于（1150px）时收紧到（1.4fr / 1fr）与（20px）间距，数字列也相应收紧。

小于等于（940px）时改为上下文档流，依据面板不再 sticky，显示“返回所选记录”。小于等于（560px）时筛选与搜索换行，隐藏列头，记录改成两列，双耗时带文字标签，事情标题允许完整换行。此处描述现有表面行为，不把某个页面的六四布局当成所有未来页面的固定模板。

## Elevation & Depth

无阴影。页面底色、面板底色、细线边界及选中背景建立层次。依据面板使用稍深的边框（#cfc4b4），时间线节点使用灰绿色轮廓（#8d9385）；这两项为局部细节，不扩充通用颜色尺度。

**The 平面分层 Rule.** 容器通过底色、边框和分隔线形成层次，不使用阴影。

## Shapes

标准控件和选中行使用轻圆角；依据面板圆角稍大。普通记录行保持平直边界，按底部细线分隔。边框通常为（1px）；时间线节点为（6px）圆点。没有图片、纸张纹理或装饰性图形素材；搜索标记使用内联 SVG。

## Components

### Buttons

标准按钮透明底、控件线边框，最小高度（38px）。主要按钮用深墨底浅纸字；悬停改为（#454a45）。安静按钮省去可见边框、使用次墨文字；悬停回到深墨并出现选中纸底色。通用背景过渡为（140ms ease-out）。禁用时次墨、透明度（.55）；主要按钮的底色仍沿用主要变体。所有可交互元素的焦点用朱红（2px）描边和（4px）偏移。

### Inputs / Fields

日期、规则、状态与搜索保留浏览器原生交互；字段浅纸底、细边框、轻圆角。日期最小高度（38px），筛选与搜索为（36px）。搜索宽度（256px），左侧为内联搜索 SVG；窄窗口改为全宽。光标使用朱红，placeholder 使用次墨且不额外降低不透明度。

### Navigation

日期导航按前一天、日期、后一天、今天顺序横向排列，间距（8px），窄窗口为（6px）。今天使用主要按钮；不可前进的日期与当前今天按钮通过原生 disabled 状态表达。

### Record rows

每件事情是完整宽度的按钮，包含标题、规则、回执、文字状态与双耗时。桌面标题和回执单行截断，完整内容可在依据面板读取，原文亦保留为 title 提示。选中时使用选中纸底、轻圆角和朱红细线指向依据；同一事情出现在两个组时，两个对应记录都显示选中。以 aria-pressed 表达选择。

### Cards / Containers

依据面板是唯一主要浅色容器，承载记录编号、状态、完整标题、双耗时、回执和处理过程。桌面为 sticky，距视口顶（20px），最大高度为（100vh - 40px），内容可滚动；窄窗口恢复自然高度。桌面内边距以前置 component token 为准，两个响应档分别改为（20px）及（19px 17px）。

### Timeline and disclosure

处理过程按（78px）时间列、（18px）间距和内容列排列。节点细线相连，最后一项用朱红实点；时间和正文都保留文字。补充依据使用原生 details / summary，顶边细线、逐段展开，展开标题字重（550）。来源链接保持下划线，悬停加粗下划线。

### Feedback and motion

空记录、读取中、筛选无结果和断线各有中文提示；错误提示使用浅红底（#f2e0d6）、暗红字（#7f3327）与红棕边框（#c99b88）。提示文本与控件状态并存，不由颜色单独解释。减少动态效果偏好会关闭过渡和滚动动画。局部反馈值记录在这里，不提升成通用品牌色。

## Do's and Don'ts

### Do:

- Do 使用前述颜色角色、系统字体和原生网页控件。
- Do 为按钮、字段、链接和展开项保留清楚的键盘焦点。
- Do 在窄窗口让标题换行，并将依据面板放回文档流。
- Do 让状态文字与颜色共同表达，并明确未知耗时。

### Don't:

- Don't 用阴影或纸张纹理替代现有细线与底色层次。
- Don't 用图标或颜色替代状态文字。
- Don't 把桌面截断的长标题当成完整内容；详情保留全文与换行。

本次依据：plugins/daily-overview/public/index.html、style.css、app.js；已核对 .impeccable/review/desktop.png、user-1280.png、mobile.png 与 finish-review.md 的 ship 结论。没有将未发现的缺陷或未实现的视觉计划写成系统规则。
