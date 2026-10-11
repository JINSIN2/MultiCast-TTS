// Optional screenplay parser. No chat, settings, network, or playback side effects.
const QUOTES = new Map([['"', '"'], ['“', '”'], ['「', '」'], ['『', '』']]);
const BRACKETS = new Map([['(', ')'], ['（', '）'], ['[', ']'], ['【', '】']]);
const RESERVED = /^(?:장소|시간|상황|배경|지문|해설|나레이션|내레이션|장면|제목|주제|scene|setting|time|location|narrator|narration|act|episode|sub-theme)(?:\s*\d+)?$/i;

function attr(text, name) {
    const m = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i').exec(text);
    return (m?.[1] ?? m?.[2] ?? m?.[3] ?? '').trim();
}

function header(line) {
    const text = line.trim().replace(/^[-•]\s+/, '');
    const bold = /^\*\*([^*\n]+)\*\*\s*[:：]?\s*(.*)$/.exec(text);
    const plain = /^([^:：\n]+)[:：]\s*(.*)$/.exec(text);
    const match = bold || plain;
    if (!match) return null;
    if (bold && bold[2] && !/[:：]\s*(?:\*\*)?\s*/.test(text.slice(0, text.length - bold[2].length))) return null;
    const name = match[1].replace(/[:：]\s*$/, '').trim();
    if (!name || name.length > 60 || !/\p{L}/u.test(name)
        || /[<>*#"“”「」『』()[\]{}!?！？。;,，]/u.test(name)
        || name.split(/\s+/).length > 6 || RESERVED.test(name)) return null;
    return { name, rest: match[2] };
}

function plainText(text) {
    return String(text).replace(/<[^>]*>/g, '').replace(/\*\*|__/g, '').trim();
}

function unquote(text) {
    const t = plainText(text);
    return QUOTES.get(t[0]) === t.at(-1) ? t.slice(1, -1).trim() : t;
}

/** Null means ambiguous/unlabelled dialogue: let the existing classifier handle it. */
export function parseScreenplay(raw, { includeThoughts = true, sfxEnabled = false, sfxMax = 0 } = {}) {
    const source = String(raw ?? '').replace(/```[\s\S]*?```/g, '')
        .replace(/<(style|script)\b[^>]*>[\s\S]*?<\/\1>/gi, '')
        .replace(/<br\s*\/?>|<\/p\s*>/gi, '\n')
        .replace(/<(?!\/?(?:v|sfx)\b)[^>]+>/gi, '');
    const blocks = [];
    const protectedSpans = [...source.matchAll(/<v\b[^>]*>[\s\S]*?<\/v\s*>|<sfx\b[^>]*>|"[^\"]*"|“[^”]*”|「[^」]*」|『[^』]*』|\([^)]*\)|（[^）]*）/gi)]
        .map(m => [m.index, m.index + m[0].length]);
    let offset = 0;
    let span = 0;
    let headers = 0;
    let block = { speaker: '', body: '' };
    for (const line of source.split(/\r?\n/)) {
        while (span < protectedSpans.length && protectedSpans[span][1] <= offset) span++;
        const inside = span < protectedSpans.length && protectedSpans[span][0] < offset && offset < protectedSpans[span][1];
        offset += line.length + (source.slice(offset + line.length, offset + line.length + 2) === '\r\n' ? 2 : 1);
        if (!inside && /^\s*(?:#{1,6}\s|---+\s*$|\*\*\*+\s*$)/.test(line)) {
            blocks.push(block);
            block = { speaker: '', body: '' };
            continue;
        }
        const h = inside ? null : header(line);
        if (h) {
            headers++;
            blocks.push(block);
            block = { speaker: h.name, body: h.rest };
        } else block.body += '\n' + line;
    }
    blocks.push(block);
    if (!headers) return null; // Ordinary prose stays on the existing path, even with rocket tags.
    const lines = [];
    let sounds = 0;
    let ambiguous = false;
    const add = (speaker, text, tag = '', type = 'speech', emotionKnown = false) => {
        text = plainText(text);
        if (!/\p{L}/u.test(text)) return;
        if (!speaker) { ambiguous = true; return; }
        lines.push({ speaker, gender: 'u', type, tag: tag.replace(/[\[\]\r\n|]/g, '').trim(), text, _emotionKnown: emotionKnown });
    };
    for (const { speaker, body } of blocks) {
        let rest = '';
        let explicit = false;
        for (let i = 0; i < body.length;) {
            const tail = body.slice(i);
            const voice = /^<v\b([^>]*)>([\s\S]*?)<\/v\s*>/i.exec(tail);
            if (voice) {
                explicit = true;
                const thought = /^(?:1|true|yes)$/i.test(attr(voice[1], 't'));
                if (!thought || includeThoughts) add(attr(voice[1], 'n') || speaker, unquote(voice[2]).replace(/^\*|\*$/g, ''), attr(voice[1], 'e'), thought ? 'thought' : 'speech', /\be\s*=/i.test(voice[1]));
                i += voice[0].length;
                continue;
            }
            const sfx = /^<sfx\b([^>]*?)\/?>(?:\s*<\/sfx\s*>)?/i.exec(tail);
            if (sfx) {
                const name = attr(sfx[1], 'n').replace(/[\[\]\r\n]/g, '').trim();
                if (name && sfxEnabled && sounds < sfxMax) {
                    lines.push({ speaker: 'SFX', gender: 'u', type: 'sfx', tag: '', text: `[${name}]` });
                    sounds++;
                }
                i += sfx[0].length;
                continue;
            }
            if (/^<\/?v\b/i.test(tail)) return null; // Never read malformed tag attributes aloud.
            const endQuote = QUOTES.get(body[i]);
            if (endQuote) {
                const end = body.indexOf(endQuote, i + 1);
                if (end < 0) return null;
                add(speaker, body.slice(i + 1, end));
                explicit = true;
                i = end + 1;
                continue;
            }
            const bracket = BRACKETS.get(body[i]);
            if (bracket) {
                const stack = [bracket];
                let j = i + 1;
                for (; j < body.length && stack.length; j++) {
                    if (BRACKETS.has(body[j])) stack.push(BRACKETS.get(body[j]));
                    else if (body[j] === stack.at(-1)) stack.pop();
                }
                if (stack.length) return null;
                rest += ' ';
                i = j;
                continue;
            }
            if (body[i] === '*' && body[i + 1] !== '*') {
                const end = body.indexOf('*', i + 1);
                if (end < 0) return null;
                rest += ' ';
                i = end + 1;
                continue;
            }
            // Inline bold is emphasis, not an action or a new speaker.
            if (body.slice(i, i + 2) === '**') { i += 2; continue; }
            rest += body[i++];
        }
        if (!explicit && speaker) {
            // Unquoted speech is the first paragraph following a name.
            // Later unmarked prose cannot safely be distinguished from more speech.
            const paragraphs = rest.trim().split(/\n\s*\n/).filter(p => /\p{L}/u.test(p));
            if (paragraphs.length > 1) return null;
            if (paragraphs.length) add(speaker, paragraphs[0]);
        }
    }
    return !ambiguous && lines.some(l => l.type === 'speech' || l.type === 'thought') ? lines : null;
}

/** Apply only short delivery tags to the requested line numbers; never edit speaker/text/order. */
export function applyScreenplayEmotions(script, pending, raw) {
    const allowed = new Set(pending);
    const labels = new Map();
    const cleaned = String(raw ?? '').replace(/<think(?:ing)?>[\s\S]*?<\/think(?:ing)?>/gi, '').replace(/```[^\n]*\n?|```/g, '');
    for (const line of cleaned.split(/\r?\n/)) {
        const m = /^\s*(\d+)\s*\|\s*([a-zA-Z][a-zA-Z -]{0,59})?\s*$/.exec(line);
        if (!m) continue;
        const index = Number(m[1]) - 1;
        if (!allowed.has(index) || labels.has(index)) continue;
        const tag = (m[2] || '').trim();
        labels.set(index, /^(?:neutral|none)$/i.test(tag) ? '' : tag);
    }
    return { script: script.map((line, i) => labels.has(i) ? { ...line, tag: labels.get(i) } : line), missing: pending.filter(i => !labels.has(i)).length };
}
