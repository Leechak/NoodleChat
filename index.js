// Chat Bubbles v0.2.0
// - Bot replies are shown as chat bubbles (one line = one bubble); the thinking/planning block is hidden
// - Chat-app UI: header with name/status, bot on the left, you on the right, typing indicator
// - Token saver: thinking blocks of OLD bot messages are not re-sent in the prompt
// Stored chat text is never modified; everything is display-only (plus the outgoing prompt copy).

(() => {
    'use strict';

    const MODULE = 'chat_bubbles';
    const PROMPT_KEY = 'chat_bubbles_prompt';
    const VER = 2;

    const DEFAULT_PROMPT =
        '[Chat app mode. Visible reply = the character\'s sent text messages only: {{min}}-{{max}} short messages, ' +
        'one per line, one thought each. No narration, actions, *asterisks* or quotes. Casual phone-typing style, ' +
        'emoji sparingly. Same language as the chat. Keep any thinking/planning block exactly as your instructions ' +
        'define it; only the part after it must be chat lines.]';

    const DEFAULT_TAGS = 'think,thinking,thought,reasoning,plan,planning,analysis,scratchpad,cot';

    const defaults = Object.freeze({
        ver: VER,
        enabled: true,
        appUI: true,
        meColor: '#3b82f6',
        stripNarration: true,
        trimHistory: true,
        minBubbles: 2,
        maxBubbles: 5,
        cotTags: DEFAULT_TAGS,
        replyTag: '',
        prompt: DEFAULT_PROMPT,
    });

    const ctx = () => SillyTavern.getContext();

    function getSettings() {
        const { extensionSettings } = ctx();
        if (!extensionSettings[MODULE]) extensionSettings[MODULE] = {};
        const s = extensionSettings[MODULE];
        if (s.ver !== VER) {
            // migrate from v0.1: new shorter prompt
            s.prompt = DEFAULT_PROMPT;
            delete s.animate;
            s.ver = VER;
        }
        for (const k of Object.keys(defaults)) {
            if (s[k] === undefined) s[k] = defaults[k];
        }
        return s;
    }

    const save = () => ctx().saveSettingsDebounced();

    // ---------- state ----------

    let generating = false;
    let genStart = 0;
    let animUntil = 0;

    // ---------- prompt injection ----------

    function applyPrompt() {
        const c = ctx();
        const s = getSettings();
        const types = c.extension_prompt_types ?? { IN_PROMPT: 0, IN_CHAT: 1 };
        const roles = c.extension_prompt_roles ?? { SYSTEM: 0 };
        const text = s.enabled
            ? s.prompt.replaceAll('{{min}}', String(s.minBubbles)).replaceAll('{{max}}', String(s.maxBubbles))
            : '';
        // depth 0 = right after the latest message
        c.setExtensionPrompt(PROMPT_KEY, text, types.IN_CHAT, 0, false, roles.SYSTEM);
    }

    // ---------- thinking-block handling ----------

    let cotCache = { key: null, closed: null, open: null };

    function cotRegexes(s) {
        if (cotCache.key === s.cotTags) return cotCache;
        const names = String(s.cotTags || '')
            .split(',')
            .map((x) => x.trim())
            .filter((x) => /^[\w:-]+$/.test(x));
        if (!names.length) {
            cotCache = { key: s.cotTags, closed: null, open: null };
            return cotCache;
        }
        const alt = names.join('|');
        cotCache = {
            key: s.cotTags,
            closed: new RegExp('(?:<|\\[)(' + alt + ')\\b[^>\\]]*(?:>|\\])[\\s\\S]*?(?:<|\\[)\\/\\1\\s*(?:>|\\])', 'gi'),
            open: new RegExp('(?:<|\\[)(?:' + alt + ')\\b[^>\\]]*(?:>|\\])[\\s\\S]*$', 'i'),
        };
        return cotCache;
    }

    function stripCot(text, s) {
        const r = cotRegexes(s);
        let t = String(text ?? '');
        if (r.closed) t = t.replace(r.closed, '');
        if (r.open) t = t.replace(r.open, ''); // unclosed block (still thinking / streaming)
        return t;
    }

    function pickReply(t, s) {
        const tag = String(s.replyTag || '').trim();
        if (!/^[\w:-]+$/.test(tag)) return t;
        const m = new RegExp('<' + tag + '\\b[^>]*>([\\s\\S]*?)(?:</' + tag + '\\s*>|$)', 'i').exec(t);
        return m ? m[1] : t;
    }

    // ---------- text -> bubbles ----------

    function escapeHtml(str) {
        return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    }

    function inlineFormat(str) {
        return escapeHtml(str)
            .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
            .replace(/(^|[^*])\*(?!\s)([^*]+?)\*(?!\*)/g, '$1<em>$2</em>');
    }

    function toBubbles(raw, s) {
        let text = pickReply(stripCot(raw, s), s);
        if (generating) text = text.replace(/(?:<|\[)\/?[A-Za-z]*$/, ''); // half-typed tag while streaming

        const out = [];
        for (let line of text.split(/\r?\n|\|\|\|/)) {
            if (s.stripNarration) {
                line = line.replace(/\*[^*\n]*\*/g, '');
                if ((line.match(/\*/g) || []).length % 2 === 1) {
                    line = line.slice(0, line.lastIndexOf('*')); // unclosed narration
                }
            }
            line = line.trim().replace(/^["“”「『]+|["“”」』]+$/g, '').trim();
            if (line) out.push(line);
        }
        return out;
    }

    // ---------- rendering ----------

    function typingBubble() {
        const d = document.createElement('div');
        d.className = 'cb-bubble cb-typing';
        d.innerHTML = '<i></i><i></i><i></i>';
        return d;
    }

    function addTime(wrap, mes) {
        const ts = mes.querySelector('.timestamp')?.textContent || '';
        const m = ts.match(/\d{1,2}:\d{2}(?:\s?[AaPp]\.?[Mm]\.?)?/);
        if (!m) return;
        const t = document.createElement('div');
        t.className = 'cb-time';
        t.textContent = m[0];
        wrap.appendChild(t);
    }

    function restore(el, msg, id) {
        const c = ctx();
        try {
            if (typeof c.messageFormatting === 'function') {
                el.innerHTML = c.messageFormatting(msg.mes, msg.name, !!msg.is_system, !!msg.is_user, id);
            } else {
                el.textContent = msg.mes;
            }
        } catch {
            el.textContent = msg.mes;
        }
    }

    function renderMes(mes) {
        const s = getSettings();
        if (!s.enabled) return;

        const id = Number(mes.getAttribute('mesid'));
        const msg = ctx().chat?.[id];
        if (!msg || msg.is_system) return;
        if (mes.querySelector('#curEditTextarea, .edit_textarea')) return; // being edited

        const el = mes.querySelector('.mes_text');
        if (!el) return;

        const hasWrap = !!el.querySelector(':scope > .cb-wrap');

        // your own messages: right-side bubble (UI mode only)
        if (msg.is_user) {
            if (!s.appUI || hasWrap) return;
            const wrap = document.createElement('div');
            wrap.className = 'cb-wrap cb-me';
            const b = document.createElement('div');
            b.className = 'cb-bubble';
            b.append(...el.childNodes);
            wrap.appendChild(b);
            addTime(wrap, mes);
            el.replaceChildren(wrap);
            return;
        }

        const sig = [s.stripNarration ? 1 : 0, s.appUI ? 1 : 0, generating ? 1 : 0, msg.mes].join('\u0001');
        if (hasWrap && el.dataset.cbSig === sig) return;

        const bubbles = toBubbles(msg.mes, s);
        const isLast = mes.classList.contains('last_mes');
        const wrap = document.createElement('div');
        wrap.className = 'cb-wrap';

        if (bubbles.length) {
            const animate = isLast && Date.now() < animUntil;
            const start = animate ? Math.min(Number(el.dataset.cbCount || 0), bubbles.length) : bubbles.length;
            bubbles.forEach((b, i) => {
                const d = document.createElement('div');
                d.className = 'cb-bubble';
                d.innerHTML = inlineFormat(b);
                if (animate && i >= start) {
                    d.classList.add('cb-new');
                    d.style.animationDelay = `${(i - start) * 150}ms`;
                }
                wrap.appendChild(d);
            });
            if (s.appUI && !generating) addTime(wrap, mes);
            el.dataset.cbCount = String(bubbles.length);
        } else if (generating && isLast) {
            wrap.appendChild(typingBubble()); // still thinking -> show typing dots
            el.dataset.cbCount = '0';
        } else {
            // nothing usable: fall back to ST's own rendering
            if (hasWrap) restore(el, msg, id);
            delete el.dataset.cbSig;
            return;
        }

        el.replaceChildren(wrap);
        el.dataset.cbSig = sig;
    }

    const pending = new Set();
    let scheduled = false;

    function queue(mes) {
        pending.add(mes);
        if (scheduled) return;
        scheduled = true;
        requestAnimationFrame(() => {
            scheduled = false;
            const list = [...pending];
            pending.clear();
            list.forEach(renderMes);
            if (generating) updateTyping();
        });
    }

    function rescan() {
        document.querySelectorAll('#chat .mes').forEach(queue);
    }

    function startObserver() {
        const chat = document.getElementById('chat');
        if (!chat) return;
        const obs = new MutationObserver((muts) => {
            ensureHeader();
            for (const m of muts) {
                const t = m.target instanceof Element ? m.target : m.target.parentElement;
                const owner = t?.closest?.('.mes');
                if (owner) {
                    queue(owner);
                    continue;
                }
                m.addedNodes.forEach((n) => {
                    if (n.nodeType !== 1) return;
                    if (n.matches?.('.mes')) queue(n);
                    else n.querySelectorAll?.('.mes').forEach(queue);
                });
            }
        });
        obs.observe(chat, { childList: true, subtree: true });

        // tap a message to show its tools (edit/delete/...) on touch screens
        chat.addEventListener('click', (e) => {
            const s = getSettings();
            if (!s.enabled || !s.appUI) return;
            if (e.target.closest('.mes_buttons, .mes_edit_buttons, .swipe_left, .swipe_right, a, button, input, textarea')) return;
            const mes = e.target.closest('.mes');
            if (!mes) return;
            const was = mes.classList.contains('cb-tools');
            chat.querySelectorAll('.mes.cb-tools').forEach((m) => m.classList.remove('cb-tools'));
            if (!was) mes.classList.add('cb-tools');
        });
    }

    function reloadChat() {
        const c = ctx();
        if (typeof c.reloadCurrentChat === 'function') c.reloadCurrentChat();
        else toastr.info('รีเฟรชหน้าเว็บเพื่อกลับไปแสดงผลแบบเดิม');
    }

    // ---------- header + typing indicator ----------

    let header = null;

    function ensureHeader() {
        const chat = document.getElementById('chat');
        if (!chat) return;
        if (!header) {
            header = document.createElement('div');
            header.id = 'cb-header';
            header.innerHTML =
                '<div class="cb-avatar"><span></span><img alt=""></div>' +
                '<div class="cb-hmeta"><div class="cb-hname"></div>' +
                '<div class="cb-hstatus"><i class="cb-dot"></i><span>ออนไลน์</span></div></div>';
            header.querySelector('img').addEventListener('error', (e) => { e.target.style.display = 'none'; });
        }
        if (!header.isConnected) chat.prepend(header);
    }

    function updateHeader() {
        ensureHeader();
        if (!header) return;
        const c = ctx();
        let name = c.name2 || 'Chat';
        let avatar = '';
        if (c.groupId) {
            const g = c.groups?.find((x) => String(x.id) === String(c.groupId));
            name = g?.name || name;
        } else if (c.characterId !== undefined && c.characters?.[c.characterId]) {
            const ch = c.characters[c.characterId];
            name = ch.name || name;
            avatar = ch.avatar || '';
        }
        header.querySelector('.cb-hname').textContent = name;
        header.querySelector('.cb-avatar span').textContent = (name || '?').trim().charAt(0).toUpperCase();
        const img = header.querySelector('img');
        if (avatar) {
            const url = typeof c.getThumbnailUrl === 'function'
                ? c.getThumbnailUrl('avatar', avatar)
                : '/thumbnail?type=avatar&file=' + encodeURIComponent(avatar);
            img.style.display = '';
            img.src = url;
        } else {
            img.removeAttribute('src');
            img.style.display = 'none';
        }
    }

    function updateTyping() {
        const chat = document.getElementById('chat');
        if (!chat) return;
        const s = getSettings();

        // watchdog: ST's stop button hidden => generation really ended (covers errors)
        if (generating && Date.now() - genStart > 4000) {
            const stop = document.getElementById('mes_stop');
            if (stop && getComputedStyle(stop).display === 'none') {
                generating = false;
                animUntil = Date.now() + 1500;
                rescan();
            }
        }

        const on = s.enabled && s.appUI;

        if (header) {
            header.classList.toggle('cb-is-typing', generating);
            const st = header.querySelector('.cb-hstatus span');
            if (st) st.textContent = generating ? 'กำลังพิมพ์…' : 'ออนไลน์';
        }

        let last = chat.lastElementChild;
        while (last && !last.classList.contains('mes')) last = last.previousElementSibling;
        const showFloat = on && generating && last && last.getAttribute('is_user') === 'true';

        let f = document.getElementById('cb-float');
        if (showFloat && !f) {
            f = document.createElement('div');
            f.id = 'cb-float';
            f.className = 'cb-float';
            const w = document.createElement('div');
            w.className = 'cb-wrap';
            w.appendChild(typingBubble());
            f.appendChild(w);
            chat.appendChild(f);
            chat.scrollTop = chat.scrollHeight;
        } else if (!showFloat && f) {
            f.remove();
        }
    }

    // ---------- UI state ----------

    function fgFor(hex) {
        const m = /^#?([0-9a-f]{6})$/i.exec(hex || '');
        if (!m) return '#fff';
        const n = parseInt(m[1], 16);
        const lum = (0.299 * (n >> 16) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255;
        return lum > 0.62 ? '#111' : '#fff';
    }

    function applyUI() {
        const s = getSettings();
        document.body.classList.toggle('cb-enabled', !!s.enabled);
        document.body.classList.toggle('cb-app', !!(s.enabled && s.appUI));
        const root = document.documentElement.style;
        root.setProperty('--cb-me', s.meColor);
        root.setProperty('--cb-me-fg', fgFor(s.meColor));
    }

    // ---------- token saver: drop old thinking blocks from the outgoing prompt ----------

    function onPromptReady(data) {
        const s = getSettings();
        if (!s.enabled || !s.trimHistory || !data || !Array.isArray(data.chat)) return;
        const chat = data.chat;
        const last = chat.length - 1;
        chat.forEach((m, i) => {
            if (!m || m.role !== 'assistant' || typeof m.content !== 'string') return;
            if (i === last) return; // may be a prefill
            const t = stripCot(m.content, s).replace(/\n{3,}/g, '\n\n').trim();
            if (t) m.content = t;
        });
    }

    // ---------- settings UI ----------

    function buildSettings() {
        const s = getSettings();
        const html = `
<div class="cb-settings">
  <div class="inline-drawer">
    <div class="inline-drawer-toggle inline-drawer-header">
      <b>Chat Bubbles</b>
      <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
    </div>
    <div class="inline-drawer-content">
      <label class="checkbox_label"><input type="checkbox" id="cb_enabled"><span>เปิดใช้งาน</span></label>
      <label class="checkbox_label"><input type="checkbox" id="cb_appui"><span>หน้าตาแอปแชท (ซ้าย/ขวา + แถบชื่อ)</span></label>
      <label class="checkbox_label"><input type="checkbox" id="cb_trim"><span>ประหยัดโทเค่น: ไม่ส่งส่วนคิดของข้อความเก่า</span></label>
      <div class="cb-row">
        <span>สีบับเบิ้ลของฉัน</span>
        <input type="color" id="cb_color">
      </div>
      <div class="cb-row">
        <span>จำนวนบับเบิ้ลต่อครั้ง</span>
        <input type="number" id="cb_min" class="text_pole" min="1" max="20">
        <span>ถึง</span>
        <input type="number" id="cb_max" class="text_pole" min="1" max="20">
      </div>
      <details class="cb-adv">
        <summary>ขั้นสูง</summary>
        <label class="checkbox_label"><input type="checkbox" id="cb_strip"><span>ตัดบรรยาย *...* ออก</span></label>
        <div class="cb-row"><span>ชื่อ tag ส่วนคิดที่ซ่อน (คั่นด้วย ,)</span></div>
        <input type="text" id="cb_tags" class="text_pole">
        <div class="cb-row"><span>tag ที่ครอบคำตอบจริง (เว้นว่าง = ไม่ใช้)</span></div>
        <input type="text" id="cb_reply" class="text_pole">
        <div class="cb-row"><b>พรอมต์ที่ส่งให้ AI</b></div>
        <textarea id="cb_prompt" class="text_pole"></textarea>
        <div class="cb-row"><input type="button" id="cb_reset" class="menu_button" value="รีเซ็ตพรอมต์"></div>
      </details>
    </div>
  </div>
</div>`;
        $('#extensions_settings2').append(html);

        $('#cb_enabled').prop('checked', s.enabled).on('change', function () {
            s.enabled = this.checked;
            save();
            applyUI();
            applyPrompt();
            updateTyping();
            if (s.enabled) rescan();
            else reloadChat();
        });

        $('#cb_appui').prop('checked', s.appUI).on('change', function () {
            s.appUI = this.checked;
            save();
            applyUI();
            updateTyping();
            if (s.appUI) rescan();
            else reloadChat();
        });

        $('#cb_trim').prop('checked', s.trimHistory).on('change', function () {
            s.trimHistory = this.checked;
            save();
        });

        $('#cb_color').val(s.meColor).on('input', function () {
            s.meColor = this.value;
            save();
            applyUI();
        });

        const clamp = (v, fallback) => {
            const n = parseInt(v, 10);
            return Number.isFinite(n) ? Math.min(20, Math.max(1, n)) : fallback;
        };

        $('#cb_min').val(s.minBubbles).on('change', function () {
            s.minBubbles = clamp(this.value, s.minBubbles);
            if (s.minBubbles > s.maxBubbles) s.maxBubbles = s.minBubbles;
            $('#cb_min').val(s.minBubbles);
            $('#cb_max').val(s.maxBubbles);
            save();
            applyPrompt();
        });

        $('#cb_max').val(s.maxBubbles).on('change', function () {
            s.maxBubbles = clamp(this.value, s.maxBubbles);
            if (s.maxBubbles < s.minBubbles) s.minBubbles = s.maxBubbles;
            $('#cb_min').val(s.minBubbles);
            $('#cb_max').val(s.maxBubbles);
            save();
            applyPrompt();
        });

        $('#cb_strip').prop('checked', s.stripNarration).on('change', function () {
            s.stripNarration = this.checked;
            save();
            rescan();
        });

        $('#cb_tags').val(s.cotTags).on('change', function () {
            s.cotTags = this.value.trim();
            save();
            rescan();
        });

        $('#cb_reply').val(s.replyTag).on('change', function () {
            s.replyTag = this.value.trim();
            save();
            rescan();
        });

        $('#cb_prompt').val(s.prompt).on('input', function () {
            s.prompt = this.value;
            save();
            applyPrompt();
        });

        $('#cb_reset').on('click', () => {
            s.prompt = DEFAULT_PROMPT;
            $('#cb_prompt').val(s.prompt);
            save();
            applyPrompt();
            toastr.success('รีเซ็ตพรอมต์แล้ว');
        });
    }

    // ---------- init ----------

    function init() {
        const { eventSource, event_types } = ctx();

        buildSettings();
        applyUI();
        applyPrompt();
        ensureHeader();
        updateHeader();
        startObserver();
        rescan();

        const on = (name, fn) => {
            if (event_types[name]) eventSource.on(event_types[name], fn);
        };

        on('GENERATION_STARTED', (type, params, dryRun) => {
            if (dryRun || params?.quiet_prompt) return;
            generating = true;
            genStart = Date.now();
            animUntil = Infinity;
            updateTyping();
        });

        const ended = () => {
            generating = false;
            animUntil = Date.now() + 1500;
            rescan();
            updateTyping();
        };
        on('GENERATION_ENDED', ended);
        on('GENERATION_STOPPED', ended);

        on('CHAT_COMPLETION_PROMPT_READY', onPromptReady);

        on('CHAT_CHANGED', () => {
            updateHeader();
            setTimeout(rescan, 50);
        });
        for (const name of ['MESSAGE_EDITED', 'MESSAGE_UPDATED', 'MESSAGE_SWIPED']) {
            on(name, () => setTimeout(rescan, 50));
        }

        setInterval(() => { if (generating) updateTyping(); }, 1000);
    }

    jQuery(() => init());
})();
