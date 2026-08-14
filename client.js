/**
 * dsh-bg-beautify — browser half (settings-page version).
 *
 * @author 芝麻 (halosb) <i@halosb.com>
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
      image: '/bg/placeholder.svg', // '' = 无图（只做半透明）
      size: 'cover',                // cover / contain / 具体尺寸
      position: 'center',           // CSS background-position
      fixed: false,                 // true = 背景固定；false = 随页面滚动（大图更清晰）
      opacityMain: 0,               // 主区 / 聊天区（0 全透 ～ 1 不透）
      opacitySidebar: 0.3,          // 左侧边栏
      opacityCard: 0.85,            // 卡片 / 菜单 / 浮层
      opacityInput: 0.75,           // 输入区
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

    /** The <style> text for one settings object (page background). */
    function buildCss(s) {
      var lines = ['html { background: #0f1115; }', 'body {']
      if (s.image !== '') {
        lines.push('  background-image: url("' + s.image + '");')
        lines.push('  background-position: ' + s.position + ';')
        lines.push('  background-size: ' + s.size + ';')
        lines.push('  background-repeat: no-repeat;')
        if (s.fixed) lines.push('  background-attachment: fixed;')
      }
      lines.push('}')
      return lines.join('\n')
    }

    /** Theme token overrides (light/dark pairs) for one settings object. */
    function buildTokens(s) {
      return {
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
          styleEl.textContent = buildCss(s)
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

    /** One labeled range slider row. */
    function SliderRow(props) {
      return el('div', { className: 'dsh-bgb-row' },
        el('div', { className: 'dsh-bgb-rowLabel' },
          el('div', { className: 'dsh-bgb-rowTitle' }, props.label),
        ),
        el('div', { className: 'dsh-bgb-control', style: { flex: '1' } },
          el('input', {
            type: 'range', min: '0', max: '1', step: '0.05',
            className: 'dsh-bgb-range', value: String(props.value),
            onChange: function (e) { props.onChange(Number(e.target.value)) },
          }),
          el('span', { className: 'dsh-bgb-value' }, props.value.toFixed(2)),
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
      var s = store.get()
      function setField(field, value) {
        var next = Object.assign({}, s)
        next[field] = value
        store.set(next)
        persist(next)
      }
      function resetAll() {
        // 只重置透明度到出厂值；背景图、尺寸、位置、固定保持不变。
        var next = Object.assign({}, s)
        next.opacityMain = DEFAULTS.opacityMain
        next.opacitySidebar = DEFAULTS.opacitySidebar
        next.opacityCard = DEFAULTS.opacityCard
        next.opacityInput = DEFAULTS.opacityInput
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
        el('p', { className: 'dsh-bgb-intro' }, '背景图与面板透明度，改动即时生效并持久保存。'),
        Row({
          title: '背景图',
          caption: '支持 /bg/文件名、https:// 外链、data: URI；留空表示不显示图片。',
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
        SliderRow({ label: '主区透明度', value: s.opacityMain, onChange: function (v) { setField('opacityMain', v) } }),
        SliderRow({ label: '侧边栏透明度', value: s.opacitySidebar, onChange: function (v) { setField('opacitySidebar', v) } }),
        SliderRow({ label: '卡片/浮层透明度', value: s.opacityCard, onChange: function (v) { setField('opacityCard', v) } }),
        SliderRow({ label: '输入区透明度', value: s.opacityInput, onChange: function (v) { setField('opacityInput', v) } }),
        Row({
          title: '图片尺寸',
          caption: 'cover 铺满裁剪；contain 完整显示。',
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
          caption: '大图建议关闭（Chrome 对固定大背景会模糊）。',
          children: el('label', { className: 'dsh-bgb-checkText', style: { display: 'inline-flex', alignItems: 'center', gap: '8px' } },
            el('input', {
              type: 'checkbox', className: 'dsh-bgb-check', checked: s.fixed === true,
              onChange: function (e) { setField('fixed', e.target.checked) },
            }),
            '固定背景',
          ),
        }),
        el('div', { className: 'dsh-bgb-row' },
          el('div', { className: 'dsh-bgb-rowLabel' },
            el('div', { className: 'dsh-bgb-rowTitle' }, '恢复默认'),
            el('div', { className: 'dsh-bgb-caption' }, '仅重置四个透明度到出厂值，背景图与显示方式不变。'),
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
