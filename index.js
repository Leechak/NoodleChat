// Chat Bubbles v0.4.0
// - Bot replies are shown as chat bubbles (one line = one bubble); the thinking/planning block is hidden
// - Bubble count is randomised every turn (so the AI stays dynamic instead of locking onto one number)
// - Chat-app UI: full-width header, bot left / you right, typing indicator, app-style composer
// - Broken replies (only symbols / thinking only) are detected -> retry chip + one automatic retry
// - Token saver: thinking blocks of OLD bot messages are not re-sent in the prompt
// - v0.4: human-like typing indicator (types / goes quiet / types again, pauses grow the longer the AI takes)
// - v0.4: new default prompt - bubble count is a soft hint (no more sentences cut in half to hit a number),
//         plus rules against the 'assistant voice' (closing offers, recaps, emoji/politeness on every line)
// Stored chat text is never modified; rendering is display-only (plus the outgoing prompt copy).

(() => {
    'use strict';

    const MODULE = 'chat_bubbles';
    const PROMPT_KEY = 'chat_bubbles_prompt';
    const VER = 4;

    // v3 default, kept only so an untouched old default can be upgraded automatically
    const OLD_PROMPT_V3 =
        '[Chat app mode. Reply = the character\'s sent text messages only, one per line, one thought each, ' +
        'in the chat\'s language. This turn: exactly {{n}} message(s); {{style}}. ' +
        'No narration, actions, *asterisks* or quotes. Casual phone-typing style, emoji sparingly. ' +
        'Keep any thinking/planning block as already instructed; after it write only the chat lines.]';

    const DEFAULT_PROMPT =
        '[Chat app mode. Reply = only the text messages the character actually sends, one per line, in the chat\'s language. ' +
        'Lean toward about {{n}} message(s) this turn ({{style}}), but the content decides: fewer is fine, ' +
        'and never cut one sentence across lines just to hit a number. Start a new line only where a real person would hit send. ' +
        'No narration, *actions* or quotes. Do not describe the room or what is physically happening through speech; ' +
        'if the character would not say it out loud, leave it out. ' +
        'Sound like this person texting, not like a service desk: react to what was just said before anything else; ' +
        'let the character want something or hold a small bias; ' +
        'no closing offers ("let me know", "feel free"), no recap of what the user just said, no sign-off on every line; ' +
        'politeness particles only where this character really uses them; emoji rare, never a habit at line ends; ' +
        'a short, odd or unfinished reply is fine. ' +
        'If you have a thinking/planning step, keep it as already instructed and add one check to it: ' +
        'what does the character want from this exchange, and what would a helpful assistant say here? Do not say that. ' +
        'After the thinking, write only the chat lines.]';

    const STYLES = [
        'short punchy bursts',
        'mix of 1-3 word messages and fuller sentences',
        'one longer message, the rest short',
        'relaxed mid-length messages',
    ];

    const DEFAULT_TAGS = 'think,thinking,thought,reasoning,plan,planning,analysis,scratchpad,cot';

    const defaults = Object.freeze({
        ver: VER,
        enabled: true,
        appUI: true,
        meColor: '#3b82f6',
        stripNarration: true,
        trimHistory: true,
        autoRetry: true,
        humanTyping: true,
        minBubbles: 1,
        maxBubbles: 6,
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
            const from = Number(s.ver) || 0;
            if (from < 3) {
                // v3 changed the meaning of min/max (random range)
                s.minBubbles = defaults.minBubbles;
                s.maxBubbles = defaults.maxBubbles;
            }
            // upgrade the prompt unless the person has written their own
            if (from < 3 || s.prompt === undefined || s.prompt === OLD_PROMPT_V3) s.prompt = DEFAULT_PROMPT;
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
    let liveText = false; // real words are already streaming in (so: no fake pauses)
    const roll = { n: 3, style: STYLES[0] };
    const retries = new Map();

    // ---------- prompt injection (random bubble count per turn) ----------

    function rollTurn() {
        const s = getSettings();
        const lo = Math.max(1, s.minBubbles);
        const hi = Math.max(lo, s.maxBubbles);
        let n = lo;
        if (hi > lo) {
            let tries = 0;
            do {
                n = lo + Math.floor(Math.random() * (hi - lo + 1));
            } while (n === roll.n && ++tries < 8);
        }
        roll.n = n;
        roll.style = STYLES[Math.floor(Math.random() * STYLES.length)];
    }

    function applyPrompt() {
        const c = ctx();
        const s = getSettings();
        const types = c.extension_prompt_types ?? { IN_PROMPT: 0, IN_CHAT: 1 };
        const roles = c.extension_prompt_roles ?? { SYSTEM: 0 };
        const text = s.enabled
            ? s.prompt
                .replaceAll('{{n}}', String(roll.n))
                .replaceAll('{{style}}', roll.style)
                .replaceAll('{{min}}', String(s.minBubbles))
                .replaceAll('{{max}}', String(s.maxBubbles))
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

    const HAS_WORD = /[\p{L}\p{N}]/u;
    const countWords = (arr) => (arr.join('').match(/[\p{L}\p{N}]/gu) || []).length;

    function escapeHtml(str) {
        return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    }

    function inlineFormat(str) {
        return escapeHtml(str)
            .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
            .replace(/(^|[^*])\*(?!\s)([^*]+?)\*(?!\*)/g, '$1<em>$2</em>');
    }

    function splitLines(text, s, asSpeech) {
        const out = [];
        for (let line of text.split(/\r?\n|\|\|\|/)) {
            const orig = line;
            if (asSpeech) {
                line = line.replace(/\*+/g, ''); // treat *text* as ordinary speech
            } else if (s.stripNarration) {
                line = line.replace(/\*[^*\n]*\*/g, '');
                if ((line.match(/\*/g) || []).length % 2 === 1) {
                    line = line.slice(0, line.lastIndexOf('*')); // unclosed narration
                }
                // leftovers of a narration line (e.g. only an emoji) are dropped
                if (line !== orig && !HAS_WORD.test(line) && HAS_WORD.test(orig)) continue;
            }
            line = line.trim().replace(/^["“”「『]+|["“”」』]+$/g, '').trim();
            if (line) out.push(line);
        }
        return out;
    }

    function toBubbles(raw, s) {
        let text = pickReply(stripCot(raw, s), s);
        if (generating) text = text.replace(/(?:<|\[)\/?[A-Za-z]*$/, ''); // half-typed tag while streaming

        let out = splitLines(text, s, false);
        // everything was inside *...* -> the model used asterisks for its speech: keep it
        if (!out.length && s.stripNarration && !generating) out = splitLines(text, s, true);
        return out;
    }

    // ---------- rendering ----------

    function typingBubble() {
        const d = document.createElement('div');
        d.className = 'cb-bubble cb-typing';
        d.innerHTML = '<i></i><i></i><i></i>';
        return d;
    }

    function retryChip(label) {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'cb-retry';
        b.innerHTML = '<i class="fa-solid fa-rotate-right"></i> ' + label;
        return b;
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
                    d.style.animationDelay = `${(i - start) * 180}ms`;
                }
                wrap.appendChild(d);
            });
            if (isLast && !generating && countWords(bubbles) < 2) {
                wrap.appendChild(retryChip('ตอบไม่ครบ ลองใหม่'));
            } else if (s.appUI && !generating) {
                addTime(wrap, mes);
            }
            el.dataset.cbCount = String(bubbles.length);
            if (isLast && generating && countWords(bubbles) > 0) liveText = true;
        } else if (generating && isLast) {
            wrap.appendChild(typingBubble()); // still thinking -> show typing dots
            el.dataset.cbCount = '0';
        } else if (isLast && !generating && !stripCot(msg.mes, s).trim()) {
            // finished, but there is only a thinking block (or nothing)
            const note = document.createElement('div');
            note.className = 'cb-bubble cb-note';
            note.textContent = 'ยังไม่มีข้อความตอบ';
            wrap.appendChild(note);
            wrap.appendChild(retryChip('ลองใหม่'));
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
            // retry chips only make sense on the latest message
            document.querySelectorAll('#chat .mes:not(.last_mes) .cb-retry').forEach((x) => x.remove());
            if (generating) updateTyping();
        });
    }

    function rescan() {
        document.querySelectorAll('#chat .mes').forEach(queue);
    }

    // regenerate the latest bot message (as a new swipe if possible)
    function regenerate() {
        const sw = document.querySelector('#chat .mes.last_mes .swipe_right');
        if (sw) {
            sw.click();
            return true;
        }
        const opt = document.getElementById('option_regenerate');
        if (opt) {
            opt.click();
            return true;
        }
        return false;
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

        chat.addEventListener('click', (e) => {
            const rb = e.target.closest('.cb-retry');
            if (rb) {
                e.preventDefault();
                regenerate();
                return;
            }
            // tap a message to show its tools (edit/delete/...) on touch screens
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

    // ---------- broken-reply detection ----------

    function isEmptyReply(msg, s) {
        return countWords(toBubbles(msg.mes, s)) < 2;
    }

    function checkReply() {
        const s = getSettings();
        if (!s.enabled || !s.autoRetry || generating) return;
        const c = ctx();
        const chat = c.chat;
        if (!chat?.length) return;
        const idx = chat.length - 1;
        const msg = chat[idx];
        if (!msg || msg.is_user || msg.is_system) return;
        if (!isEmptyReply(msg, s)) return;

        let u = idx - 1;
        while (u >= 0 && !chat[u].is_user) u--;
        const key = String(c.chatId ?? '') + ':' + u;
        const n = retries.get(key) || 0;
        if (n >= 1) return; // one automatic retry per user message
        retries.set(key, n + 1);
        toastr.info('ตอบไม่ครบ กำลังลองใหม่…');
        regenerate();
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
                '<div class="cb-avwrap"><div class="cb-avatar"><span></span><img alt=""></div><i class="cb-dot"></i></div>' +
                '<div class="cb-hmeta"><div class="cb-hname"></div><div class="cb-hstatus"><span>ออนไลน์</span></div></div>' +
                '<div class="cb-hact">' +
                '<button type="button" class="cb-hbtn" data-act="regen" title="สร้างคำตอบใหม่"><i class="fa-solid fa-rotate-right"></i></button>' +
                '<button type="button" class="cb-hbtn" data-act="menu" title="เมนู"><i class="fa-solid fa-ellipsis-vertical"></i></button>' +
                '</div>';
            header.querySelector('img').addEventListener('error', (e) => { e.target.style.display = 'none'; });
            header.addEventListener('click', (e) => {
                const b = e.target.closest('.cb-hbtn');
                if (!b) return;
                if (b.dataset.act === 'regen') regenerate();
                else document.getElementById('options_button')?.click();
            });
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

    // ---------- human-like typing: types -> goes quiet -> types again ----------
    // While the AI is still working (thinking block, slow API) the indicator does not just blink steadily:
    // it comes and goes like someone composing, deleting and rethinking. The longer the wait, the longer the quiet gaps.
    // Once real words start streaming in, it stays on steadily.

    const TYPING = {
        startDelay: [500, 1400],  // ms of "read, not typing yet" before the first typing
        burst: [1300, 3600],      // ms the indicator stays up
        pause: [700, 2200],       // ms it stays gone in between
        growth: 25,               // seconds of waiting after which pauses are ~2x longer
        maxGrowth: 2.6,           // ceiling for that stretch
    };
    const typer = { on: false, show: false, t0: 0, timer: 0 };
    const rand = ([a, b]) => a + Math.random() * (b - a);

    function paintTyping(typing, paused) {
        // paused -> CSS fades the dots out (space stays reserved, so nothing jumps around)
        document.body.classList.toggle('cb-tpause', paused);
        if (!header) return;
        header.classList.toggle('cb-is-typing', typing);
        const st = header.querySelector('.cb-hstatus span');
        if (st) st.textContent = typing ? 'กำลังพิมพ์…' : 'ออนไลน์';
    }

    function typerStep() {
        clearTimeout(typer.timer);
        if (!typer.on) return;
        if (liveText) {
            typer.show = true;
            paintTyping(true, false);
            typer.timer = setTimeout(typerStep, 400);
            return;
        }
        typer.show = !typer.show;
        paintTyping(typer.show, !typer.show);
        const waited = (Date.now() - typer.t0) / 1000;
        const stretch = Math.min(TYPING.maxGrowth, 1 + waited / TYPING.growth);
        const ms = typer.show ? rand(TYPING.burst) : rand(TYPING.pause) * stretch;
        typer.timer = setTimeout(typerStep, ms);
    }

    function typerStart() {
        if (typer.on) return;
        typer.on = true;
        typer.show = false;
        typer.t0 = Date.now();
        paintTyping(false, true);
        typer.timer = setTimeout(typerStep, rand(TYPING.startDelay));
    }

    function typerStop() {
        typer.on = false;
        typer.show = false;
        clearTimeout(typer.timer);
    }

    function syncTyper() {
        const s = getSettings();
        if (generating && s.enabled && s.humanTyping) {
            typerStart(); // no-op when already running
            return;
        }
        typerStop();
        paintTyping(generating, false); // classic: steady while generating, off otherwise
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

        syncTyper();

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
      <label class="checkbox_label"><input type="checkbox" id="cb_retry"><span>ตอบไม่ครบ → ลองใหม่อัตโนมัติ 1 ครั้ง</span></label>
      <label class="checkbox_label"><input type="checkbox" id="cb_human"><span>กำลังพิมพ์แบบพิมพ์ๆ หยุดๆ (ยิ่ง AI คิดนาน ยิ่งหยุดนาน)</span></label>
      <div class="cb-row">
        <span>สีบับเบิ้ลของฉัน</span>
        <input type="color" id="cb_color">
      </div>
      <div class="cb-row">
        <span>จำนวนบับเบิ้ล (สุ่มทุกครั้ง)</span>
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
        <div class="cb-row"><b>พรอมต์ที่ส่งให้ AI</b> <small>ใช้ {{n}} = จำนวนบับเบิ้ลรอบนี้, {{style}} = สไตล์สุ่ม</small></div>
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

        $('#cb_retry').prop('checked', s.autoRetry).on('change', function () {
            s.autoRetry = this.checked;
            save();
        });

        $('#cb_human').prop('checked', s.humanTyping).on('change', function () {
            s.humanTyping = this.checked;
            save();
            syncTyper();
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
            rollTurn();
            applyPrompt();
        });

        $('#cb_max').val(s.maxBubbles).on('change', function () {
            s.maxBubbles = clamp(this.value, s.maxBubbles);
            if (s.maxBubbles < s.minBubbles) s.minBubbles = s.maxBubbles;
            $('#cb_min').val(s.minBubbles);
            $('#cb_max').val(s.maxBubbles);
            save();
            rollTurn();
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
        rollTurn();
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
            liveText = false;
            genStart = Date.now();
            animUntil = Infinity;
            rollTurn(); // new random bubble count for this reply
            applyPrompt();
            updateTyping();
        });

        const ended = (stopped) => {
            const was = generating;
            generating = false;
            liveText = false;
            animUntil = Date.now() + 1500;
            rescan();
            updateTyping();
            if (was && !stopped) setTimeout(checkReply, 600);
        };
        on('GENERATION_ENDED', () => ended(false));
        on('GENERATION_STOPPED', () => ended(true));

        on('CHAT_COMPLETION_PROMPT_READY', onPromptReady);

        on('CHAT_CHANGED', () => {
            retries.clear();
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
