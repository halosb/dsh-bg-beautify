/**
 * dsh-bg-beautify — browser half (settings-page version).
 *
 * A DSH client plugin bundle: calls window.__ModuleLoader__.load({ id, factory })
 * and the factory returns { apply, inject }. Runs inside the Web UI page.
 *
 * Features:
 *  - Live background image + translucent panels, persisted by the plugin's own
 *    host half (GET/POST /bg/settings → config.json) — no DSH source edits.
 *  - A settings page section "背景美化" (Settings → 背景美化): edit the image
 *    (URL / local file upload) and the transparency sliders; changes apply
 *    immediately and survive restarts.
 *  - The section UI follows the DSH settings design language (rows with
 *    border-l2 hairlines, capsule buttons, h32 fields, theme tokens) so it
 *    looks identical to the built-in settings sections (General, Models…).
 */
window.__ModuleLoader__.load({
  id: 'dsh-bg-beautify',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    var react = require('react')

    // ── 默认值（首次运行 / 未设置时的初始外观） ────────────────────────────
    var DEFAULTS = {
      image: '',                 // '' = 无图（只做半透明）
      size: 'cover',             // cover / contain / 具体尺寸
      position: 'center',        // CSS background-position
      fixed: false,              // true = 背景固定；false = 随页面滚动（大图更清晰）
      opacityMain: 0.25,         // 主区 / 聊天区（0 全透 ～ 1 不透）
      opacitySidebar: 0.5,       // 左侧边栏
      opacityCard: 0.7,          // 卡片 / 菜单 / 浮层
      opacityInput: 0.75,        // 输入区
      textColor: 'white',        // 文字颜色：white / black / auto（跟随主题）
      scrim: true,               // 背景纱幕：叠加半透明纱幕增强整体对比
      brandIcon: '',             // 品牌：浏览器图标（favicon），/bg/xxx、外链或 data URI；留空=默认
      welcomeText: '',           // 品牌：空会话欢迎语；留空=默认
      titleSuffix: '',           // 品牌：浏览器标签页标题后缀；留空=默认
      glowEnabled: true,         // 输入框呼吸光晕开关（默认开启）
      glowColor: '#e8a8d0',      // 光晕颜色
      glowSpeed: 2,              // 光晕速度：一个呼吸周期（秒）
      glowCross: true,           // 使用交叉色：主色 ↔ 交叉色交替
      glowCrossColor: '#9ec5ff', // 交叉色
      glowStrength: 0.45,        // 光晕强度 0~1.5
      glowMood: false,           // 心情光晕：AI 状态情绪灯（思考/完成/出错/空闲）
      wePath: '',                // Wallpaper Engine 壁纸库路径（'' = 自动探测）
      wePreview: '',             // 当前 WE 壁纸的预览图 URL（视频壁纸用作 poster）
      weKind: '',                // 当前 WE 壁纸类型：video / image / web / ''（无扩展名媒体 URL 靠它识别）
      videoSpeed: 1,             // 视频壁纸播放速度（0.25～2，1 = 原速）
    }

    // ── Section UI stylesheet (DSH design language, theme tokens only) ──────
    var SECTION_CSS = [
      '.dsh-bgb-section{display:flex;flex-direction:column;gap:4px;max-width:720px;color:var(--dsw-alias-label-primary);}',
      '.dsh-bgb-title{margin:0;font-size:16px;line-height:24px;font-weight:500;color:var(--dsw-alias-label-primary);}',
      '.dsh-bgb-intro{margin:0 0 4px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary);}',
      // One setting row: label column left, control right (General-section rhythm).
      '.dsh-bgb-row{display:flex;align-items:center;justify-content:space-between;gap:16px;padding:16px 0;border-bottom:1px solid var(--dsw-alias-border-l2);}',
      '.dsh-bgb-row:last-child{border-bottom:none;}',
      '.dsh-bgb-rowLabel{flex:1;min-width:0;display:flex;flex-direction:column;gap:2px;padding-right:24px;}',
      '.dsh-bgb-rowTitle{font-size:14px;line-height:22px;font-weight:400;color:var(--dsw-alias-label-primary);}',
      '.dsh-bgb-caption{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary);}',
      '.dsh-bgb-control{flex:none;display:flex;align-items:center;gap:10px;}',
      // Field (text input / select), mirroring the Models editor's .input.
      '.dsh-bgb-input{box-sizing:border-box;width:100%;height:32px;padding:0 10px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;font:inherit;font-size:14px;line-height:22px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);}',
      '.dsh-bgb-input:focus{outline:none;border-color:var(--dsw-alias-brand-primary);}',
      '.dsh-bgb-input::placeholder{color:var(--dsw-alias-label-dimmed);}',
      '.dsh-bgb-inputField{width:100%;max-width:320px;}',
      '.dsh-bgb-inputShort{width:120px;}',
      // Select with the shared chevron (12px, #81858C — caption gray in both themes).
      '.dsh-bgb-select{appearance:none;-webkit-appearance:none;padding-right:32px;max-width:220px;cursor:pointer;background-image:url("data:image/svg+xml,%3Csvg xmlns=%27http://www.w3.org/2000/svg%27 width=%2712%27 height=%2712%27 viewBox=%270 0 12 12%27 fill=%27none%27%3E%3Cpath d=%27M3 4.5L6 7.5L9 4.5%27 stroke=%27%2381858C%27 stroke-width=%271.5%27 stroke-linecap=%27round%27 stroke-linejoin=%27round%27/%3E%3C/svg%3E");background-repeat:no-repeat;background-position:right 12px center;background-size:12px 12px;}',
      // Capsule buttons (Button primitive: md = h36 r18).
      '.dsh-bgb-button{display:inline-flex;align-items:center;justify-content:center;gap:4px;height:36px;padding:0 14px;border:none;border-radius:18px;background:transparent;cursor:pointer;font:inherit;font-size:14px;line-height:22px;color:var(--dsw-alias-label-primary);}',
      '.dsh-bgb-button:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);}',
      '.dsh-bgb-button:active:not(:disabled){background:var(--dsw-alias-interactive-bg-active);}',
      '.dsh-bgb-button:disabled{cursor:not-allowed;opacity:0.4;}',
      '.dsh-bgb-buttonPrimary{background:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-label-primary-foreground);}',
      '.dsh-bgb-buttonPrimary:hover:not(:disabled){background:var(--dsw-alias-button-primary-hover);}',
      // Hidden file input inside a styled label → the label reads as a button.
      '.dsh-bgb-file{display:none;}',
      // Native range + checkbox themed with the brand accent (both themes).
      '.dsh-bgb-range{flex:1;min-width:140px;accent-color:var(--dsw-alias-state-business-primary);cursor:pointer;}',
      '.dsh-bgb-check{width:16px;height:16px;accent-color:var(--dsw-alias-state-business-primary);cursor:pointer;}',
      '.dsh-bgb-value{flex:none;width:38px;text-align:right;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums;}',
      '.dsh-bgb-checkText{font-size:14px;line-height:22px;color:var(--dsw-alias-label-primary);cursor:pointer;}',
      '.dsh-bgb-color{width:44px;height:28px;padding:0;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:none;cursor:pointer;}',
      // Wallpaper Engine 库：缩略图网格
      '.dsh-bgb-weGrid{display:grid;grid-template-columns:repeat(auto-fill,minmax(132px,1fr));gap:10px;padding:4px 0 12px;}',
      '.dsh-bgb-weItem{border:1px solid var(--dsw-alias-border-l2);border-radius:10px;overflow:hidden;cursor:pointer;background:var(--dsw-alias-bg-layer-1);display:flex;flex-direction:column;gap:4px;padding:6px;text-align:left;}',
      '.dsh-bgb-weItem:hover{border-color:var(--dsw-alias-brand-primary);}',
      '.dsh-bgb-weSelected{outline:2px solid var(--dsw-alias-brand-primary);border-color:transparent;}',
      '.dsh-bgb-weScene{border-style:dashed;opacity:0.8;cursor:pointer;}',
      '.dsh-bgb-weScene:hover{border-color:var(--dsw-alias-brand-primary);opacity:1;background:var(--dsw-alias-interactive-bg-hover);}',
      '.dsh-bgb-weImg{width:100%;aspect-ratio:16/9;object-fit:cover;border-radius:6px;background:var(--dsw-alias-bg-layer-2);}',
      '.dsh-bgb-weNoPreview{display:flex;align-items:center;justify-content:center;font-size:18px;}',
      '.dsh-bgb-weTitle{font-size:12px;line-height:16px;color:var(--dsw-alias-label-primary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}',
      '.dsh-bgb-weBadge{font-size:11px;line-height:14px;color:var(--dsw-alias-label-tertiary);}',
      // 分区标签菜单（对齐 DSH 设置页"菜单→设置项"的交互）
      '.dsh-bgb-current{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary);padding:2px 0 10px;}',
      '.dsh-bgb-tabs{display:flex;flex-wrap:wrap;gap:6px;padding:0 0 14px;border-bottom:1px solid var(--dsw-alias-border-l2);}',
      '.dsh-bgb-tab{height:28px;padding:0 14px;border:1px solid var(--dsw-alias-border-l2);border-radius:14px;background:transparent;cursor:pointer;font:inherit;font-size:13px;line-height:26px;color:var(--dsw-alias-label-secondary);}',
      '.dsh-bgb-tab:hover{border-color:var(--dsw-alias-brand-primary);}',
      '.dsh-bgb-tabActive{background:var(--dsw-alias-button-primary-fill);border-color:transparent;color:var(--dsw-alias-label-primary-foreground);}',
      '.dsh-bgb-tabBody{padding-top:4px;}',
      '.dsh-bgb-progress{flex:1;min-width:140px;height:6px;border-radius:3px;background:var(--dsw-alias-bg-layer-2);overflow:hidden;}',
      '.dsh-bgb-progressFill{height:100%;background:var(--dsw-alias-state-business-primary);transition:width .3s ease;}',
    ].join('\n')

    /** Tiny observable store shared by apply() and the settings component. */
    function createStore(initial) {
      var value = initial
      var listeners = []
      return {
        get: function () { return value },
        set: function (next) {
          value = next
          for (var i = 0; i < listeners.length; i++) listeners[i]()
        },
        subscribe: function (listener) {
          listeners.push(listener)
          return function () {
            var at = listeners.indexOf(listener)
            if (at !== -1) listeners.splice(at, 1)
          }
        },
      }
    }

    /** A URL that points at a playable video file (mp4/webm/m4v/mov). */
    function isVideoUrl(value) {
      return typeof value === 'string' && /\.(mp4|webm|m4v|mov)([?#]|$)/i.test(value)
    }

    /**
     * 当前背景是否为视频：带视频扩展名的 URL，或 WE 壁纸（/bg/we/media/…
     * 本身无扩展名）且类型为 video。weKind 只在 WE 媒体 URL 上生效，避免
     * 手动改图后残留的 weKind 误判。
     */
    function isVideoBg(s) {
      if (s.image === '') return false
      if (isVideoUrl(s.image)) return true
      return s.weKind === 'video' && /^\/bg\/we\/media\//.test(s.image)
    }

    /** 当前背景是否为 web 型壁纸（沙箱 iframe 渲染）。 */
    function isWebBg(s) {
      if (s.image === '') return false
      return s.weKind === 'web' && /^\/bg\/we\/web\//.test(s.image)
    }

    /** 当前背景的人类可读标签（背景来源天然互斥，这里集中展示）。 */
    function currentBgLabel(s) {
      if (s.image === '') return '无背景（仅半透明面板）'
      if (isWebBg(s)) return '网页型壁纸（沙箱 iframe）'
      if (isVideoBg(s)) return '视频壁纸' + (Number(s.videoSpeed) !== 1 ? '（' + Number(s.videoSpeed).toFixed(2) + '×）' : '')
      if (/^\/bg\/we\/media\//.test(s.image)) return 'WE 壁纸'
      if (/^\/bg\/conv\//.test(s.image)) return '已转换视频'
      if (/^\/bg\//.test(s.image)) return '插件图片'
      return '自定义图片/链接'
    }

    /** The <style> text for one settings object (page background). */
    function buildCss(s) {
      var lines = ['html { background: #0f1115; }', 'body {']
      // 视频/网页壁纸不走 body background-image：<video>/<iframe> 层由插件注入。
      var video = isVideoBg(s)
      var web = isWebBg(s)
      if (s.image !== '' && !video && !web) {
        lines.push('  background-image: url("' + s.image + '");')
        lines.push('  background-position: ' + s.position + ';')
        lines.push('  background-size: ' + s.size + ';')
        lines.push('  background-repeat: no-repeat;')
        if (s.fixed) lines.push('  background-attachment: fixed;')
      }
      lines.push('}')
      // 视频壁纸：固定铺满视口、垫在最底层（body::before 纱幕 z-index 0 在其上）。
      if (video) {
        lines.push('video[data-bgb-video]{position:fixed;top:0;left:0;width:100vw;height:100vh;margin:0;padding:0;border:0;z-index:-1;pointer-events:none;background:#0f1115;}')
      }
      // web 型壁纸：沙箱 iframe 垫底，不挡点击（背景只观赏、不交互）。
      if (web) {
        lines.push('iframe[data-bgb-web]{position:fixed;top:0;left:0;width:100vw;height:100vh;margin:0;padding:0;border:0;z-index:-1;pointer-events:none;background:#0f1115;}')
      }
      // 文字颜色（作用域精确版，仅浅色模式生效；深色模式文字本就浅色、对比良好）：
      // 白/黑只作用于「透明主区」——会话区、欢迎页、输入区欢迎语；
      // 自带底色的子区（消息气泡、输入条、芯片、停靠卡、菜单、浮层）与
      // 侧边栏/详情栏一律恢复主题默认（浅色=黑字），避免白字压在浅色底上看不清。
      // 选择器用稳定的 data-slot 属性，跨构建有效。
      if (s.textColor === 'white' || s.textColor === 'black') {
        var c = s.textColor === 'white' ? '#ffffff' : '#0f1115'
        var c2 = c + 'd9' // 85%
        var c3 = c + '99' // 60%
        // 主区（透明）→ 应用文字颜色
        lines.push(
          'body:not([data-ds-dark-theme]) [data-slot="conversation.session"],'
          + 'body:not([data-ds-dark-theme]) [data-slot="conversation.hero.workspace"],'
          + 'body:not([data-ds-dark-theme]) [data-slot="conversation.hero.agentPreset"],'
          + 'body:not([data-ds-dark-theme]) [class$="_headlineText"]'
          + '{--dsw-alias-label-primary:' + c + ';--dsw-alias-label-secondary:' + c2 + ';--dsw-alias-label-tertiary:' + c3 + ';}'
        )
        // 自带底色的子区 → 恢复浅色主题默认文字色（黑字），避免白字压在浅色底上。
        // 注意：composer 容器本身不进任何作用域——它默认即浅色主题黑字，
        // 提问/审批/计划卡片渲染在 composer 内且自带浅色背景，黑字正好可读；
        // 欢迎语标题由上面的 [class$="_headlineText"] 单独染白。
        lines.push(
          'body:not([data-ds-dark-theme]) [data-slot="conversation.chat.node"],'
          + 'body:not([data-ds-dark-theme]) [data-slot="conversation.composer.bar"],'
          + 'body:not([data-ds-dark-theme]) [data-slot="conversation.input.dock"],'
          + 'body:not([data-ds-dark-theme]) [data-slot="conversation.input.overlay"],'
          + 'body:not([data-ds-dark-theme]) [data-slot="conversation.input.plan"],'
          + 'body:not([data-ds-dark-theme]) [data-slot="conversation.input.left"],'
          + 'body:not([data-ds-dark-theme]) [data-slot="conversation.input.right"],'
          + 'body:not([data-ds-dark-theme]) [data-slot="conversation.input.model"]'
          + '{--dsw-alias-label-primary:var(--dsw-static-neutral-bluish-1000);--dsw-alias-label-secondary:var(--dsw-static-neutral-bluish-700);--dsw-alias-label-tertiary:var(--dsw-static-neutral-bluish-600);}'
        )
      }
      // 背景纱幕：固定一层半透明遮罩盖在背景图之上（不挡点击）。
      if (s.scrim === true) {
        lines.push('body::before{content:"";position:fixed;inset:0;z-index:0;pointer-events:none;}')
        lines.push('body:not([data-ds-dark-theme])::before{background:rgba(255,255,255,0.14);}')
        lines.push('body[data-ds-dark-theme]::before{background:rgba(0,0,0,0.14);}')
      }
      return lines.join('\n')
    }

    /** Theme token overrides (light/dark pairs) for one settings object. */
    function buildTokens(s) {
      var tokens = {
        '--dsw-alias-bg-base': {
          light: 'rgba(255, 255, 255, ' + s.opacityMain + ')',
          dark: 'rgba(21, 21, 23, ' + s.opacityMain + ')',
        },
        '--dsw-specific-sidebar-fill': {
          light: 'rgba(249, 250, 251, ' + s.opacitySidebar + ')',
          dark: 'rgba(27, 27, 28, ' + s.opacitySidebar + ')',
        },
        '--dsw-alias-bg-layer-1': {
          light: 'rgba(255, 255, 255, ' + s.opacityCard + ')',
          dark: 'rgba(35, 35, 36, ' + s.opacityCard + ')',
        },
        '--dsw-alias-bg-layer-2': {
          light: 'rgba(255, 255, 255, ' + s.opacityCard + ')',
          dark: 'rgba(44, 44, 46, ' + s.opacityCard + ')',
        },
        '--dsw-alias-bg-layer-3': {
          light: 'rgba(255, 255, 255, ' + s.opacityCard + ')',
          dark: 'rgba(53, 54, 56, ' + s.opacityCard + ')',
        },
        '--dsw-specific-menu': {
          light: 'rgba(255, 255, 255, ' + s.opacityCard + ')',
          dark: 'rgba(44, 44, 46, ' + s.opacityCard + ')',
        },
        '--dsw-specific-input-major': {
          light: 'rgba(255, 255, 255, ' + s.opacityInput + ')',
          dark: 'rgba(44, 44, 46, ' + s.opacityInput + ')',
        },
      }
      return tokens
    }

    /** #rrggbb → rgba(r,g,b,a)；非法值回退默认粉色。 */
    function hexToRgba(hex, alpha) {
      var h = String(hex).replace('#', '')
      if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2]
      var n = parseInt(h, 16)
      var a = Math.round(alpha * 1000) / 1000
      if (isNaN(n) || h.length !== 6) return 'rgba(232,168,208,' + a + ')'
      return 'rgba(' + ((n >> 16) & 255) + ',' + ((n >> 8) & 255) + ',' + (n & 255) + ',' + a + ')'
    }

    /** 输入框呼吸光晕：整圈均匀弥散软光呼吸（demo 同款），
     * 四周整圈彩色柔光按 abab… 铺满、顺时针匀速流转——在光晕背后叠一层
     * 贴周旋转色晕（conic 8 段 ABAB 软交替，透明度清晰、模糊适中），
     * 颜色随呼吸同周期互换；无任何光点/灯带/线条/硬边，只有朦胧的光。 */
    function buildGlowCss(s) {
      if (s.glowEnabled !== true) return ''
      var strength = Math.min(1.5, Math.max(0, s.glowStrength))
      var speed = Number(s.glowSpeed)
      if (!isFinite(speed) || speed <= 0) speed = 1.8
      speed = Math.min(10, Math.max(0.3, speed))
      var bSmall = Math.round(6 + strength * 5)
      var sSmall = Math.round(2 + strength * 2.5)
      var bBig = Math.round(10 + strength * 11)
      var sBig = Math.round(4 + strength * 5.5)
      // 色晕外扩/模糊随强度缩放：强度 0 ≈16px 贴周，强度上限 1.5 ≈43px
      var washInset = Math.round(16 + strength * 18)
      var washBlur = Math.round(6 + strength * 4)
      var washRadius = 22 + washInset
      var alpha = Math.min(1, 0.5 + strength * 0.32)
      var mainC = hexToRgba(s.glowColor, alpha)
      var crossC = s.glowCross === true ? hexToRgba(s.glowCrossColor, alpha) : mainC
      // ── 心情光晕模式：AI 状态情绪灯 ──────────────────────────────────
      // 思考中=柔蓝慢呼吸 / 完成=金色一闪 / 出错=暖红缓闪 / 空闲=微微星光。
      // 只保留呼吸光晕（单一情绪色），关闭旋转色晕；颜色由 data-bgb-mood 决定。
      if (s.glowMood === true) {
        var idleDur = Math.min(6, Math.max(2, speed * 2.2)).toFixed(1)
        var thinkDur = Math.min(5, Math.max(1.2, speed * 1.5)).toFixed(1)
        var errorDur = Math.max(0.8, speed * 0.6).toFixed(1)
        return [
          '[data-composer-card]{--dsh-bgb-c:rgba(205,195,255,0.38);--dsh-bgb-cd:rgba(205,195,255,0.38);animation:dsh-bgb-breathe ' + speed + 's linear infinite;}',
          '@keyframes dsh-bgb-breathe{0%{box-shadow:0 0 ' + bSmall + 'px ' + sSmall + 'px var(--dsh-bgb-c);}50%{box-shadow:0 0 ' + bBig + 'px ' + sBig + 'px var(--dsh-bgb-c);}100%{box-shadow:0 0 ' + bSmall + 'px ' + sSmall + 'px var(--dsh-bgb-c);}}',
          '[data-composer-card]::before{display:none;}',
          // 空闲：微微星光（极淡、慢呼吸）
          '[data-composer-card][data-bgb-mood="idle"]{--dsh-bgb-c:rgba(205,195,255,0.38);animation-duration:' + idleDur + 's;}',
          // 思考中：柔蓝慢呼吸
          '[data-composer-card][data-bgb-mood="thinking"]{--dsh-bgb-c:rgba(122,162,255,0.72);animation-duration:' + thinkDur + 's;}',
          // 出错：暖红缓闪
          '[data-composer-card][data-bgb-mood="error"]{--dsh-bgb-c:rgba(255,107,107,0.8);animation:dsh-bgb-error ' + errorDur + 's ease-in-out infinite;}',
          '@keyframes dsh-bgb-error{0%,100%{box-shadow:0 0 ' + bBig + 'px ' + sBig + 'px var(--dsh-bgb-c);}50%{box-shadow:0 0 8px 2px rgba(255,107,107,0.25);}}',
          // 完成：金色一闪（一次性，随后由 JS 复位到空闲）
          '[data-composer-card][data-bgb-mood="done"]{--dsh-bgb-c:rgba(255,215,106,0.95);animation:dsh-bgb-done 0.9s ease-out 1 forwards;}',
          '@keyframes dsh-bgb-done{0%{box-shadow:0 0 ' + bBig + 'px ' + sBig + 'px var(--dsh-bgb-c);}100%{box-shadow:0 0 6px 2px rgba(255,215,106,0);}}',
          '@media (prefers-reduced-motion: reduce){[data-composer-card]{animation:none;}}',
        ].join('\n')
      }
      return [
        // 共享变色变量（inherits:true，色晕继承同款变色；c 与 cd 相位相反）
        '@property --dsh-bgb-c{syntax:"<color>";inherits:true;initial-value:' + mainC + ';}',
        '@property --dsh-bgb-cd{syntax:"<color>";inherits:true;initial-value:' + crossC + ';}',
        '@property --dsh-bgb-angle{syntax:"<angle>";inherits:false;initial-value:0deg;}',
        // 呼吸光晕（主导）：整圈均匀 box-shadow，尺寸+颜色同周期线性
        '[data-composer-card]{animation:dsh-bgb-breathe ' + speed + 's linear infinite,dsh-bgb-colorcycle ' + speed + 's linear infinite,dsh-bgb-colorcycle2 ' + speed + 's linear infinite;}',
        '@keyframes dsh-bgb-breathe{0%{box-shadow:0 0 ' + bSmall + 'px ' + sSmall + 'px var(--dsh-bgb-c);}50%{box-shadow:0 0 ' + bBig + 'px ' + sBig + 'px var(--dsh-bgb-c);}100%{box-shadow:0 0 ' + bSmall + 'px ' + sSmall + 'px var(--dsh-bgb-c);}}',
        '@keyframes dsh-bgb-colorcycle{0%{--dsh-bgb-c:' + mainC + ';}50%{--dsh-bgb-c:' + crossC + ';}100%{--dsh-bgb-c:' + mainC + ';}}',
        '@keyframes dsh-bgb-colorcycle2{0%{--dsh-bgb-cd:' + crossC + ';}50%{--dsh-bgb-cd:' + mainC + ';}100%{--dsh-bgb-cd:' + crossC + ';}}',
        // 四周彩色流转：贴周旋转色晕（8 段 ABAB 软交替、整圈铺满），
        // 盒子形状 = 输入框形状 + 等距外扩 40px（圆角 22+40=62px），
        // 保证上下左右完全同等大小，无十字架式不均匀凸起
        '[data-composer-card]::before{content:"";position:absolute;inset:-' + washInset + 'px;border-radius:' + washRadius + 'px;pointer-events:none;z-index:-1;filter:blur(' + washBlur + 'px);background:conic-gradient(from var(--dsh-bgb-angle),var(--dsh-bgb-c) 0deg,var(--dsh-bgb-cd) 45deg,var(--dsh-bgb-c) 90deg,var(--dsh-bgb-cd) 135deg,var(--dsh-bgb-c) 180deg,var(--dsh-bgb-cd) 225deg,var(--dsh-bgb-c) 270deg,var(--dsh-bgb-cd) 315deg,var(--dsh-bgb-c) 360deg);animation:dsh-bgb-rotate ' + speed + 's linear infinite,dsh-bgb-glowbreathe ' + speed + 's linear infinite;}',
        '@keyframes dsh-bgb-rotate{to{--dsh-bgb-angle:360deg}}',
        '@keyframes dsh-bgb-glowbreathe{0%{opacity:0.45;}50%{opacity:0.7;}100%{opacity:0.45;}}',
        '@media (prefers-reduced-motion: reduce){[data-composer-card]{animation:none;}[data-composer-card]::before{animation:none;}}',
      ].join('\n')
    }

    /** Services this client plugin needs (fiber inject). */
    exports.inject = ['theme', 'slots']

    exports.apply = function (ctx) {
      var store = createStore(Object.assign({}, DEFAULTS))

      // Load persisted settings once; every later change comes from the page.
      fetch('/bg/settings').then(function (r) { return r.json() }).then(function (cfg) {
        store.set(Object.assign({}, DEFAULTS, cfg && typeof cfg === 'object' ? cfg : {}))
      }).catch(function () {})

      // Persist one settings object through the plugin's own host endpoint.
      function persist(cfg) {
        fetch('/bg/settings', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(cfg),
        }).catch(function () {})
      }

      // Section UI stylesheet (design-system classes) — one style tag, removed
      // with the fiber.
      ctx.effect(function () {
        var styleEl = document.createElement('style')
        styleEl.setAttribute('data-plugin-css', 'dsh-bg-beautify-ui')
        styleEl.textContent = SECTION_CSS
        document.head.appendChild(styleEl)
        return function () { styleEl.remove() }
      }, 'dsh-bg-beautify: section ui styles')

      // Live application: rebuild the <style> + theme override whenever the
      // store changes, and tear everything down with the plugin fiber.
      ctx.effect(function () {
        var styleEl = null
        var themeDispose = null
        function refresh() {
          var s = store.get()
          if (styleEl !== null) styleEl.remove()
          styleEl = document.createElement('style')
          styleEl.setAttribute('data-plugin-css', 'dsh-bg-beautify')
          styleEl.textContent = buildCss(s) + '\n' + buildGlowCss(s)
          document.head.appendChild(styleEl)
          if (themeDispose !== null) themeDispose()
          var theme = ctx.get('theme')
          if (theme !== undefined) {
            themeDispose = theme.overrideTokens('dsh-bg-beautify', buildTokens(s))
          } else {
            themeDispose = null
          }
        }
        refresh()
        var off = store.subscribe(function () { refresh() })
        return function () {
          off()
          if (styleEl !== null) styleEl.remove()
          if (themeDispose !== null) themeDispose()
        }
      }, 'dsh-bg-beautify: live apply')

      // 视频壁纸层：<video> 元素随 store 增删/更新（仅背景为视频时存在）。
      // 标签页隐藏或系统"减少动态效果"时暂停（定格在 preview poster），省资源。
      ctx.effect(function () {
        var videoEl = null
        var mq = window.matchMedia !== undefined
          ? window.matchMedia('(prefers-reduced-motion: reduce)')
          : null
        function sync() {
          var s = store.get()
          var want = isVideoBg(s)
          if (!want) {
            if (videoEl !== null) {
              videoEl.pause()
              videoEl.removeAttribute('src')
              videoEl.load()
              videoEl.remove()
              videoEl = null
            }
            return
          }
          if (videoEl === null) {
            videoEl = document.createElement('video')
            videoEl.setAttribute('data-bgb-video', '')
            videoEl.setAttribute('aria-hidden', 'true')
            videoEl.setAttribute('playsinline', '')
            videoEl.muted = true
            videoEl.loop = true
            videoEl.autoplay = true
            videoEl.preload = 'metadata'
            document.body.insertBefore(videoEl, document.body.firstChild)
          }
          if (videoEl.getAttribute('src') !== s.image) {
            videoEl.setAttribute('src', s.image)
            videoEl.load()
          }
          var poster = s.wePreview !== '' ? s.wePreview : ''
          if (videoEl.getAttribute('poster') !== poster) videoEl.setAttribute('poster', poster)
          videoEl.style.objectFit = s.size === 'contain' ? 'contain' : s.size === 'auto' ? 'none' : 'cover'
          videoEl.style.objectPosition = s.position
          videoEl.playbackRate = Number(s.videoSpeed) || 1
          var p = videoEl.play()
          if (p !== undefined && typeof p.catch === 'function') p.catch(function () {})
        }
        function pauseMaybe() {
          if (videoEl === null) return
          if (document.hidden || (mq !== null && mq.matches)) videoEl.pause()
          else {
            var p = videoEl.play()
            if (p !== undefined && typeof p.catch === 'function') p.catch(function () {})
          }
        }
        sync()
        var off = store.subscribe(sync)
        document.addEventListener('visibilitychange', pauseMaybe)
        if (mq !== null) mq.addEventListener('change', pauseMaybe)
        return function () {
          off()
          document.removeEventListener('visibilitychange', pauseMaybe)
          if (mq !== null) mq.removeEventListener('change', pauseMaybe)
          if (videoEl !== null) {
            videoEl.pause()
            videoEl.removeAttribute('src')
            videoEl.load()
            videoEl.remove()
            videoEl = null
          }
        }
      }, 'dsh-bg-beautify: video layer')

      // web 型壁纸层：沙箱 iframe 随 store 增删/更新（仅背景为 web 型时存在）。
      // sandbox 只给 allow-scripts：无同源权限（opaque origin），脚本可跑动画，
      // 但拿不到父页面、读不了 localStorage；pointer-events:none 不抢点击。
      ctx.effect(function () {
        var iframeEl = null
        function sync() {
          var s = store.get()
          var want = isWebBg(s)
          if (!want) {
            if (iframeEl !== null) {
              iframeEl.removeAttribute('src')
              iframeEl.remove()
              iframeEl = null
            }
            return
          }
          if (iframeEl === null) {
            iframeEl = document.createElement('iframe')
            iframeEl.setAttribute('data-bgb-web', '')
            iframeEl.setAttribute('aria-hidden', 'true')
            iframeEl.setAttribute('tabindex', '-1')
            iframeEl.setAttribute('sandbox', 'allow-scripts')
            document.body.insertBefore(iframeEl, document.body.firstChild)
          }
          if (iframeEl.getAttribute('src') !== s.image) iframeEl.setAttribute('src', s.image)
        }
        sync()
        var off = store.subscribe(sync)
        return function () {
          off()
          if (iframeEl !== null) {
            iframeEl.removeAttribute('src')
            iframeEl.remove()
            iframeEl = null
          }
        }
      }, 'dsh-bg-beautify: web layer')

      // 品牌定制：favicon / 欢迎语 / 浏览器标题后缀，随 store 变化即时应用；
      // 用 MutationObserver 兜底外壳重渲染（会话切换、标题投影）后的恢复。
      ctx.effect(function () {
        var originalFavicon = null
        var originalHeadline = null
        var lastSuffix = ''
        var titleObserver = null
        var welcomeObserver = null

        function applyFavicon(s) {
          var link = document.querySelector('link[rel~="icon"]')
          if (s.brandIcon !== '') {
            if (originalFavicon === null && link !== null) originalFavicon = link.getAttribute('href')
            if (link === null) {
              link = document.createElement('link')
              link.rel = 'icon'
              document.head.appendChild(link)
            }
            if (link.getAttribute('href') !== s.brandIcon) link.setAttribute('href', s.brandIcon)
          } else if (originalFavicon !== null && link !== null) {
            if (link.getAttribute('href') !== originalFavicon) link.setAttribute('href', originalFavicon)
          }
        }

        function applyWelcome(s) {
          // CSS Modules 类名 = <hash>_<原始名>，后缀稳定，跨构建可选中。
          var headline = document.querySelector('[class$="_headlineText"]')
          if (headline === null) return
          if (originalHeadline === null) originalHeadline = headline.textContent
          var want = s.welcomeText !== '' ? s.welcomeText : originalHeadline
          if (headline.textContent !== want) headline.textContent = want
        }

        function applyTitle(s) {
          if (s.titleSuffix !== lastSuffix) {
            if (lastSuffix !== '' && document.title.endsWith(' · ' + lastSuffix)) {
              document.title = document.title.slice(0, -(' · ' + lastSuffix).length)
            }
            lastSuffix = s.titleSuffix
          }
          if (s.titleSuffix !== '' && !document.title.endsWith(s.titleSuffix)) {
            document.title = document.title + ' · ' + s.titleSuffix
          }
        }

        function applyAll() {
          var s = store.get()
          applyFavicon(s)
          applyWelcome(s)
          applyTitle(s)
        }

        applyAll()
        var off = store.subscribe(function () { applyAll() })

        // 外壳可能在会话标题变化时重写 document.title，观察并补回后缀。
        var titleEl = document.querySelector('head > title')
        if (titleEl !== null) {
          titleObserver = new MutationObserver(function () {
            var s = store.get()
            if (s.titleSuffix !== '' && !document.title.endsWith(s.titleSuffix)) {
              document.title = document.title + ' · ' + s.titleSuffix
            }
          })
          titleObserver.observe(titleEl, { childList: true, characterData: true, subtree: true })
        }

        // 欢迎语元素会随会话/路由重挂载，观察主列并补应用。
        var column = document.querySelector('[data-slot="conversation"]')
        if (column !== null) {
          welcomeObserver = new MutationObserver(function () {
            applyWelcome(store.get())
          })
          welcomeObserver.observe(column, { childList: true, subtree: true, characterData: true })
        }

        return function () {
          off()
          if (titleObserver !== null) titleObserver.disconnect()
          if (welcomeObserver !== null) welcomeObserver.disconnect()
          // 还原 favicon / 欢迎语 / 标题后缀
          var link = document.querySelector('link[rel~="icon"]')
          if (originalFavicon !== null && link !== null) link.setAttribute('href', originalFavicon)
          var headline = document.querySelector('[class$="_headlineText"]')
          if (originalHeadline !== null && headline !== null && headline.textContent !== originalHeadline) {
            headline.textContent = originalHeadline
          }
          if (lastSuffix !== '' && document.title.endsWith(' · ' + lastSuffix)) {
            document.title = document.title.slice(0, -(' · ' + lastSuffix).length)
          }
        }
      }, 'dsh-bg-beautify: brand')

      // 心情光晕：监听会话状态的 DOM 信号（data-streaming / data-state /
      // data-error）→ 在输入卡上设置 data-bgb-mood（idle/thinking/done/error）。
      // 错误只看"最近 15 秒内新出现"的（历史错误卡片忽略），避免陈旧红光。
      ctx.effect(function () {
        var prev = 'idle'
        var scanTimer = null
        var doneTimer = null
        var observer = null
        var off = null
        var pollTimer = null
        var alive = true
        var lastErrorAt = 0
        function moodOn() {
          var s = store.get()
          return s.glowMood === true && s.glowEnabled === true
        }
        function currentCard() {
          return document.querySelector('[data-composer-card]')
        }
        function setMood(mood) {
          if (!alive || !moodOn()) return
          var card = currentCard()
          if (card === null) return
          var current = card.getAttribute('data-bgb-mood')
          // 仅当属性已存在且相同才算"无变化"；首次/属性缺失时也要写
          if (mood === prev && current === mood) return
          prev = mood
          if (doneTimer !== null) { clearTimeout(doneTimer); doneTimer = null }
          if (mood === 'done') {
            card.setAttribute('data-bgb-mood', 'done')
            doneTimer = setTimeout(function () {
              doneTimer = null
              prev = 'idle'
              if (!alive) return
              var c2 = currentCard()
              if (c2 !== null) c2.setAttribute('data-bgb-mood', 'idle')
            }, 1100)
          } else {
            card.setAttribute('data-bgb-mood', mood)
          }
        }
        function hasLiveActivity(column) {
          return column !== null
            && (column.querySelector('[data-streaming]') !== null
              || column.querySelector('[data-state="running"]') !== null)
        }
        function scan() {
          if (!alive || !moodOn()) return
          var column = document.querySelector('[data-slot="conversation"]')
          if (column === null) { setMood('idle'); return }
          if (hasLiveActivity(column)) { setMood('thinking'); return }
          // 仅当错误在最近 15 秒内"新出现"才显示红色（历史错误卡不算）
          if (Date.now() - lastErrorAt < 15000) { setMood('error'); return }
          if (prev === 'thinking') setMood('done')
          else setMood('idle')
        }
        function onChange(mutations) {
          for (var i = 0; i < mutations.length; i++) {
            var m = mutations[i]
            if (m.type === 'attributes' && m.target !== null && typeof m.target.getAttribute === 'function') {
              if (m.attributeName === 'data-error' && m.target.getAttribute('data-error') !== null) {
                lastErrorAt = Date.now()
              } else if (m.attributeName === 'data-state' && m.target.getAttribute('data-state') === 'error') {
                lastErrorAt = Date.now()
              }
            }
            if (m.type === 'childList' && m.addedNodes !== null) {
              for (var j = 0; j < m.addedNodes.length; j++) {
                var node = m.addedNodes[j]
                if (typeof node.querySelector === 'function'
                  && (node.querySelector('[data-error]') !== null
                    || node.querySelector('[data-state="error"]') !== null)) {
                  lastErrorAt = Date.now()
                }
              }
            }
          }
          if (scanTimer !== null) clearTimeout(scanTimer)
          scanTimer = setTimeout(scan, 120)
        }
        // 观察整棵树；卡片/会话列延迟出现或重挂载时，scan 每次都重新查找
        observer = new MutationObserver(onChange)
        var target = document.body !== null ? document.body : document.documentElement
        observer.observe(target, {
          childList: true,
          subtree: true,
          attributes: true,
          attributeFilter: ['data-streaming', 'data-state', 'data-error'],
        })
        // 兜底轮询：MutationObserver 可能漏掉的状态变化也能跟上
        pollTimer = setInterval(scan, 800)
        scan()
        off = store.subscribe(function () {
          if (moodOn()) { scan() } else {
            var c = currentCard()
            if (c !== null) c.removeAttribute('data-bgb-mood')
            prev = 'idle'
          }
        })
        function cleanup() {
          if (!alive) return
          alive = false
          observer.disconnect()
          if (pollTimer !== null) clearInterval(pollTimer)
          if (scanTimer !== null) clearTimeout(scanTimer)
          if (doneTimer !== null) clearTimeout(doneTimer)
          var c = currentCard()
          if (c !== null) c.removeAttribute('data-bgb-mood')
          if (off !== null) off()
        }
        return cleanup
      }, 'dsh-bg-beautify: mood glow')

      // The settings page section: Settings → 背景美化.
      ctx.slots.inject('settings.section', function () {
        return ctx.slots.register({
          name: 'settings.section',
          id: 'bg-beautify',
          order: 30,
          label: function () { return '背景美化' },
          inject: function () { return { store: store, persist: persist } },
        }, BgBeautifySection)
      })
    }

    // ── settings page UI (DSH settings design language) ──────────────────────

    /** createElement shorthand. */
    function el(type, props) {
      var args = [type, props]
      for (var i = 2; i < arguments.length; i++) args.push(arguments[i])
      return react.createElement.apply(null, args)
    }

    /** One setting row: label column + control column. */
    function Row(props) {
      return el('div', { className: 'dsh-bgb-row' },
        el('div', { className: 'dsh-bgb-rowLabel' },
          el('div', { className: 'dsh-bgb-rowTitle' }, props.title),
          props.caption !== undefined
            ? el('div', { className: 'dsh-bgb-caption' }, props.caption)
            : null,
        ),
        el('div', { className: 'dsh-bgb-control' }, props.children),
      )
    }

    /** One labeled range slider row (min/max/step/format overridable). */
    function SliderRow(props) {
      var min = props.min !== undefined ? props.min : '0'
      var max = props.max !== undefined ? props.max : '1'
      var step = props.step !== undefined ? props.step : '0.05'
      var fmt = props.format !== undefined ? props.format : function (v) { return v.toFixed(2) }
      return el('div', { className: 'dsh-bgb-row' },
        el('div', { className: 'dsh-bgb-rowLabel' },
          el('div', { className: 'dsh-bgb-rowTitle' }, props.label),
          props.caption !== undefined ? el('div', { className: 'dsh-bgb-caption' }, props.caption) : null,
        ),
        el('div', { className: 'dsh-bgb-control', style: { flex: '1' } },
          el('input', {
            type: 'range', min: min, max: max, step: step,
            className: 'dsh-bgb-range', value: String(props.value),
            onChange: function (e) { props.onChange(Number(e.target.value)) },
          }),
          el('span', { className: 'dsh-bgb-value' }, fmt(props.value)),
        ),
      )
    }

    /** The 背景美化 settings section component (owner props + injected store). */
    function BgBeautifySection(props) {
      var store = props.store
      var persist = props.persist
      var tick = react.useState(0)
      react.useEffect(function () {
        return store.subscribe(function () { tick[1](function (n) { return n + 1 }) })
      }, [])
      // Wallpaper Engine 库扫描结果（组件本地状态，不入 store）
      var weState = react.useState({ state: 'idle', library: '', error: '', msg: '', items: [] })
      // 转换视频库列表 + 转换作业状态
      var convState = react.useState({ files: [], loaded: false, job: null, progress: 0, running: false })
      // 分区标签菜单（当前标签）
      var tab = react.useState('背景图')
      react.useEffect(function () { loadConverted() }, [])
      var s = store.get()
      function setField(field, value) {
        var next = Object.assign({}, s)
        next[field] = value
        store.set(next)
        persist(next)
      }
      function scanWe() {
        var path = store.get().wePath
        weState[1]({ state: 'loading', library: '', error: '', msg: '', items: [] })
        fetch('/bg/we/list?path=' + encodeURIComponent(path))
          .then(function (r) { return r.json() })
          .then(function (data) {
            if (data !== null && typeof data === 'object' && Array.isArray(data.wallpapers)) {
              weState[1]({
                state: 'done',
                library: typeof data.library === 'string' ? data.library : '',
                error: '',
                msg: '',
                items: data.wallpapers,
              })
              // 扫描即自动转换：符合条件的场景壁纸由 host 后台转出 mp4/GIF
              if (typeof data.autoJob === 'string') {
                weState[1](Object.assign({}, weState[0], { state: 'done', items: data.wallpapers, msg: '扫描完成，正在自动转换符合条件的场景壁纸…' }))
                pollJob(data.autoJob, false)
              }
            } else {
              weState[1]({ state: 'error', library: '', error: '扫描结果异常', msg: '', items: [] })
            }
          })
          .catch(function () {
            weState[1]({ state: 'error', library: '', error: '扫描请求失败', msg: '', items: [] })
          })
      }
      function pickWe(item) {
        if (!item.supported || item.mediaUrl === '') return
        // 一次原子更新（image/wePreview/weKind 同时写入）：
        // 连续两次 setField 会基于同一个旧值构建对象、互相覆盖。
        var cur = store.get()
        var next = Object.assign({}, cur)
        if (cur.image === item.mediaUrl) {
          next.image = ''
          next.wePreview = ''
          next.weKind = ''
        } else {
          next.image = item.mediaUrl
          next.wePreview = item.previewUrl
          next.weKind = item.type
        }
        store.set(next)
        persist(next)
      }

      // 场景/视频流型（不支持直接渲染）：点击立刻用预览图生效（即时反馈），
      // 同时在后台尝试其 Workshop 公开预览视频，成功自动升级为动态背景。
      function pickUnsupported(item) {
        if (item.supported) return
        var preview = item.previewUrl
        var next = Object.assign({}, store.get())
        next.image = preview !== '' ? preview : ''
        next.wePreview = ''
        next.weKind = ''
        store.set(next)
        persist(next)
        weState[1](Object.assign({}, weState[0], { msg: preview !== '' ? '已用预览图，正在尝试公开预览视频…' : '正在尝试公开预览视频…' }))
        if (preview === '') return
        fetch('/bg/we/video/' + encodeURIComponent(item.id))
          .then(function (r) { return r.json() })
          .then(function (data) {
            if (data !== null && typeof data === 'object' && data.ok === true
              && typeof data.url === 'string' && data.url !== '') {
              var n2 = Object.assign({}, store.get())
              n2.image = data.url
              n2.wePreview = preview
              n2.weKind = ''
              store.set(n2)
              persist(n2)
              weState[1](Object.assign({}, weState[0], { msg: '已升级为公开预览视频' }))
            } else {
              weState[1](Object.assign({}, weState[0], {
                msg: (data !== null && typeof data === 'object' && typeof data.message === 'string'
                  ? data.message : '未找到预览视频') + '，已用预览图',
              }))
            }
          })
          .catch(function () {
            weState[1](Object.assign({}, weState[0], { msg: '获取预览失败，已用预览图' }))
          })
      }

      // 转换视频库：刷新列表 / 打开文件夹 / 转换作业（进度轮询）
      function loadConverted() {
        fetch('/bg/we/converted')
          .then(function (r) { return r.json() })
          .then(function (data) {
            if (data !== null && typeof data === 'object' && Array.isArray(data.files)) {
              convState[1]({ files: data.files, loaded: true })
            }
          })
          .catch(function () {})
      }
      function openFolder() {
        fetch('/bg/we/openfolder', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({}),
        }).catch(function () {})
      }
      function convertWe(item) {
        var w = weState[0]
        weState[1](Object.assign({}, w, { msg: '正在转换「' + item.title + '」…' }))
        convState[1](Object.assign({}, convState[0], { job: null, progress: 0, running: true }))
        fetch('/bg/we/convert', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ id: item.id }),
        })
          .then(function (r) { return r.json() })
          .then(function (data) {
            if (data !== null && typeof data === 'object' && data.ok === true && typeof data.job === 'string') {
              pollJob(data.job)
            } else {
              convState[1](Object.assign({}, convState[0], { running: false }))
              weState[1](Object.assign({}, weState[0], {
                msg: (data !== null && typeof data === 'object' && typeof data.message === 'string')
                  ? data.message : '转换请求失败',
              }))
            }
          })
          .catch(function () {
            convState[1](Object.assign({}, convState[0], { running: false }))
            weState[1](Object.assign({}, weState[0], { msg: '转换请求失败' }))
          })
      }
      function pollJob(jobId, applyFirst) {
        var apply = applyFirst !== false // 手动转换默认自动应用首个产物；自动转换不应用
        fetch('/bg/we/job?id=' + encodeURIComponent(jobId))
          .then(function (r) { return r.json() })
          .then(function (job) {
            if (job === null || typeof job !== 'object') return
            if (job.state === 'done') {
              convState[1](Object.assign({}, convState[0], { job: null, progress: 100, running: false }))
              weState[1](Object.assign({}, weState[0], { msg: job.message || '转换完成' }))
              if (apply && Array.isArray(job.files) && job.files.length > 0) {
                var f = job.files[0]
                var next = Object.assign({}, store.get())
                next.image = f.url
                next.wePreview = ''
                next.weKind = ''
                store.set(next)
                persist(next)
              }
              loadConverted()
              return
            }
            if (job.state === 'error') {
              convState[1](Object.assign({}, convState[0], { job: null, running: false }))
              weState[1](Object.assign({}, weState[0], { msg: job.message || '转换失败' }))
              return
            }
            // running：更新进度继续轮询
            convState[1](Object.assign({}, convState[0], {
              job: jobId,
              progress: typeof job.progress === 'number' ? job.progress : 0,
              running: true,
            }))
            if (job.message !== undefined) weState[1](Object.assign({}, weState[0], { msg: job.message }))
            setTimeout(function () { pollJob(jobId, apply) }, 400)
          })
          .catch(function () {
            convState[1](Object.assign({}, convState[0], { job: null, running: false }))
            weState[1](Object.assign({}, weState[0], { msg: '进度查询失败' }))
          })
      }
      function pickConverted(f) {
        var next = Object.assign({}, store.get())
        if (next.image === f.url) {
          next.image = ''
          next.wePreview = ''
          next.weKind = ''
        } else {
          next.image = f.url
          next.wePreview = ''
          next.weKind = ''
        }
        store.set(next)
        persist(next)
      }
      function typeLabel(t) {
        var map = { video: '视频', image: '图片', scene: '场景', web: '网页', videostream: '视频流', other: '其他', unknown: '未知' }
        return map[t] !== undefined ? map[t] : t
      }
      function resetAll() {
        // 重置透明度与光晕设置到出厂值；背景图、尺寸、位置、固定保持不变。
        var next = Object.assign({}, s)
        next.opacityMain = DEFAULTS.opacityMain
        next.opacitySidebar = DEFAULTS.opacitySidebar
        next.opacityCard = DEFAULTS.opacityCard
        next.opacityInput = DEFAULTS.opacityInput
        next.glowEnabled = DEFAULTS.glowEnabled
        next.glowColor = DEFAULTS.glowColor
        next.glowSpeed = DEFAULTS.glowSpeed
        next.glowCross = DEFAULTS.glowCross
        next.glowCrossColor = DEFAULTS.glowCrossColor
        next.glowStrength = DEFAULTS.glowStrength
        store.set(next)
        persist(next)
      }
      function onUpload(e) {
        var file = e.target.files !== null ? e.target.files[0] : undefined
        if (file === undefined) return
        var reader = new FileReader()
        reader.onload = function () {
          fetch('/bg/upload', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ name: file.name, data: String(reader.result) }),
          }).then(function (r) { return r.json() }).then(function (json) {
            if (json !== null && typeof json === 'object' && typeof json.url === 'string') {
              setField('image', json.url)
            }
          }).catch(function () {})
        }
        reader.readAsDataURL(file)
      }
      return el('div', { className: 'dsh-bgb-section' },
        el('h2', { className: 'dsh-bgb-title' }, '背景美化'),
        el('p', { className: 'dsh-bgb-intro' }, '背景、WE 壁纸、光晕与品牌定制，改动即时生效并自动保存。'),
        el('div', { className: 'dsh-bgb-current' }, '当前背景：' + currentBgLabel(s)),
        el('div', { className: 'dsh-bgb-tabs' },
          ['背景图', 'WE 壁纸', '转换视频', '光晕', '品牌定制'].map(function (t) {
            return el('button', {
              key: t,
              type: 'button',
              className: 'dsh-bgb-tab' + (tab[0] === t ? ' dsh-bgb-tabActive' : ''),
              onClick: function () { tab[1](t) },
            }, t)
          }),
        ),
        tab[0] === '背景图'
          ? el('div', { className: 'dsh-bgb-tabBody' },
        Row({
          title: '背景图',
          caption: '支持 /bg/文件名、https:// 外链、data: URI、.mp4/.webm 视频；留空表示不显示图片。',
          children: el('input', {
            type: 'text', className: 'dsh-bgb-input dsh-bgb-inputField',
            value: s.image, placeholder: '/bg/xxx.png',
            onChange: function (e) { setField('image', e.target.value) },
          }),
        }),
        Row({
          title: '从本地选择图片',
          caption: '上传到插件 assets 目录，自动填入 /bg/文件名（大图推荐）。',
          children: el('label', { className: 'dsh-bgb-button', style: { cursor: 'pointer' } },
            el('input', { type: 'file', accept: 'image/*', className: 'dsh-bgb-file', onChange: onUpload }),
            '选择图片…',
          ),
        }),
          )
          : null,
        tab[0] === 'WE 壁纸'
          ? el('div', { className: 'dsh-bgb-tabBody' },
        Row({
          title: '扫描壁纸库',
          caption: weState[0].state === 'loading'
            ? '正在扫描…'
            : (weState[0].library !== ''
                ? '已找到：' + weState[0].library
                : '自动探测 Steam 库并列出可用壁纸；点选即设为背景。'),
          children: el('button', {
            type: 'button', className: 'dsh-bgb-button dsh-bgb-buttonPrimary',
            disabled: weState[0].state === 'loading', onClick: scanWe,
          }, weState[0].state === 'loading' ? '扫描中…' : '扫描'),
        }),
        Row({
          title: '壁纸库路径（可选）',
          caption: '自动探测失败时手动填写：壁纸文件夹（含 project.json）或 Workshop 内容目录，填完点上方"扫描"。',
          children: el('input', {
            type: 'text', className: 'dsh-bgb-input dsh-bgb-inputField',
            value: s.wePath, placeholder: 'D:\\SteamLibrary\\steamapps\\workshop\\content\\431960',
            onChange: function (e) { setField('wePath', e.target.value) },
          }),
        }),
        weState[0].state === 'done'
          ? (weState[0].items.length === 0
              ? el('div', { className: 'dsh-bgb-caption', style: { padding: '8px 0 12px' } }, '未找到壁纸。确认 WE 已订阅下载壁纸，或手动填写路径后重新扫描。')
              : [
                  el('div', { className: 'dsh-bgb-weGrid' },
                    weState[0].items.map(function (item) {
                      var selected = item.mediaUrl !== '' && s.image === item.mediaUrl
                      // 场景徽章：可转换 / 无可用纹理（纯 3D 粒子不显示转换按钮，省时间）
                      var badge = item.supported
                        ? typeLabel(item.type)
                        : (item.type === 'scene'
                            ? (item.convertible ? '场景 · 可转换' : '场景 · 无可用纹理')
                            : '不支持 · ' + typeLabel(item.type) + '（点按）')
                      var titleTip = item.supported
                        ? ''
                        : (item.type === 'scene' && item.convertible === false
                            ? '（纯 3D/粒子场景，无可转换纹理；可用 repkg 转换后手动上传）'
                            : '（' + item.reason + '；点击尝试其公开预览视频，失败退回预览图）')
                      return el('div', {
                        key: item.id,
                        className: 'dsh-bgb-weItem'
                          + (item.supported ? '' : ' dsh-bgb-weScene')
                          + (selected ? ' dsh-bgb-weSelected' : ''),
                        title: item.title + titleTip,
                        onClick: item.supported
                          ? function () { pickWe(item) }
                          : function () { pickUnsupported(item) },
                      },
                        item.previewUrl !== ''
                          ? el('img', { className: 'dsh-bgb-weImg', src: item.previewUrl, loading: 'lazy', alt: item.title })
                          : el('div', { className: 'dsh-bgb-weImg dsh-bgb-weNoPreview' }, '🎞'),
                        el('div', { className: 'dsh-bgb-weTitle' }, item.title),
                        el('div', { className: 'dsh-bgb-weBadge' }, badge),
                        !item.supported && item.type === 'scene' && item.convertible === true
                          ? el('button', {
                            type: 'button',
                            className: 'dsh-bgb-button dsh-bgb-buttonPrimary',
                            disabled: convState[0].running,
                            style: { height: '24px', padding: '0 8px', borderRadius: '12px', fontSize: '12px', marginTop: '2px' },
                            onClick: function (e) { e.stopPropagation(); convertWe(item) },
                          }, convState[0].running ? '转换中…' : '转换')
                          : null,
                      )
                    }),
                  ),
                  weState[0].msg !== ''
                    ? el('div', { className: 'dsh-bgb-caption', style: { padding: '0 0 12px' } }, weState[0].msg)
                    : null,
                  el('div', { className: 'dsh-bgb-caption', style: { padding: '0 0 12px', color: 'var(--dsw-alias-label-tertiary)' } },
                    '提示：扫描后符合条件的场景壁纸会自动转换并出现在「转换视频」标签；若找不到理想的壁纸，可用 repkg 转换后手动上传。'),
                ])
          : (weState[0].state === 'error'
              ? el('div', { className: 'dsh-bgb-caption', style: { color: 'var(--dsw-alias-state-danger-primary)', padding: '8px 0 12px' } }, weState[0].error)
              : null),
          )
          : null,
        tab[0] === '转换视频'
          ? el('div', { className: 'dsh-bgb-tabBody' },
        Row({
          title: '转换文件夹',
          caption: '转换出的 mp4 / 动画 GIF 存这里（内置转换，无需任何外部工具），可一键打开管理/删除；点选即设为背景。',
          children: el('div', { className: 'dsh-bgb-control' },
            el('button', { type: 'button', className: 'dsh-bgb-button', onClick: openFolder }, '打开文件夹'),
            el('button', { type: 'button', className: 'dsh-bgb-button', onClick: loadConverted }, '刷新'),
          ),
        }),
        convState[0].running
          ? el('div', { className: 'dsh-bgb-row' },
              el('div', { className: 'dsh-bgb-rowLabel' },
                el('div', { className: 'dsh-bgb-rowTitle' }, '转换进度'),
                el('div', { className: 'dsh-bgb-caption' }, (weState[0].msg !== '' ? weState[0].msg : '转换中…')),
              ),
              el('div', { className: 'dsh-bgb-control', style: { flex: '1', minWidth: '160px' } },
                el('div', { className: 'dsh-bgb-progress' },
                  el('div', {
                    className: 'dsh-bgb-progressFill',
                    style: { width: (convState[0].progress || 0) + '%' },
                  }),
                ),
                el('span', { className: 'dsh-bgb-value' }, (convState[0].progress || 0) + '%'),
              ),
            )
          : null,
        convState[0].loaded && convState[0].files.length > 0
          ? el('div', { className: 'dsh-bgb-weGrid' },
              convState[0].files.map(function (f) {
                var sel = s.image === f.url
                return el('div', {
                  key: f.name,
                  className: 'dsh-bgb-weItem' + (sel ? ' dsh-bgb-weSelected' : ''),
                  title: f.name,
                  onClick: function () { pickConverted(f) },
                },
                  el('div', { className: 'dsh-bgb-weImg dsh-bgb-weNoPreview' }, '🎬'),
                  el('div', { className: 'dsh-bgb-weTitle' }, f.name),
                )
              }),
            )
          : (convState[0].loaded
              ? el('div', { className: 'dsh-bgb-caption', style: { padding: '0 0 12px' } }, '还没有转换过的内容：扫描 WE 壁纸库后符合条件的场景壁纸会自动转换；也可在壁纸网格上手动点「转换」。')
              : null),
          )
          : null,
        tab[0] === '背景图'
          ? el('div', { className: 'dsh-bgb-tabBody' },
        Row({
          title: '图片尺寸',
          caption: 'cover 铺满裁剪；contain 完整显示（视频壁纸同样生效）。',
          children: el('select', {
            className: 'dsh-bgb-input dsh-bgb-select', value: s.size,
            onChange: function (e) { setField('size', e.target.value) },
          },
            el('option', { value: 'cover' }, 'cover（铺满裁剪）'),
            el('option', { value: 'contain' }, 'contain（完整显示）'),
            el('option', { value: 'auto' }, 'auto'),
          ),
        }),
        Row({
          title: '图片位置',
          caption: 'CSS background-position，如 center、top left。',
          children: el('input', {
            type: 'text', className: 'dsh-bgb-input dsh-bgb-inputShort',
            value: s.position,
            onChange: function (e) { setField('position', e.target.value) },
          }),
        }),
        Row({
          title: '背景固定',
          caption: '大图建议关闭（Chrome 对固定大背景会模糊）；视频/网页壁纸始终固定。',
          children: el('label', { className: 'dsh-bgb-checkText', style: { display: 'inline-flex', alignItems: 'center', gap: '8px' } },
            el('input', {
              type: 'checkbox', className: 'dsh-bgb-check', checked: s.fixed === true,
              onChange: function (e) { setField('fixed', e.target.checked) },
            }),
            '固定背景',
          ),
        }),
        SliderRow({
          label: '视频播放速度',
          caption: '仅对视频壁纸生效（0.25× 慢放 ～ 2× 快进）。',
          value: s.videoSpeed, min: '0.25', max: '2', step: '0.05',
          format: function (v) { return v.toFixed(2) + '×' },
          onChange: function (v) { setField('videoSpeed', v) },
        }),
        SliderRow({ label: '主区透明度', value: s.opacityMain, onChange: function (v) { setField('opacityMain', v) } }),
        SliderRow({ label: '侧边栏透明度', value: s.opacitySidebar, onChange: function (v) { setField('opacitySidebar', v) } }),
        SliderRow({ label: '卡片/浮层透明度', value: s.opacityCard, onChange: function (v) { setField('opacityCard', v) } }),
        SliderRow({ label: '输入区透明度', value: s.opacityInput, onChange: function (v) { setField('opacityInput', v) } }),
        Row({
          title: '文字颜色',
          caption: '只作用于主区（会话/欢迎页）；卡片、菜单、侧边栏保持主题默认，避免看不清。',
          children: el('select', {
            className: 'dsh-bgb-input dsh-bgb-select', value: s.textColor,
            onChange: function (e) { setField('textColor', e.target.value) },
          },
            el('option', { value: 'white' }, '白色'),
            el('option', { value: 'black' }, '黑色'),
            el('option', { value: 'auto' }, '跟随主题'),
          ),
        }),
        Row({
          title: '背景纱幕',
          caption: '在背景图上叠加一层半透明纱幕，整体对比更强（默认关闭）。',
          children: el('label', { className: 'dsh-bgb-checkText', style: { display: 'inline-flex', alignItems: 'center', gap: '8px' } },
            el('input', {
              type: 'checkbox', className: 'dsh-bgb-check', checked: s.scrim === true,
              onChange: function (e) { setField('scrim', e.target.checked) },
            }),
            '启用',
          ),
        }),
          )
          : null,
        tab[0] === '光晕'
          ? el('div', { className: 'dsh-bgb-tabBody' },
        Row({
          title: '启用呼吸光晕',
          caption: '输入框外圈持续呼吸发光。',
          children: el('label', { className: 'dsh-bgb-checkText', style: { display: 'inline-flex', alignItems: 'center', gap: '8px' } },
            el('input', {
              type: 'checkbox', className: 'dsh-bgb-check', checked: s.glowEnabled === true,
              onChange: function (e) { setField('glowEnabled', e.target.checked) },
            }),
            '启用',
          ),
        }),
        Row({
          title: '光晕颜色',
          children: el('input', {
            type: 'color', className: 'dsh-bgb-color', value: s.glowColor,
            onChange: function (e) { setField('glowColor', e.target.value) },
          }),
        }),
        SliderRow({
          label: '光晕速度', value: s.glowSpeed, min: '0.3', max: '5', step: '0.1',
          format: function (v) { return v.toFixed(1) + 's' },
          onChange: function (v) { setField('glowSpeed', v) },
        }),
        Row({
          title: '使用交叉色',
          caption: '勾选后光晕在主色与交叉色之间无缝融合交替（默认关闭）。',
          children: el('label', { className: 'dsh-bgb-checkText', style: { display: 'inline-flex', alignItems: 'center', gap: '8px' } },
            el('input', {
              type: 'checkbox', className: 'dsh-bgb-check', checked: s.glowCross === true,
              onChange: function (e) { setField('glowCross', e.target.checked) },
            }),
            '启用',
          ),
        }),
        Row({
          title: '交叉色',
          caption: '与主色交替的第二颜色。',
          children: el('input', {
            type: 'color', className: 'dsh-bgb-color', value: s.glowCrossColor,
            onChange: function (e) { setField('glowCrossColor', e.target.value) },
          }),
        }),
        Row({
          title: '心情光晕模式',
          caption: 'AI 状态情绪灯：思考中=柔蓝慢呼吸、完成=金色一闪、出错=暖红缓闪、空闲=微微星光。',
          children: el('label', { className: 'dsh-bgb-checkText', style: { display: 'inline-flex', alignItems: 'center', gap: '8px' } },
            el('input', {
              type: 'checkbox', className: 'dsh-bgb-check', checked: s.glowMood === true,
              onChange: function (e) { setField('glowMood', e.target.checked) },
            }),
            '启用',
          ),
        }),
        SliderRow({ label: '光晕强度', value: s.glowStrength, max: '1.5', onChange: function (v) { setField('glowStrength', v) } }),
          )
          : null,
        tab[0] === '品牌定制'
          ? el('div', { className: 'dsh-bgb-tabBody' },
        Row({
          title: '浏览器图标',
          caption: 'favicon：填 /bg/xxx.svg、https:// 外链或 data: URI；留空 = 默认图标。',
          children: el('input', {
            type: 'text', className: 'dsh-bgb-input dsh-bgb-inputField',
            value: s.brandIcon, placeholder: '/bg/logo.svg',
            onChange: function (e) { setField('brandIcon', e.target.value) },
          }),
        }),
        Row({
          title: '欢迎语',
          caption: '替换空会话页的欢迎语；留空 = 默认。',
          children: el('input', {
            type: 'text', className: 'dsh-bgb-input dsh-bgb-inputField',
            value: s.welcomeText, placeholder: '你好，世界',
            onChange: function (e) { setField('welcomeText', e.target.value) },
          }),
        }),
        Row({
          title: '浏览器标题后缀',
          caption: '追加到标签页标题末尾，如 — MyBrand；留空 = 默认。',
          children: el('input', {
            type: 'text', className: 'dsh-bgb-input dsh-bgb-inputField',
            value: s.titleSuffix, placeholder: 'MyBrand',
            onChange: function (e) { setField('titleSuffix', e.target.value) },
          }),
        }),
          )
          : null,
        el('div', { className: 'dsh-bgb-row' },
          el('div', { className: 'dsh-bgb-rowLabel' },
            el('div', { className: 'dsh-bgb-rowTitle' }, '恢复默认'),
            el('div', { className: 'dsh-bgb-caption' }, '重置透明度与光晕设置到出厂值，背景图与显示方式不变。'),
          ),
          el('div', { className: 'dsh-bgb-control' },
            el('button', { type: 'button', className: 'dsh-bgb-button dsh-bgb-buttonPrimary', onClick: resetAll }, '恢复默认'),
          ),
        ),
      )
    }

    exports.BgBeautifySection = BgBeautifySection
    return module.exports
  },
})
