// MultiCast TTS — ElevenLabs multi-voice TTS for SillyTavern
// (internal ids stay 'voice_cast' so existing settings and saved scripts keep working)
// Extracts dialogue + inner thoughts with a separate LLM call, tags speaker/gender/emotion,
// and plays each line with its own ElevenLabs voice (audio tags supported on v3/v4).

const MODULE_NAME = 'voice_cast';
const LOG = '[MultiCast TTS]';

// Text to Speech page — the generation History panel lives here
const ELEVENLABS_HISTORY_URL = 'https://elevenlabs.io/app/speech-synthesis/text-to-speech';

const MODELS = [
    { id: 'eleven_v4', label: 'Eleven v4 (오디오 태그 O)', tags: true },
    { id: 'eleven_v4_turbo', label: 'Eleven v4 Turbo (오디오 태그 O)', tags: true },
    { id: 'eleven_v3', label: 'Eleven v3 (오디오 태그 O)', tags: true, snapStability: true },
    { id: 'eleven_multilingual_v2', label: 'Multilingual v2 (태그 X)', tags: false },
    { id: 'eleven_flash_v2_5', label: 'Flash v2.5 (태그 X)', tags: false },
    { id: 'eleven_turbo_v2_5', label: 'Turbo v2.5 (태그 X)', tags: false },
];

const defaultSettings = Object.freeze({
    enabled: true,
    autoPlay: false,
    pregenerate: false,
    highlight: true,
    quickButtons: false,     // show 🔊/📜 on the message itself instead of only in the … menu
    lineButtons: false,      // small ▶ next to each line that already has audio
    readMode: 'off',         // 'off' | 'all' (make every line on arrival) | 'tap' (classify on arrival, make a line when tapped)
    includeThoughts: true,
    preferTranslation: true, // legacy, replaced by voiceLang
    voiceLang: 'display',    // 'display' (what's on screen) | 'original' | 'translate'
    translateTo: 'English',
    translationWaitSec: 0,

    profileId: '',
    maxTokens: 4096,
    contextChars: 1500,
    fastClassify: true,      // number the quotes locally; the AI only answers who/how per number
    inlineTags: false,       // the RP model marks each line with <v n="who" e="how"> — no classifier call at all
    holdToPlay: false,       // press and hold a line of dialogue to hear it (a short tap stays free for translators)
    soloBots: {},            // { botKey: true } — 1인 모드: no AI classification, every quote is the bot's line
    extraInstructions: '',
    pacing: 'off',           // legacy preset (2.8.0+: the pause sliders below)
    pauseSame: 0,            // ms before the same speaker's next line
    pauseChange: 0,          // ms when the speaker changes
    pauseNarr: 0,            // × how long narration in between takes to read (0 = ignore it)
    pauseBetween: 600,       // ms when going on to the next message
    continuePlay: false,     // after a message, go on to the next one
    continueMode: 'saved',
    stepMode: false,
    listenOnly: {},          // per bot: { on: bool, keys: [...], known: [...], others: bool } — 특정 캐릭터만 듣기
    rate: 1,                 // playback speed (no credits — applies to saved audio too)
    openGroups: ['start', 'cast'],         // one line per ⏭ press (waits after each line)   // 'saved' (only messages that already have audio — no credits) | 'all'
    emotionLevel: 'natural', // 'subtle' | 'natural' | 'strong' — how big the delivery tags may get

    model: 'eleven_v4',
    stability: 0.5,
    similarity: 0.75,
    useTags: true,
    thoughtTag: 'whispering',
    concurrency: 2,
    volume: 1,
    audioCacheMB: 300,

    maleVoiceId: '',
    femaleVoiceId: '',
    unknownVoiceId: '',
    sfxEnabled: false,
    player: true,           // bottom mini player (swipe up / tap the little handle)       
    sfxVoiceId: '',
    sfxLocal: true,
    adultSfx: false,         // 🔞 also tag intimate sounds in adult scenes (kissing, wet sounds, skin slapping …)
    sfxOverlay: false,       // play sound effects under the voices instead of as their own turn
    customSfx: [],           // [{ id, name, words }] — user's own sound files (audio kept in IndexedDB, not in settings)          // bundled CC0 sound files first (free, any model); ElevenLabs tag only when nothing fits
    cast: [],        // shared cast (applies to every bot)
    castByBot: {},   // { 'char:<avatar>' | 'group:<id>': [entries] }
    castAutoSeen: {}, // { botKey: [names already auto-filled] }
});

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

function getSettings() {
    const { extensionSettings } = SillyTavern.getContext();
    if (!extensionSettings[MODULE_NAME]) {
        extensionSettings[MODULE_NAME] = structuredClone(defaultSettings);
    }
    const s = extensionSettings[MODULE_NAME];
    for (const key of Object.keys(defaultSettings)) {
        if (!Object.hasOwn(s, key)) {
            s[key] = structuredClone(defaultSettings[key]);
        }
    }
    if (!Array.isArray(s.cast)) s.cast = [];
    if (!s.castByBot || typeof s.castByBot !== 'object') s.castByBot = {};
    if (!s.castAutoSeen || typeof s.castAutoSeen !== 'object') s.castAutoSeen = {};
    if (ensureCastIds(s)) setTimeout(save, 0); // new ids are saved right away so they stay the same after a reload
    if (!s._migratedVoiceLang) {
        if (s.preferTranslation === false) s.voiceLang = 'original';
        s._migratedVoiceLang = true;
    }
    if (!['display', 'original', 'translate'].includes(s.voiceLang)) s.voiceLang = 'display';
    // v1.2 migration: thinking models need more room than the old 2048 default
    if (!s._migratedMaxTokens) {
        if (Number(s.maxTokens) === 2048) s.maxTokens = 4096;
        s._migratedMaxTokens = true;
    }
    // Enable the requested player default once for existing installations too.
    // Later changes made with its checkbox remain respected.
    if (!s._migratedPlayerDefaultOn) {
        s.player = true;
        s._migratedPlayerDefaultOn = true;
    }
    // 2.8.0: 호흡 preset → sliders
    if (!s._migratedPauseSliders) {
        const p = PACING[s.pacing];
        if (p) Object.assign(s, { pauseSame: p.same, pauseChange: p.change, pauseNarr: p.perChar / 12, pauseBetween: p.between });
        s._migratedPauseSliders = true;
    }
    // 2.6.3: 빠른 분류 left BETA and is on by default — switch it on once for existing installs too.
    if (!s._migratedFastClassifyOn) {
        s.fastClassify = true;
        s._migratedFastClassifyOn = true;
    }
    // Preserve the previously visible buttons once; future visibility is independent of listening mode.
    if (!s._migratedIndependentLineButtons) {
        if (s.readMode === 'all' || s.readMode === 'tap') s.lineButtons = true;
        s._migratedIndependentLineButtons = true;
    }
    return s;
}

// Keep the existing persisted fields compatible with older exported settings.
function listeningMode() {
    const s = getSettings();
    if (s.readMode === 'all' || s.readMode === 'tap') return 'read';
    return s.autoPlay ? 'auto' : 'manual';
}

function setListeningMode(mode, precreate = false) {
    const s = getSettings();
    s.autoPlay = mode === 'auto';
    s.readMode = mode === 'read' ? (precreate ? 'all' : 'tap') : 'off';
    s.pregenerate = mode === 'manual' && !!precreate;
    save();
}

function syncListeningUI() {
    const mode = listeningMode();
    const s = getSettings();
    $('#voice_cast_listening_mode').val(mode);
    $('#voice_cast_precreate_options').toggle(mode !== 'auto');
    $('#voice_cast_precreate').prop('checked', mode === 'read' ? s.readMode === 'all' : s.pregenerate);
    $('#voice_cast_listening_hint').text(mode === 'auto'
        ? '새 답변의 대사를 만들고 바로 재생해요. 음성 생성에 크레딧을 써요.'
        : mode === 'read'
            ? '새 답변의 대사를 AI로 분류해요. 아래 ▶ 표시를 켜면 대사별로 들을 수 있어요. 기본적으로 누른 대사만 음성을 만들며, 분류 AI 사용료는 별도예요.'
            : '메시지의 🔊를 누르면 대사를 분류하고 재생해요. 저장된 음성은 다시 사용해요.');
}

function save() {
    SillyTavern.getContext().saveSettingsDebounced();
}

function modelInfo(id) {
    // Unknown (custom-typed) models: assume audio tags work — the "use tags" checkbox still controls it.
    return MODELS.find(m => m.id === id) ?? { id, label: id, tags: true, snapStability: /^eleven_v3/.test(id) };
}

function isPresetModel(id) {
    return MODELS.some(m => m.id === id);
}

// ---------------------------------------------------------------------------
// Text helpers
// ---------------------------------------------------------------------------

function hashString(str) {
    let h = 5381;
    for (let i = 0; i < str.length; i++) {
        h = ((h << 5) + h + str.charCodeAt(i)) | 0;
    }
    return (h >>> 0).toString(36);
}

function cleanMessageText(text) {
    if (!text) return '';
    return String(text)
        .replace(/```[\s\S]*?```/g, ' ')          // code blocks
        .replace(/<(style|script)[\s\S]*?<\/\1>/gi, ' ')
        .replace(/<\/?(?:v|sfx)\b[^>]*>/gi, '')    // voice tags vanish without a trace (same text before and after they're stripped)
        .replace(/<[^>]+>/g, ' ')                  // html tags
        .replace(/[ \t]+/g, ' ')
        .trim();
}

/** Translation currently shown on screen (LLM Translator → display_text, Mirror Translator → its own data). */
function getShownTranslation(message) {
    const mirror = message?.extra?.mirror_translator;
    if (mirror && typeof mirror === 'object' && mirror.showing === 'translation' && mirror.source === message.mes && mirror.display) {
        return mirror.display;
    }
    return message?.extra?.display_text || '';
}

/** LLM Translator's side-by-side mode puts both languages in display_text as paired spans. */
function bilingualParts(displayText) {
    const grab = cls => [...String(displayText ?? '').matchAll(new RegExp(`<span class="${cls}[^"]*">([\\s\\S]*?)</span>`, 'g'))].map(m => m[1]);
    const trans = grab('translated_text');
    const orig = grab('original_text');
    return trans.length && trans.length === orig.length ? { trans, orig } : null;
}

/** Text the voices are based on: what's on screen (translation), or the original message. */
function getMessageText(message) {
    const s = getSettings();
    const shown = getShownTranslation(message);
    const pairs = bilingualParts(shown);
    const translated = pairs ? pairs.trans.join('\n') : shown;
    if (s.voiceLang === 'display' && translated) return cleanMessageText(translated);
    return cleanMessageText(message?.mes ?? '');
}

/** Per-character temperament (cast row) → hint for the classifier's delivery tags. */
const TEMPERS = {
    calm: { label: '차분함', range: 2, hint: 'calm and composed; keeps emotions restrained, rarely raises their voice — even when upset, sounds firm or cold rather than shouting' },
    hot: { label: '다혈질', range: 5, hint: 'hot-tempered and expressive; reacts strongly, raises their voice easily' },
    cold: { label: '냉정·무뚝뚝', range: 1, hint: 'cool and blunt; flat, understated delivery with little visible emotion' },
    gentle: { label: '다정함', range: 2, hint: 'gentle and warm; soft, kind delivery, rarely harsh' },
    cheerful: { label: '밝음', range: 4, hint: 'cheerful and lively; upbeat, energetic delivery' },
    shy: { label: '소심·수줍음', range: 2, hint: 'shy and timid; hesitant, quiet delivery, often nervous or flustered' },
    playful: { label: '장난스러움', range: 3, hint: 'playful and teasing; light, mischievous delivery' },
};

/** 감정 폭 1~5: how far up the emotion ladders a character may go. */
const RANGE_LABELS = { 1: '아주 절제', 2: '절제', 3: '보통', 4: '풍부', 5: '격정적' };
const GLOBAL_RANGE = { subtle: 2, natural: 3, strong: 5 };

const EMOTION_LADDERS = [
    'Emotion ladders (step 1 → 5). Pick the tag from the step that fits the moment, but NEVER above the speaker\'s emotional range:',
    '  anger:   calm/flat → firm → irritated → angry → furious/shouting',
    '  sadness: wistful → subdued → sad → tearful → crying/sobbing',
    '  joy:     warm → amused → cheerful → laughing → ecstatic',
    '  fear:    uneasy → hesitant → nervous → scared → panicked/screaming',
    '  surprise: curious → surprised → startled → shocked → gasping',
    '  affection: soft → warm → tender → loving → passionate',
    'Example: with range 2, even a furious moment is voiced as "firm" (anger step 2) — the voice rises only a little; with range 5 it can be "shouting".',
    'Ordinary lines without a clear emotion keep an empty tag.',
].join('\n');

/** A character's emotional range: cast row setting → temperament default → global setting. */
function rangeFor(entry) {
    return rangeInfo(entry).range;
}

function rangeInfo(entry) {
    const r = Number(entry?.range);
    if (r >= 1 && r <= 5) return { range: r, own: true };
    if (TEMPERS[entry?.temper]?.range) return { range: TEMPERS[entry.temper].range, own: true };
    const level = getSettings().emotionLevel;
    return { range: GLOBAL_RANGE[level] ?? 3, own: level !== 'natural' };
}

/** Emotion words from the ladders — only these get softened/strengthened. */
const EMOTION_WORDS = new Set(['firm', 'irritated', 'angry', 'furious', 'shouting', 'stern', 'annoyed', 'wistful', 'subdued', 'sad', 'tearful',
    'crying', 'sobbing', 'warm', 'amused', 'cheerful', 'laughing', 'ecstatic', 'excited', 'uneasy', 'hesitant', 'nervous', 'scared',
    'panicked', 'screaming', 'surprised', 'startled', 'shocked', 'tender', 'loving', 'passionate', 'frustrated', 'upset', 'cold', 'bitter']);

/**
 * The tag alone makes v3/v4 act it out fully — so a restrained character's tag is softened in words
 * ("slightly irritated"), and the voice is made steadier (higher stability).
 */
function shapeTag(tag, line) {
    const t = String(tag ?? '').trim();
    if (!t || line?.type === 'sfx') return t;
    const entry = findCastEntry(line?.speaker);
    const { range, own } = rangeInfo(entry);
    if (!own || !EMOTION_WORDS.has(t.toLowerCase())) return t;
    if (range <= 1) return `faintly ${t}, holding it back`;
    if (range === 2) return `slightly ${t}, restrained`;
    if (range >= 5) return `very ${t}`;
    return t;
}

/** Stability offset from the emotional range (only when the character/global setting asks for it). */
function rangeStability(entry, base) {
    const { range, own } = rangeInfo(entry);
    if (!own) return base;
    const map = { 1: 0.95, 2: 0.8, 3: base, 4: Math.max(0, base - 0.15), 5: Math.max(0, base - 0.3) };
    return range === 1 || range === 2 ? Math.max(base, map[range]) : map[range];
}

const EMOTION_RULES = {
    subtle: '- Keep the acting SUBTLE. Prefer mild, understated tags (e.g. irritated, firm, wistful, amused, soft, hesitant, warm, serious) and leave "tag" empty for ordinary lines. Use intense tags (shouting, furious, sobbing, screaming) ONLY when the text explicitly shows it (e.g. "she yelled", ALL CAPS, multiple exclamation marks).',
    natural: '- Match the intensity actually written in the text — do not exaggerate. When unsure between two tags, pick the milder one (e.g. irritated instead of angry, firm instead of stern, amused instead of laughing). Ordinary lines can have an empty tag.',
    strong: '- Act it out expressively: choose vivid, emotional tags that make the delivery dramatic.',
};

const VOICE_LANG_LABELS = { display: '화면에 보이는 대로', original: '원문 그대로', translate: 'AI 번역' };

function voiceLangLabel() {
    const s = getSettings();
    return s.voiceLang === 'translate' ? `AI 번역 → ${s.translateTo || 'English'}` : VOICE_LANG_LABELS[s.voiceLang];
}

/** Each language mode keeps its own script per message, so switching back and forth costs nothing. */
function variantKey() {
    const s = getSettings();
    return s.voiceLang === 'translate' ? `tr:${String(s.translateTo || 'English').trim().toLowerCase()}` : s.voiceLang;
}

function getStoredEntry(message) {
    const root = message?.extra?.[MODULE_NAME];
    if (!root) return null;
    if (root.variants?.[variantKey()]) return root.variants[variantKey()];
    if (Array.isArray(root.script) && !root.variants) return root; // pre-1.6 data (validated by hash)
    return null;
}

function setStoredEntry(message, entry) {
    setTimeout(markAllScriptButtons, 0); // 📜 brightens once a script exists
    message.extra = message.extra ?? {};
    const root = (message.extra[MODULE_NAME] ??= {});
    if (Array.isArray(root.script) && !root.variants) {
        // migrate pre-1.6 single script into the 'display' slot
        root.variants = { display: { hash: root.hash, textHash: root.textHash, script: root.script, edited: root.edited } };
    }
    root.variants ??= {};
    delete root.script; delete root.hash; delete root.textHash; delete root.edited;
    root.variants[variantKey()] = entry;
}

function normName(str) {
    return String(str ?? '').trim().toLowerCase().replace(/\s+/g, '');
}

// ---------------------------------------------------------------------------
// Per-bot cast
// ---------------------------------------------------------------------------

/** The bot (character card or group) of the open chat, or null when no chat is open. */
function currentBot() {
    const ctx = SillyTavern.getContext();
    if (ctx.groupId) {
        const g = ctx.groups?.find(x => x.id === ctx.groupId);
        if (!g) return null;
        const members = (g.members ?? []).map(a => ctx.characters?.find(c => c.avatar === a)?.name).filter(Boolean);
        return { key: `group:${g.id}`, name: g.name || '그룹', members };
    }
    if (ctx.characterId !== undefined && ctx.characterId !== null && ctx.characterId !== '') {
        const c = ctx.characters?.[ctx.characterId];
        if (c) return { key: `char:${c.avatar}`, name: c.name, members: [c.name] };
    }
    return null;
}

function getBotCast(create = false) {
    const s = getSettings();
    const bot = currentBot();
    if (!bot) return null;
    if (!Array.isArray(s.castByBot[bot.key]) && create) s.castByBot[bot.key] = [];
    return s.castByBot[bot.key] ?? null;
}

/** Bot cast first (more specific), then the shared cast. */
/** Every cast row gets an id that never changes (renaming keeps it) — other extensions link to it. */
function newCastId() {
    return 'mc_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}
function ensureCastIds(s) {
    const seen = new Set();
    let changed = false;
    const fix = (list) => {
        if (!Array.isArray(list)) return;
        for (const e of list) {
            if (!e || typeof e !== 'object') continue;
            if (!e.id || seen.has(e.id)) { e.id = newCastId(); changed = true; } // missing or copied → a fresh one
            seen.add(e.id);
        }
    };
    fix(s.cast);
    for (const list of Object.values(s.castByBot ?? {})) fix(list);
    return changed;
}

function allCastEntries() {
    return [...(getBotCast() ?? []), ...getSettings().cast];
}

function entryNames(entry, userName) {
    const u = normName(userName);
    return String(entry.names ?? '').split(',').map(normName).filter(Boolean)
        .map(n => (n === '{{user}}' ? u : n));
}

/** Like the built-in TTS: make sure the open chat's characters and the persona have a row. */
function ensureBotCast() {
    const bot = currentBot();
    if (!bot) return;
    const userName = SillyTavern.getContext().name1;
    const s = getSettings();
    const list = getBotCast(true);
    // names already auto-added once for this bot — never re-added, so deleting/renaming a row sticks
    const seen = (s.castAutoSeen[bot.key] ??= []);
    const known = name => allCastEntries().some(e => entryNames(e, userName).includes(normName(name)));
    let changed = false;
    for (const name of bot.members) {
        if (!name || seen.includes(normName(name))) continue;
        seen.push(normName(name));
        changed = true;
        if (!known(name)) list.push({ names: name, gender: 'u', voiceId: '' });
    }
    // The persona row: ST may switch to the bot's linked persona a moment after the chat opens,
    // so an auto-added persona row that has no voice yet follows the current persona.
    const autoUser = [...list].reverse().find(e => e.autoUser);
    const untouched = autoUser && !autoUser.voiceId && normName(autoUser.names) === normName(autoUser.autoUser);
    if (userName && untouched && normName(autoUser.names) !== normName(userName)) {
        if (known(userName)) list.splice(list.indexOf(autoUser), 1);
        else { autoUser.names = userName; autoUser.autoUser = userName; }
        if (!seen.includes(normName(userName))) seen.push(normName(userName));
        changed = true;
    } else if (userName && !seen.includes(normName(userName))) {
        seen.push(normName(userName));
        changed = true;
        if (!known(userName)) list.push({ names: userName, gender: 'u', voiceId: '', autoUser: userName });
    }
    if (changed) save();
}

// ---------------------------------------------------------------------------
// Classifier (separate LLM call)
// ---------------------------------------------------------------------------

/**
 * The user's character in this part of the chat: the name on the user's own messages
 * (the selected persona can differ from the one the chat was written with).
 */
function userNameFor(messageId) {
    const ctx = SillyTavern.getContext();
    const chat = ctx.chat ?? [];
    if (Number.isInteger(messageId)) {
        for (let j = Math.min(messageId, chat.length - 1); j >= 0; j--) {
            if (chat[j]?.is_user && chat[j].name) return chat[j].name;
        }
        for (let j = messageId + 1; j < chat.length; j++) {
            if (chat[j]?.is_user && chat[j].name) return chat[j].name;
        }
    }
    return ctx.name1 || 'User';
}

function buildClassifierPrompt(text, prevText, userNameOverride = null) {
    const s = getSettings();
    const ctx = SillyTavern.getContext();
    const userName = userNameOverride || ctx.name1 || 'User';
    const known = knownCharactersList(userName);
    return buildClassifierPromptFrom(known, userName, text, prevText);
}

function knownCharactersList(userName) {
    const ctx = SillyTavern.getContext();
    const charName = ctx.name2 || '';
    const known = [];
    known.push(`- ${userName} (the user's own character)`);
    if (charName && charName !== userName) known.push(`- ${charName} (main character of this chat)`);
    if (ctx.groupId) {
        const group = ctx.groups?.find(g => g.id === ctx.groupId);
        for (const avatar of group?.members ?? []) {
            const c = ctx.characters?.find(ch => ch.avatar === avatar);
            if (c?.name && c.name !== charName) known.push(`- ${c.name}`);
        }
    }
    for (const entry of allCastEntries()) {
        const names = String(entry.names ?? '').split(',').map(n => n.trim()).filter(Boolean)
            .map(n => (n.toLowerCase() === '{{user}}' ? userName : n));
        if (!names.length) continue;
        const g = entry.gender === 'm' ? 'male' : entry.gender === 'f' ? 'female' : 'unknown gender';
        const extra = [`emotional range: ${rangeFor(entry)}/5`];
        if (TEMPERS[entry.temper]) extra.push(`temperament: ${TEMPERS[entry.temper].hint}`);
        if (String(entry.actingNote ?? '').trim()) extra.push(`acting note: ${String(entry.actingNote).trim()}`);
        known.push(`- ${names[0]}${names.length > 1 ? ` (aliases: ${names.slice(1).join(', ')})` : ''} — ${g}${extra.length ? `; ${extra.join('; ')}` : ''}`);
    }
    return known;
}

const ADULT_SFX_RULE = '- Adult scenes (all characters adults): ALSO add sound entries for intimate sounds the narration describes — e.g. kissing, wet sounds, sucking, licking, skin slapping, bed creaking, heavy breathing, rustling sheets. Use plain short English tags (kiss, wet squelch, slurp, skin slap, bed creak, panting). These may be soft; do not skip them.';
function sfxLimit() {
    return getSettings().adultSfx ? 8 : 3;
}

function buildClassifierPromptFrom(known, userName, text, prevText) {
    const s = getSettings();

    const translating = s.voiceLang === 'translate';
    const targetLang = String(s.translateTo || 'English').trim() || 'English';

    const thoughtRule = s.includeThoughts
        ? `- Inner thoughts are usually written inside *asterisks*, BUT asterisks are also used for narration. Extract asterisk text ONLY when it is clearly a character's internal monologue (first-person thinking), never descriptions of actions, scenery, or third-person narration. Mark these with "type":"thought".`
        : '- Do NOT extract inner thoughts. Extract spoken dialogue only.';

    const system = [
        'You are a voice-acting script extractor for a text-to-speech engine.',
        'Read a roleplay message and extract ONLY spoken dialogue lines' + (s.includeThoughts ? ' and inner thoughts' : '') + ', in the exact order they appear. Ignore all narration.',
        '',
        'Rules:',
        '- Spoken dialogue is usually inside quotes ("...", “...”, 「...」, 『...』). Mark these with "type":"speech".',
        thoughtRule,
        translating
            ? `- "orig": copy the line EXACTLY as written in the message, without the surrounding quotes or asterisks. Remove any narration that interrupts a line.\n- "text": translate "orig" into natural, spoken ${targetLang} that keeps the character's tone, speech style, and emotion (casual stays casual, rough stays rough). Translate the whole line faithfully; do not summarize, censor, or add lines.`
            : '- "text": copy the line EXACTLY as written, in its original language, without the surrounding quotes or asterisks. Never translate, summarize, censor, or add words. Remove any narration that interrupts a line.',
        `- "speaker": who says/thinks it. Use the exact name from the known characters list when it matches. The user's character is "${userName}" — in impersonation-style messages the user's character may also speak. Unnamed side characters get a short descriptive English label (e.g. "waiter", "old man"). Use "unknown" only if truly impossible to tell.`,
        '- "gender": "m", "f", or "u". Infer from names, pronouns, honorifics, and context. Use the gender given in the known characters list when available.',
        '- "tag": ONE short English delivery tag for voice acting, describing HOW the line is said: e.g. soft, warm, calm, firm, serious, irritated, amused, teasing, hesitant, nervous, sad, wistful, tired, sarcastic, cold, flustered, excited, laughing, sighing, whispering, angry, shouting, crying, pleading. Use "" for neutral delivery.',
        '- Match the intensity actually written in the text — do not exaggerate. When unsure between two steps, pick the lower one.',
        `- Every speaker has an emotional range from 1 (very restrained) to 5 (very expressive). Characters in the known list show theirs; anyone else uses ${GLOBAL_RANGE[s.emotionLevel] ?? 3}/5.`,
        EMOTION_LADDERS,
        ...(s.sfxEnabled ? [
            `- Sound effects: when the NARRATION clearly describes a distinct, audible sound (e.g. a door creaking or slamming, footsteps, thunder rumbling, clapping, a dog barking, glass shattering, a loud knock, a gunshot), add a SEPARATE entry at the point where it happens: {"speaker":"SFX","gender":"u","type":"sfx","tag":"","text":"[door creaking]"}. "text" is ONE short English sound tag in square brackets. At most ${sfxLimit()} per message. Skip quiet or vague sounds, and never put sound tags inside dialogue lines.`,
            ...(s.adultSfx ? [ADULT_SFX_RULE] : []),
            `- Prefer these sound tags when one fits: ${[...customSfxLibrary().flatMap(e => e.words.filter(w => !w.startsWith('~'))), SFX_TAG_HINT].join(', ')}.`,
            ...(translating ? ['- Sound-effect entries are NEVER translated: their "text" stays the English sound tag in [brackets].'] : []),
        ] : []),
        '- Also follow each character\'s temperament and acting note (a calm character stays composed; a hot-tempered one reacts sooner and stronger, within their range).',
        '- Output ONLY a valid JSON array. No prose, no markdown, no code fences. Escape any double quote inside a string as \\". If there is nothing to extract, output [].',
        '',
        'Format:',
        translating
            ? '[{"speaker":"Name","gender":"f","type":"speech","tag":"angry","orig":"...","text":"..."}]'
            : '[{"speaker":"Name","gender":"f","type":"speech","tag":"angry","text":"..."}]',
    ];
    if (s.extraInstructions?.trim()) {
        system.push('', 'Additional instructions from the user:', s.extraInstructions.trim());
    }

    const user = [
        'Known characters:',
        known.join('\n'),
        '',
    ];
    if (prevText) {
        user.push('Previous message (CONTEXT ONLY — do not extract from it):', '<<<', prevText, '>>>', '');
    }
    user.push('Message to extract from:', '<<<', text, '>>>');

    return { system: system.join('\n'), user: user.join('\n') };
}

class ClassifierError extends Error {
    constructor(message, raw) {
        super(message);
        this.raw = raw;
    }
}

/** Pulls every complete top-level {...} object out of a (possibly truncated / messy) string. */
function salvageObjects(str) {
    const out = [];
    let depth = 0;
    let start = -1;
    let inString = false;
    let escaped = false;
    for (let i = 0; i < str.length; i++) {
        const c = str[i];
        if (inString) {
            if (escaped) escaped = false;
            else if (c === '\\') escaped = true;
            else if (c === '"') inString = false;
            continue;
        }
        if (c === '"') inString = true;
        else if (c === '{') {
            if (depth === 0) start = i;
            depth++;
        } else if (c === '}' && depth > 0) {
            depth--;
            if (depth === 0 && start !== -1) {
                try { out.push(JSON.parse(str.slice(start, i + 1))); } catch { /* skip broken object */ }
                start = -1;
            }
        }
    }
    return out;
}

function parseClassifierOutput(raw) {
    const cleaned = String(raw ?? '')
        .replace(/<think>[\s\S]*?<\/think>/gi, '')
        .replace(/<thinking>[\s\S]*?<\/thinking>/gi, '')
        .replace(/```(?:json)?/gi, '')
        .trim();

    if (!cleaned) {
        throw new ClassifierError('분류 AI가 빈 응답을 보냈어요. 검열에 걸렸거나 "최대 응답 토큰"이 부족했을 수 있어요 (생각하는 모델은 4096 이상 추천).', raw);
    }
    if (cleaned === '[]') return [];

    let arr = null;
    let partial = false;

    // 1) the normal case: one JSON array
    const start = cleaned.indexOf('[');
    const end = cleaned.lastIndexOf(']');
    if (start !== -1 && end > start) {
        try {
            const parsed = JSON.parse(cleaned.slice(start, end + 1));
            if (Array.isArray(parsed)) arr = parsed;
        } catch { /* fall through */ }
    }
    // 2) an object wrapping the array, e.g. {"lines":[...]}
    if (!arr) {
        try {
            const obj = JSON.parse(cleaned.slice(cleaned.indexOf('{'), cleaned.lastIndexOf('}') + 1));
            const inner = obj && Object.values(obj).find(v => Array.isArray(v));
            if (inner) arr = inner;
        } catch { /* fall through */ }
    }
    // 3) truncated or messy output: keep whatever complete line objects exist
    if (!arr) {
        const objs = salvageObjects(cleaned).filter(o => typeof o?.text === 'string');
        if (objs.length) {
            arr = objs;
            partial = true;
        }
    }
    if (!arr) {
        throw new ClassifierError('분류 결과에서 대사 목록(JSON)을 찾지 못했어요.', raw);
    }
    if (partial) {
        toastr.warning('분류 결과가 중간에 잘려서 일부 대사만 읽어요. "최대 응답 토큰"을 늘려보세요.', 'MultiCast TTS');
    }

    return arr
        .filter(x => x && typeof x.text === 'string' && x.text.trim())
        .map(x => ({
            speaker: String(x.speaker ?? 'unknown').trim() || 'unknown',
            gender: ['m', 'f'].includes(String(x.gender).toLowerCase()) ? String(x.gender).toLowerCase() : 'u',
            type: x.type === 'thought' ? 'thought' : x.type === 'sfx' ? 'sfx' : 'speech',
            tag: String(x.tag ?? '').replace(/[[\]]/g, '').trim(),
            text: sfxEnglishText(x),
            ...(typeof x.orig === 'string' && x.orig.trim() ? { orig: x.orig.trim() } : {}),
        }));
}

/** Sound tags must stay English (so 내 효과음 / built-in sounds match) — if the AI translated one, use its original. */
function sfxEnglishText(x) {
    const t = String(x.text ?? '').trim();
    if (x.type !== 'sfx' || /[a-z]/i.test(t)) return t;
    const o = String(x.orig ?? '').trim();
    if (!/[a-z]/i.test(o)) return t;
    return o.startsWith('[') ? o : `[${o}]`;
}

async function runClassifier(text, prevText, userName = null) {
    try {
        return await runClassifierOnce(text, prevText, userName);
    } catch (e) {
        if (!(e instanceof ClassifierError)) throw e;
        // one automatic retry — models sometimes answer with prose or get cut off
        console.warn(LOG, 'classifier output unusable, retrying once. Raw output was:', e.raw);
        try {
            return await runClassifierOnce(text, prevText, userName);
        } catch (e2) {
            if (e2 instanceof ClassifierError) {
                console.warn(LOG, 'classifier failed twice. Raw output was:', e2.raw);
                const preview = String(e2.raw ?? '').replace(/\s+/g, ' ').trim().slice(0, 80);
                throw new Error(`${e2.message}${preview ? `\nAI 응답 앞부분: "${preview}…"` : ''}\n(전체 응답은 F12 콘솔에 있어요)`);
            }
            throw e2;
        }
    }
}

async function runClassifierOnce(text, prevText, userName = null) {
    const s = getSettings();
    const ctx = SillyTavern.getContext();
    const { system, user } = buildClassifierPrompt(text, prevText, userName);

    // never spin forever: if the classifier AI doesn't answer, give up with a clear message
    const timeoutSec = 90;
    let timer;
    const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`대사 분류 AI가 ${timeoutSec}초 동안 응답이 없어요. 연결 프로필이나 API 상태를 확인해 주세요.`)), timeoutSec * 1000);
    });
    try {
        return await Promise.race([classifierRequest(s, ctx, system, user), timeout]);
    } finally {
        clearTimeout(timer);
    }
}

async function classifierRequest(s, ctx, system, user) {
    return parseClassifierOutput(await classifierRaw(s, ctx, system, user));
}

async function classifierRaw(s, ctx, system, user) {
    let raw;
    if (s.profileId) {
        const result = await ctx.ConnectionManagerRequestService.sendRequest(
            s.profileId,
            [
                { role: 'system', content: system },
                { role: 'user', content: user },
            ],
            Number(s.maxTokens) || 4096,
        );
        raw = typeof result === 'string' ? result : result?.content;
    } else {
        raw = await ctx.generateRaw({
            systemPrompt: system,
            prompt: user,
            responseLength: Number(s.maxTokens) || 4096,
        });
    }
    console.debug(LOG, 'classifier raw output:', raw);
    return raw;
}

// ---------------------------------------------------------------------------
// Quotes found locally — used by 1인 모드 (no AI) and 빠른 분류 (AI only labels them)
// ---------------------------------------------------------------------------

const QUOTE_RE = /"([^"\n]+)"|\u201C([^\u201D\n]+)\u201D|\u300C([^\u300D\n]+)\u300D|\u300E([^\u300F\n]+)\u300F/g;
const QUOTE_OR_STAR_RE = /"([^"\n]+)"|\u201C([^\u201D\n]+)\u201D|\u300C([^\u300D\n]+)\u300D|\u300E([^\u300F\n]+)\u300F|\*([^*\n]+)\*/g;

/**
 * Every quoted piece with letters in it, in order: { text, start, kind } (start = index of the opening mark).
 * With `stars`, *asterisk* pieces come too (kind 'star') — they may be inner thoughts or just narration.
 */
function quoteSegments(text, { stars = false } = {}) {
    const out = [];
    for (const m of String(text ?? '').matchAll(stars ? QUOTE_OR_STAR_RE : QUOTE_RE)) {
        const isStar = m[5] !== undefined;
        const inner = (m[1] ?? m[2] ?? m[3] ?? m[4] ?? m[5] ?? '').trim();
        if (!/\p{L}/u.test(inner)) continue;
        out.push({ text: inner, start: m.index, kind: isStar ? 'star' : 'quote' });
    }
    return out;
}

/** 1인 모드 is per bot. */
function soloOn() {
    const bot = currentBot();
    return !!(bot && getSettings().soloBots?.[bot.key]);
}

function setSolo(on) {
    const bot = currentBot();
    if (!bot) {
        toastr.info('캐릭터 채팅을 먼저 열어주세요.', 'MultiCast TTS');
        return;
    }
    const s = getSettings();
    s.soloBots ??= {};
    if (on) s.soloBots[bot.key] = true;
    else delete s.soloBots[bot.key];
    save();
    updateSoloUI();
    updateInlinePrompt();
    refreshLineButtons({ rebuild: true });
    toastr.info(on ? `${bot.name}: 1인 모드 켬 (분류 없이 바로 읽어요)` : `${bot.name}: 1인 모드 끔 (AI가 분류해요)`, 'MultiCast TTS', { timeOut: 2000 });
}

function updateSoloUI() {
    const on = soloOn();
    const bot = currentBot();
    $('#voice_cast_solo').prop('checked', on).prop('disabled', !bot);
    $('#voice_cast_solo_label').text(bot ? `이 봇(${bot.name})은 1인 모드` : '이 봇은 1인 모드 (채팅을 열면 고를 수 있어요)');
    $('#voice_cast_wand_solo_label').text(`MultiCast TTS: 1인 모드 ${on ? '켜짐' : '꺼짐'}`);
}

/** 1인 모드: every quote belongs to whoever wrote the message — no AI call, no wait. */
function soloScript(message, messageId, text) {
    const ctx = SillyTavern.getContext();
    const speaker = message.is_user ? userNameFor(messageId) : (message.name || ctx.name2 || 'unknown');
    const g = findCastEntry(speaker)?.gender;
    const gender = g === 'm' || g === 'f' ? g : 'u';
    return quoteSegments(text).map(q => ({ speaker, gender, type: 'speech', tag: '', text: q.text }));
}

/** 빠른 분류: the message with ⟦n⟧ before every quote; the AI answers one short line per number. */
function buildFastPrompt(text, segs, prevText, userName) {
    const s = getSettings();
    const known = knownCharactersList(userName);
    let marked = String(text);
    for (let i = segs.length - 1; i >= 0; i--) {
        marked = marked.slice(0, segs[i].start) + `⟦${i + 1}⟧` + marked.slice(segs[i].start);
    }
    const system = [
        'You label dialogue for a voice-acting text-to-speech engine.',
        s.includeThoughts
            ? 'In the message, every quoted line and every *asterisk* piece is marked with a number like ⟦3⟧. Use the narration around it to decide who says it and how.'
            : 'In the message, every quoted line is marked with a number like ⟦3⟧. Use the narration around it to decide who says it and how.',
        '',
        'For EACH number, output exactly one line:',
        'number|speaker|gender|tag',
        '',
        'Rules:',
        `- speaker: use the exact name from the known characters list when it matches. The user's character is "${userName}" — in impersonation-style messages the user's character may also speak. Unnamed side characters get a short descriptive English label (e.g. waiter, old man). Use unknown only if truly impossible to tell.`,
        '- gender: m, f, or u. Use the gender from the known characters list when available.',
        '- tag: ONE short English delivery tag describing HOW the line is said: e.g. soft, warm, calm, firm, serious, irritated, amused, teasing, hesitant, nervous, sad, wistful, tired, sarcastic, cold, flustered, excited, laughing, sighing, whispering, angry, shouting, crying, pleading. Leave it empty for neutral delivery.',
        '- Match the intensity actually written in the text — do not exaggerate. When unsure between two steps, pick the lower one.',
        `- Every speaker has an emotional range from 1 (very restrained) to 5 (very expressive). Characters in the known list show theirs; anyone else uses ${GLOBAL_RANGE[s.emotionLevel] ?? 3}/5.`,
        EMOTION_LADDERS,
        '- Also follow each character\'s temperament and acting note.',
        '- If a numbered quote is not spoken aloud (a quoted title, sign, or a word being mentioned), output: number|-',
        ...(s.includeThoughts ? [
            '- Numbered *asterisk* pieces are usually narration (actions, descriptions, scenery) → output: number|-',
            '- ONLY when an *asterisk* piece is clearly a character\'s inner thought (first-person thinking), output: number|speaker|gender|tag|thought',
        ] : []),
        ...(s.sfxEnabled ? [
            `- Sound effects: when the NARRATION clearly describes a distinct, audible sound (a door slamming, footsteps, thunder, glass shattering, a knock, a gunshot), add a line S|after|sound where "after" is the number of the quote it comes after (0 = before the first quote) and "sound" is ONE short English sound tag. At most ${sfxLimit()}. Skip quiet or vague sounds.`,
            ...(s.adultSfx ? [ADULT_SFX_RULE] : []),
            `- Prefer these sound tags when one fits: ${[...customSfxLibrary().flatMap(e => e.words.filter(w => !w.startsWith('~'))), SFX_TAG_HINT].join(', ')}.`,
        ] : []),
        '- Output ONLY these lines. No prose, no JSON, no code fences.',
        '',
        'Example:',
        '1|Cliff|m|irritated',
        '2|Edith|f|',
        ...(s.sfxEnabled ? ['S|2|door slam'] : []),
        '3|waiter|m|nervous',
        ...(s.includeThoughts ? ['4|-', '5|Cliff|m|wistful|thought'] : []),
    ];
    if (s.extraInstructions?.trim()) {
        system.push('', 'Additional instructions from the user:', s.extraInstructions.trim());
    }
    const user = ['Known characters:', known.join('\n'), ''];
    if (prevText) user.push('Previous message (CONTEXT ONLY):', '<<<', prevText, '>>>', '');
    user.push('Message:', '<<<', marked, '>>>');
    return { system: system.join('\n'), user: user.join('\n') };
}

function parseFastOutput(raw, segs) {
    const cleaned = String(raw ?? '')
        .replace(/<think>[\s\S]*?<\/think>/gi, '')
        .replace(/<thinking>[\s\S]*?<\/thinking>/gi, '')
        .replace(/```[a-z]*/gi, '');
    const labels = new Map();
    const sfxAfter = new Map(); // quote number -> [sound tags]
    for (const rawLine of cleaned.split('\n')) {
        const line = rawLine.trim().replace(/^[-*]\s*/, '');
        const sfx = /^S\s*\|\s*(\d+)\s*\|\s*(.+)$/i.exec(line);
        if (sfx) {
            const tag = sfx[2].replace(/[[\]|]/g, '').trim();
            if (tag) sfxAfter.set(Number(sfx[1]), [...(sfxAfter.get(Number(sfx[1])) ?? []), tag]);
            continue;
        }
        const m = /^⟦?(\d+)⟧?\s*\|(.*)$/.exec(line);
        if (!m) continue;
        const n = Number(m[1]);
        if (n < 1 || n > segs.length || labels.has(n)) continue;
        const [speaker = '', gender = '', tag = '', kind = ''] = m[2].split('|').map(x => x.trim());
        labels.set(n, { speaker, gender: gender.toLowerCase(), tag: tag.replace(/[[\]]/g, ''), thought: /thought|생각/i.test(kind) });
    }
    // every spoken quote should be answered; asterisk narration may be skipped by the model
    const quoteNums = segs.map((seg, i) => (seg.kind === 'star' ? 0 : i + 1)).filter(Boolean);
    const answered = quoteNums.filter(n => labels.has(n)).length;
    if (quoteNums.length ? answered < Math.ceil(quoteNums.length / 2) : !labels.size && !sfxAfter.size && !/\|/.test(cleaned)) {
        throw new ClassifierError('빠른 분류 응답에서 번호를 충분히 찾지 못했어요.', raw);
    }
    const script = [];
    const pushSfx = (after) => {
        for (const tag of (sfxAfter.get(after) ?? []).slice(0, sfxLimit())) {
            script.push({ speaker: 'SFX', gender: 'u', type: 'sfx', tag: '', text: `[${tag}]` });
        }
    };
    pushSfx(0);
    segs.forEach((seg, i) => {
        const l = labels.get(i + 1);
        if (l && l.speaker && l.speaker !== '-') {
            script.push({
                speaker: l.speaker || 'unknown',
                gender: ['m', 'f'].includes(l.gender) ? l.gender : 'u',
                // a named *asterisk* piece can only be a thought (narration answers "-")
                type: l.thought || seg.kind === 'star' ? 'thought' : 'speech',
                tag: l.tag,
                text: seg.text,
            });
        }
        pushSfx(i + 1);
    });
    return script;
}

// ---------------------------------------------------------------------------
// 🚀 기다림 없이 바로 듣기 (internal: inlineTags): the RP model writes <v n="Name" e="emotion">"line"</v>
// ---------------------------------------------------------------------------

const INLINE_PROMPT_KEY = 'voice_cast_inline_tags';

function inlineTagsActive() {
    const s = getSettings();
    return !!(s.enabled && s.inlineTags && !soloOn());
}

function inlineTagInstruction() {
    const s = getSettings();
    return [
        '[Voice tags for text-to-speech — follow silently]',
        'Wrap EVERY spoken line of dialogue in a voice tag, keeping the quotes inside it:',
        '<v n="Name" e="emotion">"the spoken line"</v>',
        '- n = the exact name of who speaks (unnamed side characters: a short English label like waiter).',
        ...inlineNameList(),
        '- e = ONE short English word for HOW it is said (e.g. calm, warm, teasing, nervous, irritated, angry, whispering, laughing); leave it empty when neutral.',
        ...(s.includeThoughts ? ['- A character\'s inner thought written in *asterisks* gets t="1": <v n="Name" e="wistful" t="1">*the thought*</v>. Never tag narration or actions.'] : ['- Never tag narration, actions, or thoughts.']),
        ...(s.sfxEnabled ? [
            `- Where the narration describes a distinct audible sound (a door slam, footsteps, a gunshot, thunder …), put <sfx n="door slam"/> right at that spot — ONE short English sound tag. At most ${sfxLimit()} per reply.`,
            ...(s.adultSfx ? ['- In adult scenes (all characters adults), also mark intimate sounds the same way: kiss, wet squelch, slurp, lick, skin slap, bed creak, panting, sheets rustle.'] : []),
            ...(customSfxLibrary().length ? [`- Prefer these sound tags when one fits: ${customSfxLibrary().flatMap(e => e.words.filter(w => !w.startsWith('~'))).slice(0, 40).join(', ')}.`] : []),
        ] : []),
        ...inlineActingNotes(),
        '- One tag per quote. Write everything else exactly as you normally would. The tags are hidden from the reader; never mention them.',
    ].join('\n');
}

/** The names the voices are set up for, so n="…" matches the cast (no English/Korean spelling mix-ups). */
function inlineNameList() {
    const ctx = SillyTavern.getContext();
    const names = [];
    const add = n => { n = String(n ?? '').trim(); if (n && n.toLowerCase() !== '{{user}}' && !names.some(x => x.toLowerCase() === n.toLowerCase())) names.push(n); };
    add(ctx.name2);
    if (ctx.groupId) {
        const group = ctx.groups?.find(g => g.id === ctx.groupId);
        for (const avatar of group?.members ?? []) add(ctx.characters?.find(ch => ch.avatar === avatar)?.name);
    }
    for (const entry of allCastEntries()) add(String(entry.names ?? '').split(',')[0]);
    add(ctx.name1);
    if (!names.length) return [];
    return [`- For these characters write n EXACTLY as spelled here: ${names.slice(0, 30).join(', ')}.`];
}

/** The cast's temperament / acting notes, so the e="…" the RP model picks fits each character (like the classifier does). */
function inlineActingNotes() {
    const lines = [];
    for (const entry of allCastEntries()) {
        const name = String(entry.names ?? '').split(',').map(n => n.trim()).filter(Boolean)[0];
        if (!name || name.toLowerCase() === '{{user}}') continue;
        const bits = [];
        if (TEMPERS[entry.temper]) bits.push(`temperament: ${TEMPERS[entry.temper].hint}`);
        if (String(entry.actingNote ?? '').trim()) bits.push(`acting note: ${String(entry.actingNote).trim()}`);
        if (!bits.length) continue;
        bits.push(`emotional range ${rangeFor(entry)}/5 (1 = very restrained, 5 = very expressive)`);
        lines.push(`  ${name} — ${bits.join('; ')}`);
        if (lines.length >= 15) break;
    }
    if (!lines.length) return [];
    return ['- Pick e to fit each character\'s way of speaking (stay within their range; when unsure, the calmer word):', ...lines];
}

/** Keep the instruction in (or out of) the prompt to match the setting and the current bot. */
function updateInlinePrompt() {
    const ctx = SillyTavern.getContext();
    if (typeof ctx.setExtensionPrompt !== 'function') return;
    // position 1 = in chat, depth 0 = right at the end (best followed), role 0 = system
    try {
        ctx.setExtensionPrompt(INLINE_PROMPT_KEY, inlineTagsActive() ? inlineTagInstruction() : '', 1, 0, false, 0);
    } catch (e) {
        console.warn(LOG, 'could not set the voice-tag prompt', e);
    }
}

const VOICE_TAG_RE = /<v\b([^>]*)>([\s\S]*?)<\/v\s*>/gi;
const SFX_TAG_RE = /<sfx\b([^>]*?)\/?>(?:\s*<\/sfx\s*>)?/gi;
const VOICE_OR_SFX_RE = /<v\b([^>]*)>([\s\S]*?)<\/v\s*>|<sfx\b([^>]*?)\/?>(?:\s*<\/sfx\s*>)?/gi;

function voiceTagAttr(attrs, name) {
    const m = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i').exec(attrs);
    return (m?.[1] ?? m?.[2] ?? m?.[3] ?? '').trim();
}

/** Lines from <v> tags in a raw message, in order: { speaker, tag, thought, text }. */
function parseVoiceTags(raw) {
    const out = [];
    for (const m of String(raw ?? '').matchAll(VOICE_OR_SFX_RE)) {
        if (m[3] !== undefined) {
            // <sfx n="door slam"/> — a sound effect at this spot
            const tag = voiceTagAttr(m[3], 'n').replace(/[[\]]/g, '').trim();
            if (tag) out.push({ sfx: true, text: `[${tag}]` });
            continue;
        }
        const inner = cleanMessageText(m[2]).replace(/^[\s"\u201C\u300C\u300E*]+|[\s"\u201D\u300D\u300F*]+$/g, '').trim();
        if (!/\p{L}/u.test(inner)) continue;
        out.push({
            speaker: voiceTagAttr(m[1], 'n') || 'unknown',
            tag: voiceTagAttr(m[1], 'e').replace(/[[\]]/g, ''),
            thought: /^(1|true|yes)$/i.test(voiceTagAttr(m[1], 't')),
            text: inner,
        });
    }
    return out;
}

/** Formatting tags that wrap story text (kept); any other paired tag is a side block (<choices>, status, variables…). */
const STORY_TAGS = new Set(['v', 'sfx', 'span', 'font', 'b', 'i', 'em', 'strong', 'u', 's', 'del', 'p', 'q', 'small', 'big', 'mark', 'sub', 'sup', 'br', 'center']);

/** The story text only: drops side blocks like <choices>…</choices> or <UpdateVariable>…</UpdateVariable>. */
function stripSideBlocks(raw) {
    let out = String(raw ?? '');
    for (let pass = 0; pass < 5; pass++) {
        const next = out.replace(/<([a-zA-Z][\w:-]*)\b[^>]*>[\s\S]*?<\/\1\s*>/g, (m, name) => (STORY_TAGS.has(name.toLowerCase()) ? m : ' '));
        if (next === out) break;
        out = next;
    }
    return out;
}

/**
 * Lines from the model's own voice tags, lined up with the story's real quotes.
 * Returns { script, missing: [{ text, line }], total } — `missing` are quotes the model forgot to tag
 * (their line is a placeholder to fill), or null when the tags can't be used at all.
 * With a translation on screen, speakers carry over by order (all quotes must be tagged).
 * Quotes inside side blocks (choices, status windows) don't count — they aren't spoken lines.
 */
function alignVoiceTags(message, text) {
    const tagged = parseVoiceTags(stripSideBlocks(message?.mes));
    if (!tagged.length) return null;
    const speech = tagged.filter(t => !t.thought && !t.sfx);
    const s = getSettings();
    let sfxLeft = s.sfxEnabled ? sfxLimit() : 0;
    const keepSfx = () => (sfxLeft-- > 0);
    const flat = t => normForMatch(t).replace(/\s+/g, '');
    const shownIsOriginal = flat(cleanMessageText(String(message.mes).replace(VOICE_TAG_RE, '$2'))) === flat(text);
    let shownRaw = message.mes;
    if (!shownIsOriginal) {
        const shown = getShownTranslation(message);
        const pairs = bilingualParts(shown);
        shownRaw = pairs ? pairs.trans.join('\n') : (shown || text);
    }
    const quotes = quoteSegments(cleanMessageText(stripSideBlocks(shownRaw)));
    const toLine = (t, lineText) => {
        if (t.sfx) return { speaker: 'SFX', gender: 'u', type: 'sfx', tag: '', text: t.text };
        const g = findCastEntry(t.speaker)?.gender;
        return {
            speaker: t.speaker,
            gender: g === 'm' || g === 'f' ? g : 'u',
            type: t.thought ? 'thought' : 'speech',
            tag: t.tag,
            text: lineText,
        };
    };
    const extra = t => (t.sfx ? keepSfx() : (t.thought && s.includeThoughts));

    if (!shownIsOriginal) {
        // reading a translation: same number of quotes → the n-th tag belongs to the n-th translated quote
        if (speech.length !== quotes.length || !quotes.length) return null;
        let k = 0;
        const out = [];
        for (const t of tagged) {
            if (t.sfx) { if (keepSfx()) out.push(toLine(t)); continue; }
            if (t.thought) continue;
            out.push(toLine(t, quotes[k++].text));
        }
        return { script: out, missing: [], total: quotes.length };
    }

    // reading as written: line each story quote up with a tag (the tag may wrap only part of it, or some narration too)
    const same = (q, t) => {
        const a = flat(q);
        const b = flat(t);
        if (!a || !b) return false;
        return a === b || a.includes(b) || b.includes(a) || (a.length >= 8 && b.length >= 8 && a.slice(0, 8) === b.slice(0, 8));
    };
    const out = [];
    const missing = [];
    let p = 0;
    let lastTag = null;
    let matched = 0;
    for (const q of quotes) {
        let found = -1;
        for (let j = p, seen = 0; j < tagged.length && seen < 4; j++) {
            if (tagged[j].sfx || tagged[j].thought) continue;
            seen++;
            if (same(q.text, tagged[j].text)) { found = j; break; }
        }
        if (found < 0) {
            // one tag wrapped two quotes → the second one belongs to the same speaker
            if (lastTag && flat(lastTag.text).includes(flat(q.text))) {
                out.push(toLine(lastTag, q.text));
                matched++;
                continue;
            }
            const line = { speaker: 'unknown', gender: 'u', type: 'speech', tag: '', text: q.text };
            out.push(line);
            missing.push({ text: q.text, line });
            continue;
        }
        // sounds / thoughts that came before this quote keep their place; stray tags with no quote are dropped
        for (let j = p; j < found; j++) if ((tagged[j].sfx || tagged[j].thought) && extra(tagged[j])) out.push(toLine(tagged[j], tagged[j].text));
        out.push(toLine(tagged[found], q.text));
        lastTag = tagged[found];
        matched++;
        p = found + 1;
    }
    for (let j = p; j < tagged.length; j++) if ((tagged[j].sfx || tagged[j].thought) && extra(tagged[j])) out.push(toLine(tagged[j], tagged[j].text));
    if (quotes.length && !matched) return null; // the tags don't belong to this text
    return { script: out, missing, total: quotes.length };
}

/**
 * 🚀 script: the model's tags, with any quote it forgot filled in by a tiny fast-classify call for just those quotes.
 * Returns { script, status: 'ok' | 'fill' } or null (then the normal classifier runs).
 */
async function scriptFromVoiceTags(message, text, messageId, prevText) {
    const r = alignVoiceTags(message, text);
    if (!r) return null;
    if (!r.missing.length) return { script: r.script, status: 'ok' };
    // mostly untagged → the normal path does a better job
    if (r.missing.length > Math.max(1, Math.floor(r.total / 2))) return null;
    const flat = t => normForMatch(t).replace(/\s+/g, '');
    const all = quoteSegments(text);
    const segs = [];
    for (const m of r.missing) {
        const seg = all.find(sg => flat(sg.text) === flat(m.text) && !segs.includes(sg));
        if (!seg) return null;
        segs.push(seg);
    }
    segs.sort((a, b) => a.start - b.start);
    let filled;
    try {
        filled = (await runFastClassifier(text, segs, prevText, userNameFor(messageId))).filter(l => l.type !== 'sfx');
    } catch (e) {
        console.warn(LOG, '🚀 could not fill the untagged quotes', e);
        return null;
    }
    const script = [];
    for (const line of r.script) {
        const m = r.missing.find(x => x.line === line);
        if (!m) { script.push(line); continue; }
        const l = filled.find(x => flat(x.text) === flat(m.text));
        if (!l) continue; // the model said it isn't spoken
        script.push({ ...line, speaker: l.speaker, gender: l.gender, tag: l.tag, type: l.type === 'thought' ? 'thought' : 'speech' });
    }
    return { script, status: 'fill' };
}

/** 🚀 성공률: the last 20 tagged replies — 'ok' (tags only), 'fill' (a few quotes filled in), 'miss' (classified as usual). */
function noteInlineResult(status) {
    const s = getSettings();
    const list = Array.isArray(s.inlineStats) ? s.inlineStats : [];
    list.push(status);
    s.inlineStats = list.slice(-20);
    save();
    renderInlineStats();
}

function renderInlineStats() {
    const list = getSettings().inlineStats ?? [];
    const $el = $('#voice_cast_inline_stats');
    if (!$el.length) return;
    if (!list.length) { $el.text(''); return; }
    const n = k => list.filter(x => x === k).length;
    $el.text(`최근 ${list.length}개: 바로 ${n('ok')} · 빠진 대사만 메움 ${n('fill')} · 다시 분류 ${n('miss')}`);
}

/** Some setups show tags as text instead of hiding them — strip any visible <v ...> / </v>. */
function hideVoiceTagText(root) {
    if (!root) return;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const hits = [];
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        if (/<\/?(?:v|sfx)\b[^<>]*>/i.test(n.nodeValue ?? '')) hits.push(n);
    }
    for (const n of hits) n.nodeValue = n.nodeValue.replace(/<\/?(?:v|sfx)\b[^<>]*>/gi, '');
}

async function runFastClassifier(text, segs, prevText, userName) {
    const s = getSettings();
    const ctx = SillyTavern.getContext();
    const { system, user } = buildFastPrompt(text, segs, prevText, userName);
    const timeoutSec = 60;
    let timer;
    const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('빠른 분류 시간 초과')), timeoutSec * 1000);
    });
    try {
        const raw = await Promise.race([classifierRaw(s, ctx, system, user), timeout]);
        return parseFastOutput(raw, segs);
    } finally {
        clearTimeout(timer);
    }
}

/**
 * Returns the cached script for a message, or classifies it now.
 */
const scriptInflight = new Map(); // messageId -> Promise (avoids classifying the same message twice at once)

function scriptKey(text) {
    const s = getSettings();
    const extra = s.voiceLang === 'translate' ? `|${variantKey()}` : '';
    return hashString(`${text}|${s.includeThoughts ? 1 : 0}${extra}`);
}

async function getScript(messageId, { force = false } = {}) {
    const inflightKey = `${messageId}|${variantKey()}`;
    const running = scriptInflight.get(inflightKey);
    if (running && !force) return running;
    const p = getScriptInner(messageId, { force }).finally(() => {
        if (scriptInflight.get(inflightKey) === p) scriptInflight.delete(inflightKey);
    });
    // the script is ready → its ▶ buttons show up right away
    p.then(() => setTimeout(() => redecorateMessage(messageId), 0)).catch(() => {});
    scriptInflight.set(inflightKey, p);
    return p;
}

async function getScriptInner(messageId, { force = false } = {}) {
    const ctx = SillyTavern.getContext();
    const message = ctx.chat[messageId];
    if (!message) throw new Error('메시지를 찾을 수 없어요.');

    const s = getSettings();
    const text = getMessageText(message);
    if (!text) return [];

    const textHash = hashString(text);
    const key = scriptKey(text);
    const cached = getStoredEntry(message);
    if (Array.isArray(cached?.script)) fixUserSpeaker(cached.script, messageId);
    // 1인 모드 can't translate (that needs the AI), so it only applies when reading as written
    const solo = soloOn() && s.voiceLang !== 'translate';
    const soloKey = `${key}|solo`;
    if (!force && Array.isArray(cached?.script)) {
        // A script the user edited is kept as long as the message text itself didn't change
        if (cached.edited && cached.textHash === textHash) return cached.script;
        if (cached.hash === key) return cached.script; // an AI script is better and already paid for
        if (solo && cached.hash === soloKey) return cached.script;
    }
    if (solo) {
        const script = soloScript(message, messageId, text);
        setStoredEntry(message, { hash: soloKey, textHash, script, edited: false });
        await ctx.saveChat();
        return script;
    }

    let prevText = '';
    const contextChars = Number(s.contextChars) || 0;
    if (contextChars > 0 && messageId > 0) {
        const prev = ctx.chat[messageId - 1];
        if (prev) prevText = getMessageText(prev).slice(-contextChars);
    }

    let script = null;
    let fromTags = false;
    // 기다림 없이 바로 듣기: the model already said who speaks — no classifier call at all
    if (s.inlineTags && !message.is_user && s.voiceLang !== 'translate' && inlineTagsActive()) {
        const hasTags = /<(?:v|sfx)\b/i.test(String(message.mes ?? ''));
        const r = hasTags ? await scriptFromVoiceTags(message, text, messageId, prevText) : null;
        if (r) {
            script = r.script;
            fromTags = true;
            noteInlineResult(r.status);
        } else if (!force && messageId === ctx.chat.length - 1 && quoteSegments(text).length) {
            // tags missing or unusable → classified as usual (counted only for the newest reply that has dialogue)
            noteInlineResult('miss');
            if (hasTags) toastr.info('🚀 태그가 많이 빠져서 이 메시지는 평소처럼 분류했어요.', 'MultiCast TTS', { timeOut: 2500 });
        }
    }
    // 빠른 분류: lines are quotes (+ *asterisk* pieces when inner thoughts are on); not with AI translation
    if (!script && s.fastClassify && s.voiceLang !== 'translate') {
        const segs = quoteSegments(text, { stars: !!s.includeThoughts });
        if (segs.length) {
            try {
                script = await runFastClassifier(text, segs, prevText, userNameFor(messageId));
            } catch (e) {
                console.warn(LOG, 'fast classify failed, using the full classifier', e, e?.raw);
                script = null;
            }
        }
    }
    script ??= await runClassifier(text, prevText, userNameFor(messageId));

    setStoredEntry(message, { hash: key, textHash, script, edited: false });
    // the tags did their job → take them out of the message so the chat file and every later prompt stay as light as before
    if (fromTags) stripVoiceTagsFromMessage(message);
    await ctx.saveChat();
    return script;
}

function stripVoiceTagsFromMessage(message) {
    const strip = t => String(t).replace(VOICE_TAG_RE, '$2').replace(SFX_TAG_RE, '');
    const before = message.mes;
    message.mes = strip(before);
    // the open swipe keeps its own copy of the text
    if (Array.isArray(message.swipes) && Number.isInteger(message.swipe_id) && message.swipes[message.swipe_id] === before) {
        message.swipes[message.swipe_id] = message.mes;
    }
}

/**
 * Older scripts could label the user's lines with the persona that happened to be selected
 * (e.g. "Mia") instead of the one the chat was written with (e.g. "Edith"). If that name has
 * no cast row, point it at the chat's user character so their voice and color apply.
 */
function fixUserSpeaker(script, messageId) {
    const ctx = SillyTavern.getContext();
    const real = userNameFor(messageId);
    const selected = ctx.name1;
    if (!real || !selected || normName(real) === normName(selected)) return;
    const hasRow = name => allCastEntries().some(e => entryNames(e, selected).includes(normName(name)));
    if (hasRow(selected)) return;
    for (const line of script) {
        if (normName(line?.speaker) === normName(selected)) line.speaker = real;
    }
}

async function saveEditedScript(messageId, script) {
    const ctx = SillyTavern.getContext();
    const message = ctx.chat[messageId];
    if (!message) return;
    const text = getMessageText(message);
    setStoredEntry(message, {
        hash: scriptKey(text),
        textHash: hashString(text),
        script,
        edited: true,
    });
    await ctx.saveChat();
}

// ---------------------------------------------------------------------------
// Voice mapping
// ---------------------------------------------------------------------------

function findCastEntry(speaker) {
    const userName = SillyTavern.getContext().name1;
    let target = normName(speaker);
    if (!target) return null;
    if (['{{user}}', 'user', '유저'].includes(target)) target = normName(userName);
    const entries = allCastEntries(); // bot cast first, then shared

    // exact name/alias match ("{{user}}" counts as the persona name)
    let matches = entries.filter(e => entryNames(e, userName).includes(target));
    // looser match: one contains the other (e.g. "서윤" vs "한서윤")
    if (!matches.length) {
        matches = entries.filter(e => entryNames(e, userName)
            .some(n => n.length >= 2 && (target.includes(n) || n.includes(target))));
    }
    if (!matches.length) return null;
    if (matches.length === 1) return matches[0];
    // The same character can have rows in both casts (e.g. the persona: voice in the shared cast,
    // highlight color in this bot's cast). Combine them: each setting comes from the first row that has it.
    const merged = {};
    for (const e of [...matches].reverse()) {
        for (const [k, v] of Object.entries(e)) {
            if (v !== '' && v !== null && v !== undefined) merged[k] = v;
        }
    }
    merged.voiceId = (matches.find(e => e.voiceId) ?? {}).voiceId ?? '';
    return merged;
}

function pickVoice(line) {
    const s = getSettings();
    if (line.voiceId) return line.voiceId; // manual override from the script editor
    if (line.type === 'sfx') return s.sfxVoiceId || s.unknownVoiceId || s.maleVoiceId || s.femaleVoiceId || '';
    const entry = findCastEntry(line.speaker);
    if (entry?.voiceId) return entry.voiceId;
    // no voice assigned yet: use the gender from the line, or the one set in the cast row
    const gender = line.gender !== 'u' ? line.gender : (entry?.gender ?? 'u');
    if (gender === 'm' && s.maleVoiceId) return s.maleVoiceId;
    if (gender === 'f' && s.femaleVoiceId) return s.femaleVoiceId;
    return s.unknownVoiceId || s.maleVoiceId || s.femaleVoiceId || '';
}

/** Sound-effect lines only play when the option is on and the model understands [tags]. */
function sfxPlayable(line = null) {
    const s = getSettings();
    if (!s.sfxEnabled) return false;
    if (line && localSfxFor(line)) return true;
    return !!modelInfo(s.model).tags;
}

// ---------------------------------------------------------------------------
// Bundled sound effects (CC0) — sfx/<name>.mp3 next to this file.
// A script line like "[door slamming]" is matched to a file by keywords; "~word" = weak/generic match.
let SFX_BASE = '/scripts/extensions/third-party/voice-cast/sfx/';
try { SFX_BASE = new URL('./sfx/', import.meta.url).href; } catch { /* keep the default path */ }
const SFX_KEY_PREFIX = 'sfxfile:';
const SFX_LIBRARY = [
    // sounds we don't ship: never pass these off as something else (falls back to the ElevenLabs tag)
    { files: [], words: ['phone', 'cellphone', 'ringtone', 'alarm', 'dog', 'bark', 'clap', 'applause', 'heartbeat', 'rain', 'siren', 'car', 'engine', 'horn', 'scream', 'laugh', 'music'] },
    { files: ['door_slam', 'door_slam_2'], words: ['slam', 'door bang', 'door banging'] },
    { files: ['door_creak', 'door_creak_2'], words: ['creak', 'squeak'] },
    { files: ['door_close'], words: ['door close', 'door closing', 'door shut', 'closing door', 'door click'] },
    { files: ['door_open', 'door_open_2'], words: ['door open', 'opening door', 'door swing', '~door'] },
    { files: ['knock', 'knock_2'], words: ['knock', 'rap on', 'tapping on door'] },
    { files: ['footsteps_wood'], words: ['wooden floor', 'floorboard', 'stairs', 'creaking floor'] },
    { files: ['footsteps_wet'], words: ['wet footsteps', 'puddle', 'splashing steps'] },
    { files: ['running'], words: ['running', 'run', 'sprint', 'rushing', 'hurried footsteps'] },
    { files: ['footsteps'], words: ['footstep', 'steps', 'walking', 'pacing', '~approach'] },
    { files: ['glass_break', 'glass_break_2'], words: ['shatter', 'glass break', 'breaking glass', 'window break', 'glass crash'] },
    { files: ['glass_clink'], words: ['clink', 'cheers', 'glasses', 'toast'] },
    { files: ['shotgun'], words: ['shotgun'] },
    { files: ['pistol'], words: ['pistol', 'handgun', 'revolver'] },
    { files: ['gunshot', 'gunshot_2', 'gunshot_3'], words: ['gunshot', 'gun', 'shot', 'gunfire', 'rifle', '~bang'] },
    { files: ['bullet_hit'], words: ['bullet hit', 'bullet impact', 'ricochet', 'bullet strike'] },
    { files: ['explosion'], words: ['explosion', 'explode', 'blast', 'boom', 'detonat'] },
    { files: ['thunder'], words: ['thunder', 'lightning', 'rumble'] },
    { files: ['gong'], words: ['gong'] },
    { files: ['bell', 'bell_2'], words: ['bell', 'chime', 'ring', 'ding'] },
    { files: ['unlock'], words: ['unlock', 'lock click', 'lock', 'latch'] },
    { files: ['key'], words: ['keys', 'key jingl', 'jingl'] },
    { files: ['paper'], words: ['paper', 'page', 'rustl', 'flipping', 'letter', 'book'] },
    { files: ['splash'], words: ['splash', 'water', 'plunge', 'dive'] },
    { files: ['switch'], words: ['switch', 'click', 'button'] },
    { files: ['dishes'], words: ['dishes', 'plates', 'cutlery', 'clatter'] },
    { files: ['pot'], words: ['pot', 'pan', 'kettle', 'cooking'] },
    { files: ['clang'], words: ['clang', 'clank', 'metal', 'sword clash', 'steel'] },
    { files: ['box_open'], words: ['box', 'lid', 'chest open', 'drawer', 'case open'] },
    { files: ['pickup'], words: ['pick up', 'picks up', 'grab', 'rummag'] },
    { files: ['drop'], words: ['drop', 'plop', 'falls to'] },
    { files: ['smash'], words: ['smash', 'wreck', 'crash'] },
    { files: ['impact', 'impact_2'], words: ['impact', 'collision', 'heavy hit', 'slammed into', 'crash into'] },
    { files: ['punch'], words: ['punch', 'slap', 'smack', 'hit', 'strike', 'kick', 'blow'] },
    { files: ['thud'], words: ['thud', 'thump', 'collapse', 'body fall', 'fall'] },
    { files: ['wood_crack'], words: ['crack', 'snap', 'branch', 'twig', 'splinter'] },
    { files: ['stones'], words: ['stone', 'rock', 'rubble', 'gravel', 'pebble'] },
    { files: ['wind'], words: ['wind', 'breeze', 'howl', 'gust'] },
    { files: ['whoosh'], words: ['whoosh', 'swish', 'swoosh', 'swing', 'swipe'] },
];
const SFX_TAG_HINT = 'door creaking, door slam, door opening, door closing, knock, footsteps, running, glass shattering, glasses clink, gunshot, pistol shot, shotgun, bullet hit, explosion, thunder, bell, gong, unlock, keys, paper rustling, splash, switch click, dishes, pot, metal clang, box opening, pick up, drop, smash, impact, punch, thud, wood cracking, stones, wind, whoosh';

function sfxWords(text) {
    return String(text ?? '').toLowerCase().replace(/[^a-z\s]/g, ' ').split(/\s+/).filter(Boolean);
}

/** The user's own sounds as library entries (their keywords, or the name when no keywords). */
function customSfxLibrary() {
    // 🔞 sounds only exist while 🔞 성인 효과음 is on: never offered to the AI, never matched otherwise
    const adultOn = !!getSettings().adultSfx;
    return (getSettings().customSfx ?? []).filter(c => c?.id && (adultOn || !c.adult)).map(c => {
        const words = String(c.words || c.name || '').split(',').map(w => w.trim()).filter(Boolean);
        return { files: [CUSTOM_SFX_PREFIX + c.id], words };
    });
}

/**
 * Sound for a sound-effect line: the user's own sounds first, then the bundled ones.
 * Returns 'name' (bundled) or 'custom:<id>', or '' when nothing fits (then the ElevenLabs tag is used).
 */
function localSfxFor(line) {
    if (line?.type !== 'sfx') return '';
    const words = sfxWords(line.text);
    if (!words.length) return '';
    const mine = matchSfx(words, customSfxLibrary());
    if (mine) return mine;
    if (!getSettings().sfxLocal) return '';
    return matchSfx(words, SFX_LIBRARY);
}

function matchSfx(words, library) {
    let best = null;
    let bestScore = 0;
    for (const entry of library) {
        for (const raw of entry.words) {
            const weak = raw.startsWith('~');
            const phrase = sfxWords(raw);
            if (!phrase.length) continue; // e.g. a Korean-only name: nothing to match on
            // each phrase word must start a word in the tag, in order and next to each other ("slam" ↔ "slamming")
            let hit = false;
            let exact = false;
            for (let i = 0; i + phrase.length <= words.length && !exact; i++) {
                if (phrase.every((p, j) => words[i + j].startsWith(p))) {
                    hit = true;
                    exact = phrase.every((p, j) => words[i + j] === p);
                }
            }
            if (!hit) continue;
            if (!entry.files.length) return '';
            // an exact word wins over a word that only starts the same ("spanking" → the 'spanking' sound, not 'spank')
            const score = phrase.length * (weak ? 0.5 : 1) + (exact ? 0.25 : 0);
            if (score > bestScore) { bestScore = score; best = entry; }
        }
    }
    if (!best) return '';
    // same tag → same variant every time
    let h = 0;
    for (const ch of words.join(' ')) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
    return best.files[h % best.files.length];
}

const CUSTOM_SFX_PREFIX = 'custom:';
let customSfxStore = null;
function getCustomSfxStore() {
    if (customSfxStore) return customSfxStore;
    const lf = SillyTavern.libs?.localforage ?? globalThis.localforage;
    if (!lf) return null;
    // its own database, so "저장된 음성 지우기" and the size limit never touch the user's sounds
    customSfxStore = lf.createInstance({ name: 'SillyTavern_VoiceCast_SFX', storeName: 'custom' });
    return customSfxStore;
}

function isLocalSfxKey(key) {
    return typeof key === 'string' && key.startsWith(SFX_KEY_PREFIX);
}

function customSfxIdFromKey(key) {
    const rest = isLocalSfxKey(key) ? key.slice(SFX_KEY_PREFIX.length) : '';
    return rest.startsWith(CUSTOM_SFX_PREFIX) ? rest.slice(CUSTOM_SFX_PREFIX.length) : '';
}

/** Audio pinned to a line that can be replayed without credits (saved clip or bundled sound). */
function keyHasAudio(key) {
    return !!key && (isLocalSfxKey(key) || !!storeIndex?.[key]);
}

function buildTtsText(line) {
    const s = getSettings();
    if (line.type === 'sfx') {
        // a line with only [tags] counts as empty for ElevenLabs → add a quiet "..." so the tag has something to attach to
        const t = String(line.text ?? '').trim();
        const tag = t.startsWith('[') ? t.match(/^(\[[^\]]*\]\s*)+/)?.[0]?.trim() ?? t : `[${t}]`;
        const rest = t.startsWith('[') ? t.slice(tag.length).trim() : '';
        return `${tag} ${rest || '...'}`;
    }
    if (!s.useTags || !modelInfo(s.model).tags) return line.text;
    const tags = [];
    if (line.type === 'thought' && s.thoughtTag?.trim()) tags.push(s.thoughtTag.trim());
    // the character's "always" tags (speech style), then the line's emotion tag
    const always = String(findCastEntry(line.speaker)?.alwaysTags ?? '').split(',').map(t => t.trim().replace(/^\[|\]$/g, '')).filter(Boolean);
    for (const t of always) if (!tags.includes(t)) tags.push(t);
    const shaped = shapeTag(line.tag, line);
    if (shaped && !tags.includes(shaped)) tags.push(shaped);
    return tags.map(t => `[${t}]`).join(' ') + (tags.length ? ' ' : '') + line.text;
}

// ---------------------------------------------------------------------------
// ElevenLabs (through SillyTavern's server, uses the key saved in ST secrets)
// ---------------------------------------------------------------------------

// --- Audio cache: memory (blob URLs) + persistent IndexedDB (survives reloads) ---

const memoryUrls = new Map(); // key -> blob URL
const MEMORY_URL_LIMIT = 200;
const INDEX_KEY = '__index__';
let store = null;
let storeIndex = null; // { key: { t: lastUsed, size } }

function getStore() {
    if (store) return store;
    const lf = SillyTavern.libs?.localforage ?? globalThis.localforage;
    if (!lf) return null;
    store = lf.createInstance({ name: 'SillyTavern_VoiceCast', storeName: 'audio' });
    return store;
}

async function loadIndex() {
    if (storeIndex) return storeIndex;
    try {
        storeIndex = (await getStore()?.getItem(INDEX_KEY)) ?? {};
    } catch {
        storeIndex = {};
    }
    return storeIndex;
}

let indexSaveTimer = null;
function saveIndexSoon() {
    clearTimeout(indexSaveTimer);
    indexSaveTimer = setTimeout(() => {
        getStore()?.setItem(INDEX_KEY, storeIndex).catch(e => console.warn(LOG, 'index save failed', e));
    }, 1000);
}

function rememberUrl(key, blob) {
    if (memoryUrls.has(key)) return memoryUrls.get(key);
    const url = URL.createObjectURL(blob);
    memoryUrls.set(key, url);
    while (memoryUrls.size > MEMORY_URL_LIMIT) {
        const oldest = memoryUrls.keys().next().value;
        URL.revokeObjectURL(memoryUrls.get(oldest));
        memoryUrls.delete(oldest);
    }
    return url;
}

/** A 🔞 sound of my own while 🔞 성인 효과음 is off → stays silent (and is never remade with credits). */
function isBlockedAdultKey(key) {
    if (getSettings().adultSfx || !key || !isLocalSfxKey(key)) return false;
    const id = customSfxIdFromKey(key);
    return !!id && (getSettings().customSfx ?? []).some(c => String(c.id) === String(id) && c.adult);
}

async function getCachedAudio(key, { preview = false } = {}) {
    if (isLocalSfxKey(key)) {
        const customId = customSfxIdFromKey(key);
        if (!customId) return SFX_BASE + encodeURIComponent(key.slice(SFX_KEY_PREFIX.length)) + '.mp3';
        // a 🔞 sound saved in an old script stays silent while 🔞 성인 효과음 is off
        if (!preview && isBlockedAdultKey(key)) return null;
        if (memoryUrls.has(key)) return memoryUrls.get(key);
        try {
            const blob = await getCustomSfxStore()?.getItem(customId);
            return blob ? rememberUrl(key, blob) : null;
        } catch (e) {
            console.warn(LOG, 'custom sound read failed', e);
            return null;
        }
    }
    if (memoryUrls.has(key)) return memoryUrls.get(key);
    const st = getStore();
    if (!st) return null;
    try {
        const blob = await st.getItem(key);
        if (!blob) return null;
        const index = await loadIndex();
        index[key] = { ...index[key], t: Date.now(), size: index[key]?.size ?? blob.size ?? 0 };
        saveIndexSoon();
        return rememberUrl(key, blob);
    } catch (e) {
        console.warn(LOG, 'cache read failed', e);
        return null;
    }
}

async function putCachedAudio(key, blob) {
    const st = getStore();
    if (!st) return;
    try {
        await st.setItem(key, blob);
        const index = await loadIndex();
        index[key] = { ...index[key], t: Date.now(), size: blob.size ?? 0 };
        await pruneCache();
        saveIndexSoon();
    } catch (e) {
        console.warn(LOG, 'cache write failed', e);
    }
}

async function pruneCache() {
    const st = getStore();
    const index = await loadIndex();
    const limit = Math.max(10, Number(getSettings().audioCacheMB) || 300) * 1024 * 1024;
    let total = Object.values(index).reduce((a, v) => a + (v.size || 0), 0);
    if (total <= limit) return;
    // ⭐ favourites are never pruned
    const oldestFirst = Object.entries(index).filter(([, meta]) => !meta?.fav).sort((a, b) => a[1].t - b[1].t);
    for (const [key, meta] of oldestFirst) {
        if (total <= limit * 0.9) break;
        await st.removeItem(key).catch(() => {});
        delete index[key];
        total -= meta.size || 0;
    }
}

async function cacheStats() {
    const index = await loadIndex();
    const entries = Object.values(index);
    const bytes = entries.reduce((a, v) => a + (v.size || 0), 0);
    return { count: entries.length, mb: bytes / 1024 / 1024 };
}

async function clearAudioCache() {
    const index = await loadIndex();
    const favs = Object.fromEntries(Object.entries(index).filter(([, meta]) => meta?.fav));
    if (!Object.keys(favs).length) {
        await getStore()?.clear();
        storeIndex = {};
    } else {
        // keep ⭐ favourites, drop everything else
        const st = getStore();
        for (const key of Object.keys(index)) {
            if (favs[key]) continue;
            await st?.removeItem(key).catch(() => {});
        }
        storeIndex = favs;
        await st?.setItem(INDEX_KEY, storeIndex).catch(() => {});
    }
    for (const [key, url] of memoryUrls) {
        if (favs[key]) continue;
        URL.revokeObjectURL(url);
        memoryUrls.delete(key);
    }
}

// --- ⭐ 즐겨찾기: kept forever (never pruned, survives '전부 지우기'), listed across chats ---

function isFav(key) {
    return !!storeIndex?.[key]?.fav;
}

async function setFav(key, on, line = null) {
    const index = await loadIndex();
    if (!index[key]) {
        toastr.info('이 기기에는 이 음성이 없어서 즐겨찾기할 수 없어요.', 'MultiCast TTS');
        return false;
    }
    if (on) {
        const ctx = SillyTavern.getContext();
        index[key].fav = true;
        index[key].info ??= {
            speaker: line?.speaker || '?',
            text: String(line?.text ?? '').slice(0, 300),
            bot: currentBot()?.name || ctx.name2 || '',
            at: Date.now(),
        };
    } else {
        delete index[key].fav;
    }
    saveIndexSoon();
    return true;
}

async function downloadKey(key, name) {
    const blob = await getStore()?.getItem(key).catch(() => null);
    if (!blob) {
        toastr.info('이 기기에는 저장된 음성이 없어요.', 'MultiCast TTS');
        return;
    }
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${name}.mp3`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

/** Who said it, in which bot — kept with the audio so voices from every chat can be listed. */
function noteClipInfo(key, line, bot = null) {
    if (!key || !line || isLocalSfxKey(key)) return;
    loadIndex().then((index) => {
        const meta = index[key];
        if (!meta || meta.info) return;
        const ctx = SillyTavern.getContext();
        meta.info = {
            speaker: line.speaker || '?',
            text: String(line.text ?? '').slice(0, 300),
            bot: bot ?? (currentBot()?.name || ctx.name2 || ''),
            at: meta.t || Date.now(),
        };
        saveIndexSoon();
    }).catch(() => {});
}

/** Fill in who/what for saved voices from a list of chat messages (this chat, or chats read from the server). */
function backfillFromMessages(messages, botName, index) {
    let filled = 0;
    for (const message of messages ?? []) {
        const root = message?.extra?.[MODULE_NAME];
        if (!root) continue;
        const variants = root.variants ?? (Array.isArray(root.script) ? { display: root } : {});
        for (const entry of Object.values(variants)) {
            for (const line of entry?.script ?? []) {
                const meta = line?.audioKey && index[line.audioKey];
                if (!meta || meta.info || isLocalSfxKey(line.audioKey)) continue;
                meta.info = { speaker: line.speaker || '?', text: String(line.text ?? '').slice(0, 300), bot: botName || '', at: meta.t || 0 };
                filled++;
            }
        }
    }
    return filled;
}

/** '예전 채팅 훑기': read every saved chat once and label the voices that were made before labels existed. */
async function scanAllChatsForVoices(onProgress) {
    const ctx = SillyTavern.getContext();
    const index = await loadIndex();
    const missing = () => Object.values(index).filter(m => !m.info).length;
    if (!missing()) return 0;
    const headers = ctx.getRequestHeaders();
    const post = async (url, body) => {
        const r = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
    };
    let filled = 0;
    const chars = ctx.characters ?? [];
    for (let c = 0; c < chars.length && missing(); c++) {
        const ch = chars[c];
        onProgress?.(`캐릭터 ${c + 1}/${chars.length} · ${ch.name}`);
        let list = [];
        try { list = Object.values(await post('/api/characters/chats', { avatar_url: ch.avatar, simple: true }) ?? {}); } catch { continue; }
        for (const item of list) {
            const file = String(item?.file_name ?? '').replace(/\.jsonl$/, '');
            if (!file) continue;
            try {
                const chat = await post('/api/chats/get', { ch_name: ch.name, file_name: file, avatar_url: ch.avatar });
                filled += backfillFromMessages(chat, ch.name, index);
            } catch { /* skip that chat */ }
            if (!missing()) break;
        }
    }
    for (const g of ctx.groups ?? []) {
        if (!missing()) break;
        onProgress?.(`그룹 · ${g.name}`);
        for (const id of g.chats ?? []) {
            try {
                const chat = await post('/api/chats/group/get', { id });
                filled += backfillFromMessages(chat, g.name, index);
            } catch { /* skip */ }
        }
    }
    saveIndexSoon();
    return filled;
}

/** Every saved voice on this device, from any bot: filter by bot · character · ⭐, search, play, keep, delete. */
async function openAllVoices({ favOnly = false } = {}) {
    const ctx = SillyTavern.getContext();
    const index = await loadIndex();
    backfillFromMessages(ctx.chat, currentBot()?.name || ctx.name2 || '', index); // this chat is already in memory
    saveIndexSoon();
    const $box = $(`
        <div class="vc_saved">
            <div class="vc_saved_head"><b>모든 봇의 대사 음성</b> <span class="vc_hint vc_all_count"></span>
                ${ctx.chat?.length ? '<span class="menu_button menu_button_icon vc_switch_list"><i class="fa-solid fa-list"></i><span>이 채팅만 보기</span></span>' : ''}</div>
            <div class="vc_saved_filters">
                <select class="text_pole vc_all_bot"><option value="">모든 봇</option></select>
                <select class="text_pole vc_all_speaker"><option value="">모든 캐릭터</option></select>
                <input class="text_pole vc_saved_search" type="search" placeholder="대사 검색" />
                <label class="checkbox_label vc_saved_favonly"><input type="checkbox" class="vc_all_fav" /><span>⭐만</span></label>
            </div>
            <div class="vc_all_unknown vc_hint"></div>
            <div class="vc_saved_list"></div>
        </div>`);
    $box.find('.vc_all_fav').prop('checked', favOnly);
    const $list = $box.find('.vc_saved_list');
    const entries = () => Object.entries(index).filter(([, m]) => m?.info);
    const fillSelects = () => {
        const bot = String($box.find('.vc_all_bot').val() ?? '');
        const bots = [...new Set(entries().map(([, m]) => m.info.bot || '(알 수 없음)'))].sort();
        $box.find('.vc_all_bot').html('<option value="">모든 봇</option>' + bots.map(b => `<option value="${escapeHtml(b)}">${escapeHtml(b)}</option>`).join('')).val(bots.includes(bot) ? bot : '');
        const curBot = String($box.find('.vc_all_bot').val() ?? '');
        const who = String($box.find('.vc_all_speaker').val() ?? '');
        const speakers = [...new Set(entries().filter(([, m]) => !curBot || (m.info.bot || '(알 수 없음)') === curBot).map(([, m]) => m.info.speaker || '?'))].sort();
        $box.find('.vc_all_speaker').html('<option value="">모든 캐릭터</option>' + speakers.map(n => `<option value="${escapeHtml(n)}">${escapeHtml(n)}</option>`).join('')).val(speakers.includes(who) ? who : '');
    };
    const renderUnknown = () => {
        const n = Object.values(index).filter(m => !m?.info).length;
        const $u = $box.find('.vc_all_unknown').empty();
        if (!n) return;
        $u.append(`예전에 만든 음성 ${n}개는 어느 대사인지 아직 몰라요. `);
        const $btn = $('<span class="menu_button menu_button_icon vc_all_scan"><i class="fa-solid fa-magnifying-glass"></i><span>예전 채팅 훑기</span></span>');
        $btn.on('click', async () => {
            $btn.addClass('disabled');
            const $st = $('<span class="vc_hint"> 훑는 중…</span>');
            $u.append($st);
            try {
                const got = await scanAllChatsForVoices(t => $st.text(` 훑는 중… ${t}`));
                toastr.success(`음성 ${got}개를 찾아서 정리했어요.`, 'MultiCast TTS');
            } catch (e) {
                toastr.error(String(e.message ?? e), 'MultiCast TTS');
            }
            fillSelects();
            render();
        });
        $u.append($btn);
    };
    const render = () => {
        renderUnknown();
        const bot = String($box.find('.vc_all_bot').val() ?? '');
        const who = String($box.find('.vc_all_speaker').val() ?? '');
        const fav = $box.find('.vc_all_fav').prop('checked');
        const q = String($box.find('.vc_saved_search').val() ?? '').trim().toLowerCase();
        const shown = entries()
            .filter(([, m]) => (!bot || (m.info.bot || '(알 수 없음)') === bot) && (!who || (m.info.speaker || '?') === who) && (!fav || m.fav)
                && (!q || `${m.info.text} ${m.info.speaker}`.toLowerCase().includes(q)))
            .sort((a, b) => (b[1].info.at || b[1].t || 0) - (a[1].info.at || a[1].t || 0));
        $box.find('.vc_all_count').text(`${shown.length}개`);
        if (!shown.length) {
            $list.html(`<div class="vc_empty">${fav ? '즐겨찾기한 음성이 없어요. ☆를 누르면 여기에 모여요.' : '보여줄 음성이 없어요.'}</div>`);
            return;
        }
        $list.empty();
        let lastBot = null;
        for (const [key, m] of shown.slice(0, 500)) {
            const info = m.info;
            const b = info.bot || '(알 수 없음)';
            if (!bot && b !== lastBot) {
                lastBot = b;
                $list.append($('<div class="vc_saved_group"></div>').text(b));
            }
            const $row = $(`
                <div class="vc_saved_row">
                    <div class="vc_icon_btn vc_clip_play fa-solid fa-play" data-key="${escapeHtml(key)}" title="듣기"></div>
                    <div class="vc_saved_text"><b></b> <span class="vc_all_text"></span></div>
                    <div class="vc_icon_btn vc_clip_fav ${m.fav ? 'vc_on fa-solid' : 'fa-regular'} fa-star" title="즐겨찾기 (시간이 지나도 안 지워져요)"></div>
                    <div class="vc_icon_btn vc_clip_dl fa-solid fa-download" title="mp3로 받기"></div>
                    <div class="vc_icon_btn vc_clip_del fa-solid fa-trash-can" title="이 음성 지우기"></div>
                </div>`);
            $row.find('b').text(info.speaker || '?');
            $row.find('.vc_all_text').text(info.text || '');
            $row.find('.vc_clip_play').on('click', () => playClip(key, { speaker: info.speaker }));
            $row.find('.vc_clip_dl').on('click', () => downloadKey(key, `${safeFileName(info.speaker)}_${safeFileName(info.text).slice(0, 20)}`));
            $row.find('.vc_clip_fav').on('click', async function () {
                const on = !m.fav;
                if (!(await setFav(key, on, { speaker: info.speaker, text: info.text }))) return;
                if (on) m.info.bot = info.bot; // keep the bot it came from
                $(this).toggleClass('vc_on fa-solid', on).toggleClass('fa-regular', !on);
            });
            $row.find('.vc_clip_del').on('click', async () => {
                const ok = await ctx.Popup.show.confirm('MultiCast TTS', `${m.fav ? '⭐ 즐겨찾기한 음성이에요. ' : ''}이 음성을 지울까요? 다시 들으면 새로 만들어져요(크레딧 사용).`);
                if (!ok) return;
                await deleteClip(key);
                fillSelects();
                render();
            });
            $list.append($row);
        }
        if (shown.length > 500) $list.append('<div class="vc_hint">최근 500개까지 보여요. 봇이나 캐릭터를 골라서 좁혀보세요.</div>');
        if (clipPlayKey) setClipPlaying(clipPlayKey);
    };
    $box.find('.vc_all_bot').on('change', () => { fillSelects(); render(); });
    $box.find('.vc_all_speaker, .vc_all_fav').on('change', render);
    $box.find('.vc_saved_search').on('input', render);
    fillSelects();
    render();
    const popup = new ctx.Popup($box, ctx.POPUP_TYPE.TEXT, '', { okButton: '닫기', wide: true, allowVerticalScrolling: true, leftAlign: true });
    popup.dlg?.classList.add('vc_editor_popup');
    let switchTo = null;
    $box.find('.vc_switch_list').on('click', () => { switchTo = 'chat'; popup.completeCancelled?.(); });
    await popup.show();
    if (clipPlayKey) stopPlayback();
    if (switchTo === 'chat') setTimeout(openSavedList, 50);
}

function openFavList() {
    return openAllVoices({ favOnly: true });
}

function audioCacheKey(text, voiceId, model, stability, similarity) {
    const raw = `${model}|${voiceId}|${stability}|${similarity}|${text}`;
    // two different 32-bit hashes + length → collision-safe enough for a local cache
    let h2 = 0;
    for (let i = 0; i < raw.length; i++) h2 = (Math.imul(h2, 31) + raw.charCodeAt(i)) | 0;
    return `a_${hashString(raw)}_${(h2 >>> 0).toString(36)}_${raw.length}`;
}

/**
 * @returns {Promise<{url: string, key: string}>}
 * @param {boolean} [fresh] skip the cache and store as a separate take (for "make a new take")
 */
let generationEpoch = 0;
let generationPaused = false;
let activeGenerationRequests = 0;
const generationQueues = new Set();

class GenerationStopped extends Error {
    constructor() { super('음성 생성이 중지되어 있어요. 설정에서 생성 다시 허용을 눌러 주세요.'); }
}

function updateGenerationUI() {
    $('#voice_cast_generation_toggle').text(generationPaused ? '생성 다시 허용' : '음성 생성 중지');
    $('#voice_cast_generation_status').text(generationPaused
        ? (activeGenerationRequests
            ? '생성 중지 · 이미 요청한 ' + activeGenerationRequests + '개는 완료 후 저장해요. 요청 취소·크레딧 환불을 뜻하지 않아요.'
            : '생성 중지 · 저장된 음성은 들을 수 있어요. 다시 허용해도 취소한 대기열은 자동으로 재시작하지 않아요.')
        : (activeGenerationRequests ? '음성 생성 요청 처리 중 ' + activeGenerationRequests + '개' : '생성 허용 · 필요한 음성이 없을 때 새로 만들어요.'));
}

function stopGeneration() {
    generationPaused = true;
    generationEpoch++;
    for (const cancel of generationQueues) cancel();
    updateGenerationUI();
}

function resumeGeneration() {
    generationPaused = false;
    updateGenerationUI();
}

function requireGeneration(epoch) {
    if (generationPaused || epoch !== generationEpoch) throw new GenerationStopped();
}

const audioInflight = new Map(); // cacheKey -> Promise (preload + play never pay twice for one line)

/** Stability/similarity for a line: the speaker's cast row can override the global sliders. */
function voiceSettingsFor(line) {
    const s = getSettings();
    const entry = line ? findCastEntry(line.speaker) : null;
    const num = (v, d) => (v === null || v === undefined || v === '' || Number.isNaN(Number(v)) ? d : Number(v));
    return {
        // a stability set on the cast row wins; otherwise the emotional range nudges it (steadier = calmer)
        stability: num(entry?.stability, rangeStability(entry, Number(s.stability))),
        similarity: num(entry?.similarity, Number(s.similarity)),
    };
}

async function synthesize(text, voiceId, opts = {}) {
    if (opts.localSfx) {
        const key = SFX_KEY_PREFIX + opts.localSfx;
        return { url: await getCachedAudio(key), key };
    }
    const s = getSettings();
    const fresh = !!opts.fresh;
    const baseKeyPreview = `${s.model}|${voiceId}|${opts.stability ?? s.stability}|${opts.similarity ?? s.similarity}|${text}`;
    if (!fresh && audioInflight.has(baseKeyPreview)) return audioInflight.get(baseKeyPreview);
    const p = synthesizeInner(text, voiceId, { ...opts, generationToken: opts.generationToken ?? generationEpoch });
    if (!fresh) {
        audioInflight.set(baseKeyPreview, p);
        p.finally(() => audioInflight.delete(baseKeyPreview)).catch(() => {});
    }
    return p;
}

async function synthesizeInner(text, voiceId, { fresh = false, stability: stabOverride, similarity: simOverride, generationToken = generationEpoch, generationActive = () => true } = {}) {
    const s = getSettings();
    let stability = Number(stabOverride ?? s.stability);
    const similarity = Number(simOverride ?? s.similarity);
    if (modelInfo(s.model).snapStability) {
        // eleven_v3 only accepts 0.0 / 0.5 / 1.0
        stability = [0, 0.5, 1].reduce((a, b) => (Math.abs(b - stability) < Math.abs(a - stability) ? b : a));
    }

    const baseKey = audioCacheKey(text, voiceId, s.model, stability, similarity);
    const cacheKey = fresh ? `${baseKey}_t${Date.now().toString(36)}` : baseKey;
    if (!fresh) {
        const cached = await getCachedAudio(cacheKey);
        if (cached) return { url: cached, key: cacheKey };
    }

    requireGeneration(generationToken);
    if (!generationActive()) throw new GenerationStopped();
    const { getRequestHeaders } = SillyTavern.getContext();
    activeGenerationRequests++;
    updateGenerationUI();
    try {
        const response = await fetch('/api/speech/elevenlabs/synthesize', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({
                voiceId,
                request: {
                    model_id: s.model,
                    text,
                    voice_settings: {
                        stability,
                        similarity_boost: similarity,
                    },
                },
            }),
        });
        if (!response.ok) {
            throw new Error(`ElevenLabs 요청 실패 (HTTP ${response.status}). 실리태번 서버 콘솔을 확인해 주세요. (402 payment_required면 무료 플랜에서 못 쓰는 목소리예요)`);
        }
        const blob = await response.blob();
        await putCachedAudio(cacheKey, blob);
        return { url: rememberUrl(cacheKey, blob), key: cacheKey };
    } finally {
        activeGenerationRequests--;
        updateGenerationUI();
    }
}

async function fetchVoices() {
    const { getRequestHeaders } = SillyTavern.getContext();
    const response = await fetch('/api/speech/elevenlabs/voices', {
        method: 'POST',
        headers: getRequestHeaders({ omitContentType: true }),
    });
    if (!response.ok) {
        const err = new Error(`HTTP ${response.status}`);
        err.status = response.status;
        throw err;
    }
    const json = await response.json();
    return (json.voices ?? []).map(v => ({
        id: v.voice_id,
        name: v.name,
        gender: v.labels?.gender ?? '',
        category: v.category ?? '',
        preview: v.preview_url ?? '',
    }));
}

// ---------------------------------------------------------------------------
// Playback
// ---------------------------------------------------------------------------

let session = 0;
let currentAudio = null;
let playingMessageId = null;

function setButtonState(messageId, playing) {
    const $btn = $(`.mes[mesid="${messageId}"] .vc_play_btn`);
    $btn.toggleClass('vc_playing', playing)
        .toggleClass('fa-volume-high', !playing)
        .toggleClass('fa-stop', playing)
        .attr('title', playing ? 'MultiCast TTS 정지' : 'MultiCast TTS 재생 (Shift+클릭: 다시 분류)');
}

// --- Status pill next to the speaker name (shows what MultiCast TTS is doing) ---

const statusTimers = new Map();

/**
 * @param {number|null} messageId
 * @param {string|null} html  null removes the pill
 * @param {'busy'|'play'|'done'|'error'} [state]
 */
function setStatus(messageId, html, state = 'busy') {
    if (messageId === null || messageId === undefined) return;
    clearTimeout(statusTimers.get(messageId));
    const $mes = $(`#chat .mes[mesid="${messageId}"]`);
    let $pill = $mes.find('.vc_status');
    if (!html) {
        $pill.remove();
        return;
    }
    if (!$pill.length) {
        $pill = $('<span class="vc_status" title="MultiCast TTS — 클릭하면 정지"></span>');
        const $anchor = $mes.find('.ch_name .name_text').first();
        if ($anchor.length) $anchor.parent().append($pill);
        else $mes.find('.mes_block').first().prepend($pill);
    }
    $pill.attr('data-state', state).html(html);
    if (state === 'done' || state === 'error') {
        statusTimers.set(messageId, setTimeout(() => $pill.remove(), state === 'error' ? 6000 : 1500));
    }
}

// --- Highlight the line being spoken (CSS Custom Highlight API; no DOM changes) ---

const HL_NAME = 'voice-cast-current';

let currentHlName = HL_NAME;

function clearHighlight() {
    try {
        globalThis.CSS?.highlights?.delete(HL_NAME);
        if (currentHlName !== HL_NAME) globalThis.CSS?.highlights?.delete(currentHlName);
    } catch { /* unsupported */ }
}

/** Highlight name for a character's color; the ::highlight() rule is added once per color. */
function highlightNameFor(line) {
    const color = line ? String(findCastEntry(line.speaker)?.color ?? '') : '';
    const m = /^#([0-9a-f]{6})$/i.exec(color);
    if (!m) return HL_NAME;
    const name = `vc-hl-${m[1].toLowerCase()}`;
    if (!document.getElementById(`vc_style_${name}`)) {
        const r = parseInt(m[1].slice(0, 2), 16), g = parseInt(m[1].slice(2, 4), 16), b = parseInt(m[1].slice(4, 6), 16);
        const style = document.createElement('style');
        style.id = `vc_style_${name}`;
        style.textContent = `::highlight(${name}) { background-color: rgba(${r}, ${g}, ${b}, 0.4); }`;
        document.head.appendChild(style);
    }
    return name;
}

/** Letters and digits only, lowercased: immune to quotes/apostrophes (' vs ’), ellipses, markdown and spacing. */
const MATCH_CHAR = /[\p{L}\p{N}]/u;

function textIndex(root) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let full = '';
    const map = []; // index in `full` -> { node, offset }
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        const t = n.nodeValue ?? '';
        for (let i = 0; i < t.length; i++) {
            if (!MATCH_CHAR.test(t[i])) continue;
            full += t[i].toLowerCase();
            map.push({ node: n, offset: i });
        }
    }
    return { full, map };
}

function bigrams(str) {
    const m = new Map();
    for (let i = 0; i < str.length - 1; i++) {
        const g = str.slice(i, i + 2);
        m.set(g, (m.get(g) ?? 0) + 1);
    }
    return m;
}

function dice(a, bTarget, bLen) {
    const ga = bigrams(a);
    let hit = 0;
    for (const [g, n] of ga) hit += Math.min(n, bTarget.get(g) ?? 0);
    return (2 * hit) / Math.max(1, (a.length - 1) + bLen);
}

/** Exact → follow-the-pieces → fuzzy (similar wording). Returns [start, end) in `full` or null. */
function matchSpan(full, target, from) {
    // 1) exact, preferring the part after the previous line
    let idx = full.indexOf(target, from);
    if (idx === -1) idx = full.indexOf(target);
    if (idx !== -1) return [idx, idx + target.length];
    if (target.length <= 8) return null;

    // 2) start matches, then follow the rest piece by piece (narration cut out of the middle, small edits)
    const k = Math.min(12, Math.floor(target.length / 2));
    let start = full.indexOf(target.slice(0, k), from);
    if (start === -1) start = full.indexOf(target.slice(0, k));
    if (start !== -1) {
        let end = start + k;
        let matched = k;
        let i = k;
        while (i < target.length) {
            const chunk = target.slice(i, i + Math.min(5, target.length - i));
            const q = full.indexOf(chunk, end);
            if (q === -1 || q - end > 300) { i++; continue; }
            let len = chunk.length;
            while (i + len < target.length && full[q + len] === target[i + len]) len++;
            end = q + len;
            i += len;
            matched += len;
        }
        if (matched / target.length >= 0.6) return [start, end];
    }

    // 3) fuzzy: the window whose wording is most similar (AI reworded the start, fixed typos, etc.)
    const L = target.length;
    if (full.length < L * 0.6) return null;
    const tg = bigrams(target);
    const tLen = L - 1;
    const step = Math.max(1, Math.floor(L / 8));
    let best = -1;
    let bestAt = -1;
    const score = (at) => {
        const sc = dice(full.slice(at, at + L), tg, tLen);
        // slight preference for text after the previous line
        return at >= from ? sc + 0.02 : sc;
    };
    for (let at = 0; at <= Math.max(0, full.length - Math.floor(L * 0.6)); at += step) {
        const sc = score(at);
        if (sc > best) { best = sc; bestAt = at; }
    }
    if (bestAt === -1) return null;
    for (let at = Math.max(0, bestAt - step); at <= bestAt + step; at++) {
        const sc = score(at);
        if (sc > best) { best = sc; bestAt = at; }
    }
    if (best < 0.62) return null;
    // fine-tune the start, then the end (one edge at a time keeps it fast)
    let bs = bestAt;
    let be = Math.min(full.length, bestAt + L);
    const pad = Math.min(step + 3, 20);
    for (let st = Math.max(0, bestAt - pad); st <= Math.min(be - 2, bestAt + pad); st++) {
        const sc = dice(full.slice(st, be), tg, tLen);
        if (sc > best) { best = sc; bs = st; }
    }
    for (let en = Math.max(bs + 2, be - pad); en <= Math.min(full.length, be + pad); en++) {
        const sc = dice(full.slice(bs, en), tg, tLen);
        if (sc > best) { best = sc; be = en; }
    }
    return [bs, be, true];
}

/** Grow a fuzzy match to whole words (only where words are separated by spaces). */
function snapToWords(map, start, end) {
    const isWordChar = ch => ch && MATCH_CHAR.test(ch);
    const a = map[start];
    while (a.offset > 0 && isWordChar(a.node.nodeValue[a.offset - 1])) a.offset--;
    const b = map[end - 1];
    while (b.offset + 1 < b.node.nodeValue.length && isWordChar(b.node.nodeValue[b.offset + 1])) b.offset++;
    return [a, b];
}

/**
 * @param {number} [from] index (in letters/digits) where the previous line ended — keeps repeated/short lines in order
 * @returns {Range|null} range with `vcEnd` (letters/digits index after the match)
 */
const spanCache = new WeakMap(); // message element → Map(key → span) — the same lookups repeat a lot

function findTextRange(root, needle, from = 0) {
    if (!root) return null;
    const { full, map } = textIndex(root);
    const target = [...String(needle ?? '')].filter(ch => MATCH_CHAR.test(ch)).join('').toLowerCase();
    if (!target || !full) return null;
    let cache = spanCache.get(root);
    if (!cache) { cache = new Map(); spanCache.set(root, cache); }
    const key = `${full.length}|${hashString(full)}|${Math.min(from, full.length)}|${target}`;
    let span = cache.get(key);
    if (span === undefined) {
        span = matchSpan(full, target, Math.min(from, full.length));
        if (cache.size > 500) cache.clear();
        cache.set(key, span);
    }
    if (!span) return null;
    const [start, end, fuzzy] = span;
    let a = map[start];
    let b = map[end - 1];
    if (fuzzy) [a, b] = snapToWords(map, start, end).map(x => ({ ...x }));
    const range = document.createRange();
    range.setStart(a.node, a.offset);
    range.setEnd(b.node, b.offset + 1);
    range.vcStart = start;
    range.vcEnd = end;
    return range;
}

// --- Original <-> translation mapping, so the highlight follows whichever one is on screen ---

const SEGMENT_RE = /"[^"\n]+"|\u201C[^\u201D\n]+\u201D|\u300C[^\u300D\n]+\u300D|\u300E[^\u300F\n]+\u300F|\*[^*\n]+\*/g;

/** Comparable form: no markdown/quote marks, collapsed spaces, lowercase. */
function normForMatch(str) {
    return String(str ?? '')
        .replace(/<[^>]+>/g, ' ')
        .replace(/[*_~`"\u201C\u201D\u300C\u300D\u300E\u300F]/g, '')
        .replace(/\s+/g, ' ')
        .trim()
        .toLowerCase();
}

function textLines(str) {
    return cleanMessageText(str).split('\n').map(l => l.trim()).filter(Boolean);
}

/** Every version of this message's text we know about (original first). */
function messageVersions(message) {
    const ex = message?.extra ?? {};
    const list = [message?.mes, ex.mirror_translator?.display, ex.display_text, ex.original_translation_backup];
    const seen = new Set();
    return list.filter(t => {
        if (!t || typeof t !== 'string') return false;
        const key = normForMatch(t);
        if (!key || seen.has(key)) return false;
        seen.add(key);
        return true;
    });
}

/** Comparable spoken letters, ignoring punctuation and spacing between joined dialogue pieces. */
function spokenKey(text) {
    return [...normForMatch(text)].filter(ch => MATCH_CHAR.test(ch)).join('');
}

/** Where the spoken line sits; segIndices covers dialogue joined across intervening narration. */
function locateLine(text, needle) {
    const target = normForMatch(needle);
    if (!target) return null;
    const probe = target.length > 16 ? target.slice(0, 16) : target;
    const lines = textLines(text);
    const spoken = spokenKey(needle);
    // Try complete groups before the old prefix/fuzzy fallback. A TTS line can contain
    // two or more quoted pieces while omitting the narration between them.
    if (spoken) for (let li = 0; li < lines.length; li++) {
        const segs = lines[li].match(SEGMENT_RE) ?? [];
        const keys = segs.map(spokenKey);
        for (let start = 0; start < keys.length; start++) {
            let joined = '';
            const indices = [];
            for (let end = start; end < keys.length; end++) {
                if (!keys[end]) continue;
                const candidate = joined + keys[end];
                if (!spoken.startsWith(candidate)) {
                    // Italic narration between quotes is not necessarily a spoken thought.
                    if (indices.length && segs[end].startsWith('*')) continue;
                    break;
                }
                joined = candidate;
                indices.push(end);
                if (indices.length > 1 && joined === spoken) {
                    return { lineIdx: li, segIdx: start, segIndices: indices };
                }
            }
        }
    }
    for (let li = 0; li < lines.length; li++) {
        const nl = normForMatch(lines[li]);
        if (!nl.includes(target) && !nl.includes(probe)) continue;
        const segs = lines[li].match(SEGMENT_RE) ?? [];
        const segIdx = segs.findIndex(sg => {
            const ns = normForMatch(sg);
            return ns && (ns.includes(probe) || target.includes(ns));
        });
        return { lineIdx: li, segIdx };
    }
    return null;
}

/** The matching piece of another version of the text (same line, same segment if possible). */
function pieceAt(text, pos) {
    const line = textLines(text)[pos.lineIdx];
    if (!line) return null;
    const segs = line.match(SEGMENT_RE) ?? [];
    const piece = pos.segIdx >= 0 && segs[pos.segIdx] ? segs[pos.segIdx] : line;
    return piece.replace(/^[*"\u201C\u300C\u300E]+|[*"\u201D\u300D\u300F]+$/g, '').replace(/[*_~`]/g, '').trim();
}

/** Match every piece of a joined spoken line, never paint the narration in between. */
function findPieceRanges(root, text, pos, from = 0) {
    if (!pos?.segIndices?.length) {
        const piece = pieceAt(text, pos);
        const range = piece && findTextRange(root, piece, from);
        return range ? [range] : [];
    }
    const line = textLines(text)[pos.lineIdx];
    const segments = line?.match(SEGMENT_RE) ?? [];
    if (pos.segIndices.some(index => !segments[index])) return [];
    const { full, map } = textIndex(root);
    const keys = pos.segIndices.map(index => spokenKey(segments[index]));
    if (keys.some(key => !key)) return [];
    const maxGap = spokenKey(line).length;
    // Retry a later first piece if an earlier repeated quote cannot complete the group.
    function search(startAt, stopBefore = Infinity) {
        let first = full.indexOf(keys[0], startAt);
        while (first !== -1 && first < stopBefore) {
            const spans = [];
            let cursor = first;
            for (const key of keys) {
                const start = full.indexOf(key, cursor);
                if (start === -1 || start - cursor > maxGap) break;
                spans.push([start, start + key.length]);
                cursor = start + key.length;
            }
            if (spans.length === keys.length) return spans;
            first = full.indexOf(keys[0], first + 1);
        }
        return null;
    }
    const spans = search(from) ?? (from > 0 ? search(0, from) : null);
    if (!spans) return [];
    const ranges = spans.map(([start, end]) => {
        const range = document.createRange();
        range.setStart(map[start].node, map[start].offset);
        range.setEnd(map[end - 1].node, map[end - 1].offset + 1);
        range.vcStart = start;
        range.vcEnd = end;
        return range;
    });
    // Existing cursor consumers read the first range: advance past the entire spoken group.
    ranges[0].vcEnd = spans[spans.length - 1][1];
    return ranges;
}

/** Side-by-side translation on screen: highlight the line in both languages. */
function findBilingualRanges(root, message, text) {
    const pairs = bilingualParts(message?.extra?.display_text);
    if (!pairs) return [];
    // SillyTavern prefixes classes inside messages with "custom-"
    const els = {
        orig: root.querySelectorAll('.original_text, .custom-original_text'),
        trans: root.querySelectorAll('.translated_text, .custom-translated_text'),
    };
    if (els.orig.length !== pairs.orig.length || els.trans.length !== pairs.trans.length) return [];
    const ranges = [];
    for (const [from, to] of [['orig', 'trans'], ['trans', 'orig']]) {
        for (let p = 0; p < pairs[from].length; p++) {
            const pos = locateLine(pairs[from][p], text);
            if (!pos) continue;
            if (pos.segIndices) {
                ranges.push(...findPieceRanges(els[from][p], pairs[from][p], pos));
                ranges.push(...findPieceRanges(els[to][p], pairs[to][p], { ...pos, lineIdx: 0 }));
            } else {
                const own = findTextRange(els[from][p], text) ?? findTextRange(els[from][p], pieceAt(pairs[from][p], pos));
                const piece = pieceAt(pairs[to][p], { lineIdx: 0, segIdx: pos.segIdx });
                const other = piece && findTextRange(els[to][p], piece);
                if (own) ranges.push(own);
                if (other) ranges.push(other);
            }
            if (ranges.length) return ranges;
        }
    }
    return ranges;
}

function findLineRanges(root, messageId, text, from = 0) {
    const message = SillyTavern.getContext().chat?.[messageId];
    const both = findBilingualRanges(root, message, text);
    if (both.length) {
        both.forEach(r => { delete r.vcEnd; delete r.vcStart; }); // per-paragraph positions, not usable as a message-wide cursor
        return both;
    }
    // Resolve complete dialogue groups before a fuzzy match can settle on just the first quote.
    const versions = messageVersions(message);
    for (const source of versions) {
        const pos = locateLine(source, text);
        if (!pos?.segIndices) continue;
        const own = findPieceRanges(root, source, pos, from);
        if (own.length) return own;
        for (const other of versions) {
            if (other === source) continue;
            const translated = findPieceRanges(root, other, pos, from);
            if (translated.length) return translated;
        }
    }
    const single = findLineRange(root, message, text, from);
    return single ? [single] : [];
}

/** Where (letters/digits index) the script's line #index should start searching: right after line #index-1. */
function cursorBefore(root, messageId, script, index) {
    let cursor = 0;
    for (let i = 0; i < index; i++) {
        const l = script[i];
        if (!l) continue;
        const r = findLineRanges(root, messageId, l.orig ?? l.text, cursor)[0];
        if (r?.vcEnd) cursor = r.vcEnd;
    }
    return cursor;
}

function findLineRange(root, message, text, from = 0) {
    const direct = findTextRange(root, text, from);
    if (direct) return direct;
    // not on screen as-is → the other language is showing; map through the line position
    if (!message) return null;
    const versions = messageVersions(message);
    for (const src of versions) {
        const pos = locateLine(src, text);
        if (!pos) continue;
        for (const other of versions) {
            if (other === src) continue;
            const piece = pieceAt(other, pos);
            const range = piece && findTextRange(root, piece);
            if (range) return range;
        }
    }
    return null;
}

/** @returns {number|null} where this line ended (pass as `from` for the next line) */
function highlightLine(messageId, text, line = null, from = 0) {
    clearHighlight();
    if (messageId === null || !getSettings().highlight) return null;
    if (!globalThis.CSS?.highlights || typeof globalThis.Highlight === 'undefined') return null;
    const root = document.querySelector(`#chat .mes[mesid="${messageId}"] .mes_text`);
    if (!root) return null;
    try {
        const ranges = findLineRanges(root, messageId, text, from);
        if (ranges.length) {
            currentHlName = highlightNameFor(line);
            CSS.highlights.set(currentHlName, new Highlight(...ranges));
            return ranges[0].vcEnd ?? null;
        }
    } catch (e) {
        console.debug(LOG, 'highlight failed', e);
    }
    return null;
}

// --- 특정 캐릭터만 듣기 (per bot) ---

function listenState(create = false) {
    const bot = currentBot();
    if (!bot) return null;
    const s = getSettings();
    s.listenOnly ??= {};
    if (!s.listenOnly[bot.key] && create) s.listenOnly[bot.key] = { on: false, keys: [], known: [], others: true };
    return s.listenOnly[bot.key] ?? null;
}

/** One key per character: '__user__' for the user's character, the cast row's first name, or the speaker name. */
function speakerKey(speaker) {
    const n = normName(speaker);
    if (!n) return '';
    if (userCharacterNames().has(n)) return '__user__';
    const entry = findCastEntry(speaker);
    if (entry) {
        const first = String(entry.names ?? '').split(',')[0]?.trim();
        if (first && first.toLowerCase() !== '{{user}}') return normName(first);
    }
    return n;
}

/** Everyone who could be picked: me, this bot's cast, the shared cast, and speakers found in this chat. */
function listenCandidates() {
    const ctx = SillyTavern.getContext();
    const out = new Map(); // key → label
    out.set('__user__', `나 (${userNameFor((ctx.chat?.length ?? 1) - 1) || '내 캐릭터'})`);
    for (const e of allCastEntries()) {
        const first = String(e.names ?? '').split(',')[0]?.trim();
        if (!first || first.toLowerCase() === '{{user}}') continue;
        const k = speakerKey(first);
        if (k && !out.has(k)) out.set(k, first);
    }
    for (const m of ctx.chat ?? []) {
        const variants = m?.extra?.[MODULE_NAME]?.variants ?? {};
        for (const entry of Object.values(variants)) {
            for (const line of entry?.script ?? []) {
                if (!line?.speaker || line.type === 'sfx') continue;
                const k = speakerKey(line.speaker);
                if (k && !out.has(k)) out.set(k, line.speaker);
            }
        }
    }
    return out;
}

/** Should this line be voiced under 특정 캐릭터만 듣기? */
function listenAllows(line) {
    if (line?.type === 'sfx') return true;
    const st = listenState();
    if (!st?.on) return true;
    const k = speakerKey(line?.speaker);
    if (st.keys.includes(k)) return true;
    if (st.known.includes(k)) return false;
    return !!st.others; // someone new (side characters etc.)
}

function renderListenList() {
    const $box = $('#voice_cast_listen_list');
    if (!$box.length) return;
    const st = listenState();
    $('#voice_cast_listen_on').prop('checked', !!st?.on);
    if (!currentBot()) {
        $('#voice_cast_listen_on').prop('disabled', true);
        $box.hide();
        return;
    }
    $('#voice_cast_listen_on').prop('disabled', false);
    if (!st?.on) { $box.hide().empty(); return; }
    const cands = listenCandidates();
    // anyone newly found since last time starts checked
    for (const k of cands.keys()) {
        if (!st.known.includes(k)) { st.known.push(k); st.keys.push(k); }
    }
    $box.empty().show();
    for (const [k, label] of cands) {
        const $l = $(`<label class="checkbox_label"><input type="checkbox" /><span></span></label>`);
        $l.find('span').text(label);
        $l.find('input').prop('checked', st.keys.includes(k)).on('change', function () {
            st.keys = st.keys.filter(x => x !== k);
            if (this.checked) st.keys.push(k);
            save();
            refreshLineButtons({ rebuild: true });
        });
        $box.append($l);
    }
    const $o = $(`<label class="checkbox_label vc_listen_others"><input type="checkbox" /><span>그 외 새로 나오는 사람 (모브·단역)</span></label>`);
    $o.find('input').prop('checked', !!st.others).on('change', function () {
        st.others = this.checked;
        save();
        refreshLineButtons({ rebuild: true });
    });
    $box.append($o);
}

let paused = false;
let nowPlaying = null; // { messageId, line, index, total } — what the bottom player shows

function setNowPlaying(info) {
    nowPlaying = info;
    updatePlayer();
}

async function waitWhilePaused(mySession, generationToken = generationEpoch) {
    while (paused && mySession === session && generationToken === generationEpoch) await sleep(200);
}

/** ⏯ — pause/resume; when nothing is playing, plays the last message. */
function togglePause() {
    const busy = playingMessageId !== null || linePlay || clipPlayKey;
    if (!busy && lastLine && stepLine(1, { quiet: true })) return; // ⏯ while idle: go on from the line heard last
    if (!busy) {
        const chat = SillyTavern.getContext().chat ?? [];
        for (let j = chat.length - 1; j >= 0; j--) {
            if (chat[j] && !chat[j].is_system && !chat[j].is_user) { playMessage(j); return; }
        }
        return;
    }
    paused = !paused;
    if (paused) currentAudio?.pause();
    else currentAudio?.play().catch(() => {});
    for (const a of bedAudios) { if (paused) a.pause(); else a.play().catch(() => {}); }
    updatePlayer();
}

// 효과음 겹쳐 재생: sounds that play under the voices (not waited for)
const overlayAudios = new Set();
function playOverlay(url, line) {
    const audio = new Audio(url);
    const master = Number(getSettings().volume);
    audio.volume = Math.min(1, Math.max(0, (Number.isNaN(master) ? 1 : master) * castVolumeFor(line) * 0.85));
    overlayAudios.add(audio);
    const done = () => overlayAudios.delete(audio);
    audio.onended = done;
    audio.onerror = done;
    audio.play().catch(done);
}

// 🔁 반복: a sound of mine marked 🔁 loops quietly (30%) under the voices until the message ends, then fades out.
const bedAudios = new Set();
function isLoopSfxKey(key) {
    if (!key || !isLocalSfxKey(key)) return false;
    const id = customSfxIdFromKey(key);
    return !!id && (getSettings().customSfx ?? []).some(c => String(c.id) === String(id) && c.loop);
}
function fadeAudio(audio, to, ms, then) {
    const from = audio.volume;
    const t0 = performance.now();
    clearInterval(audio._vcFade);
    audio._vcFade = setInterval(() => {
        const k = Math.min(1, (performance.now() - t0) / ms);
        audio.volume = Math.min(1, Math.max(0, from + (to - from) * k));
        if (k >= 1) { clearInterval(audio._vcFade); then?.(); }
    }, 40);
}
// up to 3 loops play together (kiss + bed creak …); the more there are, the softer each one gets
const BED_MAX = 3;
const BED_GAIN = [1, 0.8, 0.65];
function activeBeds() {
    return [...bedAudios].filter(a => !a._vcStopping);
}
function balanceBeds(ms = 400) {
    const live = activeBeds();
    const g = BED_GAIN[Math.min(live.length, BED_GAIN.length) - 1] ?? 0.65;
    for (const a of live) fadeAudio(a, Math.min(1, a._vcBase * g), ms);
}
function playBed(url, line) {
    const key = line?.audioKey || url;
    // the same loop again → it is already playing, keep it going
    if (activeBeds().some(a => a._vcKey === key)) return;
    const master = Number(getSettings().volume);
    const audio = new Audio(url);
    audio._vcKey = key;
    audio._vcBase = Math.min(1, Math.max(0, (Number.isNaN(master) ? 1 : master) * castVolumeFor(line) * 0.3));
    audio.volume = 0;
    const done = () => { clearInterval(audio._vcFade); bedAudios.delete(audio); };
    audio.onerror = done;
    audio.loop = true;
    // too many loops → the oldest one fades out
    const live = activeBeds();
    if (live.length >= BED_MAX) stopBed(live[0], 800);
    bedAudios.add(audio);
    audio.play().then(() => balanceBeds()).catch(done);
}
function stopBed(audio, ms) {
    audio._vcStopping = true;
    fadeAudio(audio, 0, ms, () => { audio.pause(); bedAudios.delete(audio); });
    balanceBeds(ms);
}
function stopAllBeds(ms = 0) {
    for (const a of [...bedAudios]) {
        if (ms > 0 && !a.paused) stopBed(a, ms);
        else { clearInterval(a._vcFade); a.pause(); bedAudios.delete(a); }
    }
}

function stopPlayback() {
    const wasPlaying = apiActive;
    for (const a of overlayAudios) a.pause();
    overlayAudios.clear();
    stopAllBeds(300);
    session++;
    paused = false;
    setNowPlaying(null);
    clearHighlight();
    setLinePlaying(null);
    setClipPlaying(null);
    if (currentAudio) {
        currentAudio.pause();
        currentAudio = null;
    }
    if (playingMessageId !== null) {
        setButtonState(playingMessageId, false);
        setStatus(playingMessageId, null);
        playingMessageId = null;
    }
    if (wasPlaying) apiSetIdle('stopped');
}

/** Per-character volume from the cast row (1 = 100%, up to 2 = 200%). */
function castVolumeFor(line) {
    const v = line ? findCastEntry(line.speaker)?.volume : null;
    return v === null || v === undefined || v === '' || Number.isNaN(Number(v)) ? 1 : Math.max(0, Number(v));
}

let audioCtx = null;
/** Above 100% the <audio> element can't go louder by itself → route it through a Web Audio gain node. */
function boostAudio(audio, gain) {
    try {
        const AC = globalThis.AudioContext || globalThis.webkitAudioContext;
        if (!AC) return;
        audioCtx ??= new AC();
        if (audioCtx.state === 'suspended') audioCtx.resume().catch(() => {});
        const node = audioCtx.createGain();
        node.gain.value = gain;
        audioCtx.createMediaElementSource(audio).connect(node).connect(audioCtx.destination);
    } catch (e) {
        console.warn(LOG, 'volume boost failed', e);
    }
}

let finishCurrentLine = null; // resolves the line that's playing now (used by ⏮ ⏭)
const playCtl = { jump: null };  // ⏮ = -1, ⏭ = +1 while a message is playing

/** ⏮ / ⏭ from the status pill: jump to the previous/next line of the message that's playing. */
function skipLine(delta) {
    if (playingMessageId === null || !finishCurrentLine) {
        stepLine(delta);
        return;
    }
    playCtl.jump = delta;
    paused = false;
    currentAudio?.pause();
    finishCurrentLine();
}

function playUrl(url, mySession, line = null) {
    return new Promise((resolve) => {
        if (mySession !== session) return resolve();
        finishCurrentLine = resolve;
        const audio = new Audio(url);
        const master = Number(getSettings().volume);
        const vol = (Number.isNaN(master) ? 1 : Math.max(0, master)) * castVolumeFor(line);
        audio.volume = Math.min(1, vol);
        const own = Number(line ? findCastEntry(line.speaker)?.rate : NaN);
        const rate = (Number(getSettings().rate) || 1) * (own > 0 ? own : 1);
        audio.playbackRate = Math.min(2, Math.max(0.5, rate));
        audio.preservesPitch = true;
        if (vol > 1) boostAudio(audio, vol);
        currentAudio = audio;
        audio.onended = () => resolve();
        audio.onerror = () => { console.warn(LOG, 'audio error'); resolve(); };
        audio.play().catch((e) => { console.warn(LOG, 'play blocked:', e); resolve(); });
    });
}

/**
 * Starts synthesis for all lines with limited concurrency; returns one promise per line.
 * @param {(ready: number) => void} [onProgress] called whenever another line is ready
 */
function synthesizeAll(lines, isActive, onProgress = null) {
    if (typeof isActive === 'number') {
        const mySession = isActive;
        isActive = () => mySession === session;
    }
    const token = generationEpoch;
    const wasActive = isActive;
    isActive = () => token === generationEpoch && wasActive();
    const limit = Math.max(1, Number(getSettings().concurrency) || 2);
    const results = lines.map(() => {
        let resolve;
        const p = new Promise(r => { resolve = r; });
        return { p, resolve };
    });
    let next = 0;
    let ready = 0;
    let firstError = true;
    let pinnedChanged = false;
    let running = 0;
    let doneResolve;
    const done = new Promise(r => { doneResolve = r; });
    const cancel = () => { for (const r of results) r.resolve(null); };
    generationQueues.add(cancel);
    done.then(() => generationQueues.delete(cancel));
    const finish = (i, url) => {
        results[i].resolve(url);
        ready++;
        try { onProgress?.(ready); } catch { /* ignore */ }
    };

    async function worker() {
        while (next < lines.length && isActive()) {
            const i = next++;
            const { text, voiceId, src } = lines[i];
            try {
                // 1) audio already pinned to this script line → replay it exactly, whatever the settings are now
                if (src?.audioKey && !src._fresh) {
                    if (isBlockedAdultKey(src.audioKey)) { finish(i, null); continue; }
                    const pinned = await getCachedAudio(src.audioKey);
                    if (pinned) {
                        finish(i, pinned);
                        continue;
                    }
                }
                const fresh = !!src?._fresh;
                if (src) delete src._fresh;
                if (!isActive()) break;
                const { url, key } = await synthesize(text, voiceId, { fresh, ...voiceSettingsFor(src), localSfx: localSfxFor(src), generationToken: token, generationActive: isActive });
                if (src && src.audioKey !== key) {
                    src.audioKey = key;
                    pinnedChanged = true;
                }
                noteClipInfo(key, src);
                finish(i, url);
            } catch (e) {
                if (e instanceof GenerationStopped) {
                    cancel();
                    break;
                }
                console.error(LOG, e);
                if (firstError) {
                    firstError = false;
                    toastr.error(String(e.message ?? e), 'MultiCast TTS');
                }
                finish(i, null);
            }
        }
        // cancelled: release anyone still waiting (resolving twice is a no-op for finished ones)
        if (!isActive()) {
            for (const r of results) r.resolve(null);
        }
    }
    const workers = Math.min(limit, lines.length);
    running = workers;
    for (let w = 0; w < workers; w++) {
        worker().finally(() => { if (--running === 0) doneResolve(pinnedChanged); });
    }
    if (!workers) doneResolve(false);
    return { promises: results.map(r => r.p), done };
}

/** Script lines that will actually be voiced, with their voice and final TTS text. */
/** Names the user's character goes by in this chat (selected persona + names on the user's messages). */
function userCharacterNames() {
    const ctx = SillyTavern.getContext();
    const names = new Set([normName(ctx.name1), '{{user}}', 'user']);
    for (const m of ctx.chat ?? []) if (m?.is_user && m.name) names.add(normName(m.name));
    return names;
}

function buildPlayableLines(script, { keepThoughts = false } = {}) {
    const s = getSettings();
    return script
        .filter(l => keepThoughts || s.includeThoughts || l.type !== 'thought')
        .filter(l => keepThoughts || listenAllows(l))
        .filter(l => l.type !== 'sfx' || keepThoughts || sfxPlayable(l))
        .map(l => ({ src: l, voiceId: pickVoice(l) || (localSfxFor(l) ? 'local-sfx' : ''), ttsText: buildTtsText(l) }))
        .filter(l => l.voiceId || l.src.audioKey);
}

function savePinsWhenDone(done, messageId) {
    const chatAtStart = SillyTavern.getContext().chat;
    done.then((changed) => {
        const ctxNow = SillyTavern.getContext();
        if (changed && messageId !== null && ctxNow.chat === chatAtStart) {
            ctxNow.saveChat();
            redecorateMessage(messageId);
        }
    });
}

const PACING = {
    natural: { same: 250, change: 650, thought: 150, perChar: 12, narrMax: 1500, between: 1200 },
    slow: { same: 450, change: 1000, thought: 250, perChar: 20, narrMax: 2500, between: 2000 },
};

const sleep = ms => new Promise(r => setTimeout(r, ms));

/**
 * Breathing room before a line: longer when the speaker changes or there's narration in between
 * (roughly the time it takes to read that narration).
 */
/** The 호흡 sliders as one profile, or null when every in-message pause is 0 ("바로 이어서"). */
function pacingProfile() {
    const s = getSettings();
    const n = (v) => Math.max(0, Number(v) || 0);
    const same = n(s.pauseSame), change = n(s.pauseChange), narr = n(s.pauseNarr);
    if (!same && !change && !narr) return null;
    return { same, change, thought: Math.round(Math.min(same, change) * 0.5), perChar: 12 * narr, narrMax: 1500 * narr };
}

function pauseBetweenMessages() {
    return Math.max(0, Number(getSettings().pauseBetween) || 0);
}

function pauseBefore(prev, cur, narrChars) {
    const p = pacingProfile();
    if (!p || !prev) return 0;
    let ms = normName(prev.speaker) === normName(cur.speaker) ? p.same : p.change;
    if (cur.type === 'thought' || prev.type === 'thought') ms += p.thought;
    if (narrChars > 0) ms += Math.min(p.narrMax, narrChars * p.perChar);
    return ms;
}

/** Next message to go on to (skips system/empty ones). */
function nextPlayableMessage(messageId) {
    const chat = SillyTavern.getContext().chat ?? [];
    for (let j = messageId + 1; j < chat.length; j++) {
        const m = chat[j];
        if (m && !m.is_system && getMessageText(m)) return j;
    }
    return null;
}

/**
 * @param {number|null} messageId message to play (null = loose script, e.g. a single-line preview)
 * @param {object} opts
 * @param {boolean} [opts.force] re-classify even if a cached script exists
 * @param {Array} [opts.script] play this script instead of the message's stored one
 */
/** Does this message already have voice audio saved on this device (current language mode)? */
function hasSavedAudio(messageId) {
    const script = getStoredEntry(SillyTavern.getContext().chat?.[messageId])?.script;
    return Array.isArray(script) && script.some(l => l?.audioKey && storeIndex?.[l.audioKey]);
}

/** Nearest message before/after this one that already has saved audio (user or bot). */
function adjacentSavedMessage(messageId, dir) {
    const chat = SillyTavern.getContext().chat ?? [];
    for (let j = messageId + dir; j >= 0 && j < chat.length; j += dir) {
        if (chat[j] && !chat[j].is_system && hasSavedAudio(j)) return j;
    }
    return null;
}

/** Go on to another message after a short breath (cancelled if the user stopped/started something meanwhile). */
function hopTo(target, opts) {
    if (autoHolds.size) return; // 이어 듣기 waits while another extension holds auto play
    const sessAtEnd = session;
    const chatAtEnd = SillyTavern.getContext().chat;
    setTimeout(() => {
        if (session !== sessAtEnd || SillyTavern.getContext().chat !== chatAtEnd || playingMessageId !== null) return;
        document.querySelector(`#chat .mes[mesid="${target}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
        playMessage(target, opts);
    }, opts?.quick ? 150 : pauseBetweenMessages());
}

/**
 * @param {object} [opts.savedOnly] play only lines whose audio is already saved (never classifies or generates)
 * @param {number|'last'} [opts.startAt] line to start from
 */
async function playMessage(messageId, { force = false, script: givenScript = null, savedOnly = false, startAt = 0 } = {}) {
    const s = getSettings();
    if (!s.enabled) return;
    const generationAtStart = generationEpoch;
    if (savedOnly) await loadIndex();

    stopPlayback();
    const mySession = session;
    playingMessageId = messageId;
    apiSetPlaying(messageId);
    if (messageId !== null) setButtonState(messageId, true);
    let failed = false;
    let crossDir = 0; // ⏭ on the last line → +1, ⏮ on the first line → -1

    try {
        let script = givenScript;
        if (!script && savedOnly) script = getStoredEntry(SillyTavern.getContext().chat[messageId])?.script ?? [];
        if (!script) {
            const cachedBefore = getStoredEntry(SillyTavern.getContext().chat[messageId]);
            if (force || !cachedBefore) {
                setStatus(messageId, '<i class="fa-solid fa-spinner fa-spin"></i> 대사 분류 중…');
            }
            script = await getScript(messageId, { force });
        }
        if (mySession !== session || generationAtStart !== generationEpoch) return;

        if (generationAtStart !== generationEpoch) return;
        let lines = buildPlayableLines(script, { keepThoughts: !!givenScript });
        if (savedOnly) lines = lines.filter(l => keyHasAudio(l.src.audioKey));
        if (!lines.length) {
            if (script.length && !s.maleVoiceId && !s.femaleVoiceId && !s.unknownVoiceId) {
                toastr.warning('목소리가 설정되지 않았어요. 확장 설정에서 기본 목소리를 골라주세요.', 'MultiCast TTS');
            } else {
                toastr.info('읽을 대사가 없어요.', 'MultiCast TTS');
            }
            setStatus(messageId, '대사 없음', 'done');
            return;
        }

        const total = lines.length;
        let ready = 0;
        let playingIndex = -1;
        const render = () => {
            if (mySession !== session || generationAtStart !== generationEpoch) return;
            const gen = ready < total ? `<i class="fa-solid fa-spinner fa-spin"></i> 음성 만드는 중 ${ready}/${total}` : '';
            if (playingIndex < 0) {
                setStatus(messageId, gen || '<i class="fa-solid fa-spinner fa-spin"></i> 준비 중…');
            } else {
                setStatus(messageId, `<span class="vc_skip fa-solid fa-backward-step" data-d="-1" title="이전 대사"></span> <i class="fa-solid fa-volume-high"></i> ${playingIndex + 1}/${total} <span class="vc_skip fa-solid fa-forward-step" data-d="1" title="다음 대사"></span>${gen ? ` · ${gen}` : ''}`, 'play');
            }
        };
        render();

        console.debug(LOG, 'playing lines:', lines);
        const { promises: audioPromises, done } = synthesizeAll(
            lines.map(l => ({ text: l.ttsText, voiceId: l.voiceId, src: l.src })),
            mySession,
            (n) => { ready = n; render(); },
        );
        // newly generated audio gets pinned to the script lines → save so replays use exactly this take
        savePinsWhenDone(done, messageId);

        let hlCursor = 0;
        let prevPlayed = null;
        playCtl.jump = null;
        const root = messageId !== null ? document.querySelector(`#chat .mes[mesid="${messageId}"] .mes_text`) : null;
        const first = startAt === 'last' ? lines.length - 1 : Math.min(Math.max(0, Number(startAt) || 0), lines.length - 1);
        let jumped = first > 0;
        for (let i = first; i < audioPromises.length; i++) {
            if (generationAtStart !== generationEpoch) break;
            if (playCtl.jump !== null) {
                // ⏮ goes back one line (i was already moved forward by the loop), ⏭ just continues
                const d = playCtl.jump;
                playCtl.jump = null;
                jumped = true;
                if (d < 0) {
                    if (i - 2 < 0) { crossDir = -1; break; } // ⏮ on the first line → previous message
                    i -= 2;
                }
            }
            const url = await audioPromises[i];
            if (mySession !== session || generationAtStart !== generationEpoch) return;
            if (!url) continue;
            const lineText = lines[i].src.orig ?? lines[i].src.text;
            // 겹쳐 재생: a sound effect starts and the next line follows right away
            const loopSfx = lines[i].src.type === 'sfx' && isLoopSfxKey(lines[i].src.audioKey);
            if (lines[i].src.type === 'sfx' && (loopSfx || getSettings().sfxOverlay)) {
                await waitWhilePaused(mySession, generationAtStart);
                if (mySession !== session || generationAtStart !== generationEpoch) return;
                if (loopSfx) playBed(url, lines[i].src); // 🔁 sounds: loop under the voices till the message ends
                else playOverlay(url, lines[i].src);
                continue;
            }
            if (jumped) {
                // jumped with ⏮/⏭: no breathing pause, and search the highlight from the right spot
                jumped = false;
                prevPlayed = null;
                hlCursor = root ? cursorBefore(root, messageId, lines.map(l => l.src), i) : 0;
            }
            // breathing room (setting): how much narration sits between the previous line and this one
            if (prevPlayed && pacingProfile()) {
                let narr = 0;
                if (root) {
                    try {
                        const r = findLineRanges(root, messageId, lineText, hlCursor)[0];
                        if (r?.vcStart !== undefined && r.vcStart >= hlCursor) narr = r.vcStart - hlCursor;
                    } catch { /* ignore */ }
                }
                await sleep(pauseBefore(prevPlayed, lines[i].src, narr));
                if (mySession !== session || generationAtStart !== generationEpoch) return;
            }
            await waitWhilePaused(mySession, generationAtStart);
            if (mySession !== session || generationAtStart !== generationEpoch) return;
            playingIndex = i;
            render();
            setNowPlaying({ messageId, line: lines[i].src, index: i, total: lines.length });
            if (messageId !== null) lastLine = { messageId, index: script.indexOf(lines[i].src) };
            const end = highlightLine(messageId, lineText, lines[i].src, hlCursor);
            if (end) hlCursor = end;
            prevPlayed = lines[i].src;
            await playUrl(url, mySession, lines[i].src);
            if (mySession !== session || generationAtStart !== generationEpoch) return;
            // 한 줄씩: stop after each line and wait for ⏭ / ⏮ / ⏯
            if (generationAtStart === generationEpoch && getSettings().stepMode && playCtl.jump === null) {
                paused = true;
                updatePlayer();
                await waitWhilePaused(mySession, generationAtStart);
                if (mySession !== session || generationAtStart !== generationEpoch) return;
                if (playCtl.jump === null && i === audioPromises.length - 1) playCtl.jump = 1; // ⏯ on the last line → go on
                prevPlayed = null; // no extra breathing pause after a manual step
            }
        }
        if (playCtl.jump !== null && mySession === session) {
            if (playCtl.jump > 0) crossDir = 1; // ⏭ on the last line → next message
            playCtl.jump = null;
        }
    } catch (e) {
        failed = true;
        console.error(LOG, e);
        toastr.error(String(e.message ?? e), 'MultiCast TTS');
        if (mySession === session) setStatus(messageId, '<i class="fa-solid fa-triangle-exclamation"></i> 실패', 'error');
    } finally {
        if (mySession === session) {
            stopAllBeds(1800); // 배경에 깔린 소리: fade out as the message ends
            clearHighlight();
            if (messageId !== null) {
                setButtonState(messageId, false);
                if (!failed) setStatus(messageId, generationAtStart !== generationEpoch ? '생성 대기열 중지됨' : '<i class="fa-solid fa-check"></i> 끝', 'done');
            }
            playingMessageId = null;
            currentAudio = null;
            paused = false;
            setNowPlaying(null);
            apiSetIdleSoon(failed ? 'error' : 'done');
            if (!failed && !givenScript && messageId !== null && generationAtStart === generationEpoch) {
                if (crossDir) {
                    // ⏮/⏭ past the edge: hop to the previous/next message that already has audio (no credits)
                    const target = adjacentSavedMessage(messageId, crossDir);
                    if (target !== null) hopTo(target, { savedOnly: true, startAt: crossDir < 0 ? 'last' : 0, quick: true });
                    else toastr.info(crossDir > 0 ? '다음에 저장된 음성이 없어요.' : '이전에 저장된 음성이 없어요.', 'MultiCast TTS', { timeOut: 1500 });
                } else if (getSettings().continuePlay) {
                    // 이어 듣기
                    if (getSettings().continueMode === 'all') {
                        const next = nextPlayableMessage(messageId);
                        if (next !== null) hopTo(next, {});
                    } else {
                        const next = adjacentSavedMessage(messageId, 1);
                        if (next !== null) hopTo(next, { savedOnly: true });
                    }
                }
            }
        }
    }
}

// ---------------------------------------------------------------------------
// ▶ next to each line in the chat (only lines that already have audio → never costs credits)
// ---------------------------------------------------------------------------

const LINE_BTN = 'vc_line_play';

function readMode() {
    const m = getSettings().readMode;
    return m === 'all' || m === 'tap' ? m : 'off';
}

function lineButtonsOn() {
    const s = getSettings();
    // read mode shows ▶ unless the user hears lines by holding them instead
    return !!s.lineButtons || (readMode() !== 'off' && !s.holdToPlay);
}

// --- 대사 꾹 눌러서 듣기 ---

const HOLD_MS = 450; // a bit under the phone's own long-press menu
const HOLD_SLOP = 10; // px the finger may wander before the hold is cancelled
let holdState = null;
let suppressClickUntil = 0;

function caretAt(x, y) {
    if (document.caretRangeFromPoint) {
        const r = document.caretRangeFromPoint(x, y);
        return r ? { node: r.startContainer, offset: r.startOffset } : null;
    }
    if (document.caretPositionFromPoint) {
        const p = document.caretPositionFromPoint(x, y);
        return p ? { node: p.offsetNode, offset: p.offset } : null;
    }
    return null;
}

/** Which script line was held: the line whose text range contains the press point. */
function lineIndexAt(messageId, root, script, point) {
    let cursor = 0;
    for (let index = 0; index < script.length; index++) {
        const line = script[index];
        if (!line) continue;
        let ranges = [];
        try { ranges = findLineRanges(root, messageId, line.orig ?? line.text, cursor); } catch { ranges = []; }
        if (ranges[0]?.vcEnd) cursor = ranges[0].vcEnd;
        for (const r of ranges) {
            try { if (r.comparePoint(point.node, point.offset) === 0) return index; } catch { /* other tree */ }
        }
    }
    return -1;
}

async function playHeldLine(mesEl, point) {
    const messageId = Number(mesEl.getAttribute('mesid'));
    const root = mesEl.querySelector('.mes_text');
    const message = SillyTavern.getContext().chat?.[messageId];
    if (Number.isNaN(messageId) || !root || !message || message.is_system) return;
    let script = getStoredEntry(message)?.script;
    if (!Array.isArray(script)) {
        toastr.info('대사 분류 중...', 'MultiCast TTS', { timeOut: 1500 });
        try { script = await getScript(messageId); } catch (e) {
            toastr.error(String(e.message ?? e), 'MultiCast TTS');
            return;
        }
    }
    const index = lineIndexAt(messageId, root, script, point);
    if (index < 0) return; // held narration, not a line
    navigator.vibrate?.(15);
    playScriptLine(messageId, index);
}

function setupHoldToPlay() {
    const cancel = () => {
        if (holdState) clearTimeout(holdState.timer);
        holdState = null;
    };
    document.addEventListener('pointerdown', (e) => {
        if (!getSettings().enabled || !getSettings().holdToPlay) return;
        if (e.button !== undefined && e.button !== 0) return;
        const textEl = e.target?.closest?.('#chat .mes .mes_text');
        if (!textEl || e.target.closest(`.${LINE_BTN}, a, button, input, textarea`)) return;
        cancel();
        const mesEl = textEl.closest('.mes');
        const x = e.clientX, y = e.clientY;
        holdState = {
            x, y,
            timer: setTimeout(() => {
                holdState = null;
                const point = caretAt(x, y);
                if (!point) return;
                suppressClickUntil = Date.now() + 700; // the release must not also toggle a translation
                window.getSelection?.()?.removeAllRanges?.();
                playHeldLine(mesEl, point);
            }, HOLD_MS),
        };
    }, true);
    document.addEventListener('pointermove', (e) => {
        if (holdState && Math.hypot(e.clientX - holdState.x, e.clientY - holdState.y) > HOLD_SLOP) cancel();
    }, true);
    for (const ev of ['pointerup', 'pointercancel', 'scroll', 'wheel']) document.addEventListener(ev, () => { if (holdState) cancel(); }, true);
    const swallow = (e) => {
        if (Date.now() < suppressClickUntil) {
            e.preventDefault();
            e.stopPropagation();
            if (e.type === 'click') suppressClickUntil = 0;
        }
    };
    window.addEventListener('click', swallow, true);
    window.addEventListener('contextmenu', swallow, true);
}
let linePlay = null; // { messageId, index }

function setLinePlaying(target) {
    $(`.${LINE_BTN}.vc_line_playing`).removeClass('vc_line_playing fa-circle-stop').addClass('fa-circle-play');
    linePlay = target;
    if (!target) return;
    $(`#chat .mes[mesid="${target.messageId}"] .${LINE_BTN}[data-line="${target.index}"]`)
        .addClass('vc_line_playing fa-circle-stop').removeClass('fa-circle-play');
}

function removeLineButtons(root) {
    if (!root) return;
    root.querySelectorAll(`.${LINE_BTN}`).forEach(el => el.remove());
    root.normalize();
}

function decorateMessage(messageId) {
    if (!lineButtonsOn()) return;
    const root = document.querySelector(`#chat .mes[mesid="${messageId}"] .mes_text`);
    if (!root || root.querySelector(`.${LINE_BTN}`)) return;
    const message = SillyTavern.getContext().chat?.[messageId];
    if (!message || message.is_system) return;
    const script = getStoredEntry(message)?.script;
    if (!Array.isArray(script)) return;
    // once a script exists, every line that will be voiced gets a ▶ (hollow = not made yet, made on tap)
    const tappable = new Set(buildPlayableLines(script).map(l => l.src));
    if (!script.some(l => l?.audioKey || tappable.has(l))) return;
    let cursor = 0;
    script.forEach((line, index) => {
        if (!line) return;
        let ranges = [];
        try { ranges = findLineRanges(root, messageId, line.orig ?? line.text, cursor); } catch { /* ignore */ }
        if (ranges[0]?.vcEnd) cursor = ranges[0].vcEnd;
        if (!line.audioKey && !tappable.has(line)) return;
        for (const range of ranges) {
            const btn = document.createElement('span');
            btn.className = line.audioKey ? `${LINE_BTN} fa-solid fa-circle-play` : `${LINE_BTN} vc_line_new fa-regular fa-circle-play`;
            btn.dataset.line = String(index);
            btn.title = `${line.speaker || ''} 대사 ${line.audioKey ? '듣기' : '만들어서 듣기'}`.trim();
            btn.setAttribute('role', 'button');
            const at = range.cloneRange();
            at.collapse(true);
            at.insertNode(btn);
        }
    });
    if (linePlay?.messageId === Number(messageId)) setLinePlaying(linePlay);
}

function redecorateMessage(messageId) {
    removeLineButtons(document.querySelector(`#chat .mes[mesid="${messageId}"] .mes_text`));
    decorateMessage(messageId);
    markScriptButton(messageId);
}

/** 📜 is bright when this message already has a script (for the current voice language), dim when it doesn't. */
function hasScriptFor(message) {
    const entry = getStoredEntry(message);
    if (!Array.isArray(entry?.script) || !entry.script.length) return false;
    if (entry.textHash) {
        const text = getMessageText(message);
        if (text && entry.textHash !== hashString(text)) return false; // message changed since → would be made again
    }
    return true;
}

function markScriptButton(messageId) {
    const btns = document.querySelectorAll(`#chat .mes[mesid="${messageId}"] .vc_edit_btn`);
    if (!btns.length) return;
    const message = SillyTavern.getContext().chat?.[messageId];
    const has = !!message && !message.is_system && hasScriptFor(message);
    for (const b of btns) {
        b.style.opacity = has ? '1' : '0.3';
        b.title = has ? 'MultiCast TTS 대본 편집 (대본 있음)' : 'MultiCast TTS 대본 편집 (아직 대본 없음 — 열면 분류해요)';
    }
}

let scriptMarkTimer = null;
function markAllScriptButtons() {
    clearTimeout(scriptMarkTimer);
    scriptMarkTimer = setTimeout(() => {
        document.querySelectorAll('#chat .mes').forEach(mes => markScriptButton(Number(mes.getAttribute('mesid'))));
    }, 200);
}

function refreshLineButtons({ rebuild = false } = {}) {
    document.querySelectorAll('#chat .mes').forEach((mes) => {
        const root = mes.querySelector('.mes_text');
        if (rebuild || !lineButtonsOn()) removeLineButtons(root);
        decorateMessage(Number(mes.getAttribute('mesid')));
    });
}

let lineObserverTimer = null;
function watchChatForLineButtons() {
    const chat = document.getElementById('chat');
    if (!chat || typeof MutationObserver === 'undefined') return;
    new MutationObserver(() => {
        markAllScriptButtons();
        if (!lineButtonsOn()) return;
        clearTimeout(lineObserverTimer);
        lineObserverTimer = setTimeout(() => refreshLineButtons(), 300);
    }).observe(chat, { childList: true, subtree: true });
}

let lastLine = null; // { messageId, index } — the line heard last, so ⏭/⏮ can go on from there

/** Is this script line one that gets voiced (thought/sfx settings, has a voice)? */
function isVoicedLine(script, line) {
    return buildPlayableLines(script).some(l => l.src === line);
}

/**
 * From a line, find the next/previous line to hear: same message first, then neighbouring messages
 * that already have audio. `make` = lines without audio may be made on the spot (read-along mode).
 */
function findStepTarget(from, dir, make) {
    const chat = SillyTavern.getContext().chat ?? [];
    const ok = (script, line) => line && isVoicedLine(script, line)
        && (keyHasAudio(line.audioKey) || make);
    let mesId = from.messageId;
    let start = from.index + dir;
    for (let hops = 0; hops < 200 && mesId >= 0 && mesId < chat.length; hops++) {
        const script = getStoredEntry(chat[mesId])?.script;
        if (Array.isArray(script) && !chat[mesId]?.is_system) {
            if (start === null) start = dir > 0 ? 0 : script.length - 1;
            for (let j = start; j >= 0 && j < script.length; j += dir) {
                if (ok(script, script[j])) return { messageId: mesId, index: j };
            }
        }
        // only cross into messages that already have audio
        const next = adjacentSavedMessage(mesId, dir);
        if (next === null) return null;
        mesId = next;
        start = null;
    }
    return null;
}

/** ⏮/⏭ when no whole message is playing: hear the previous/next single line. */
function stepLine(dir, { quiet = false } = {}) {
    if (!lastLine) return false;
    const target = findStepTarget(lastLine, dir, readMode() !== 'off');
    if (!target) {
        if (!quiet) toastr.info(dir > 0 ? '다음에 들을 대사가 없어요.' : '이전에 들을 대사가 없어요.', 'MultiCast TTS', { timeOut: 1500 });
        return !quiet;
    }
    if (target.messageId !== lastLine.messageId) {
        document.querySelector(`#chat .mes[mesid="${target.messageId}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
    playScriptLine(target.messageId, target.index);
    return true;
}

async function playScriptLine(messageId, index, { singleOnly = false } = {}) {
    if (linePlay && linePlay.messageId === messageId && linePlay.index === index) {
        stopPlayback();
        return;
    }
    stopPlayback();
    lastLine = { messageId, index };
    const generationAtStart = generationEpoch;
    const mySession = session;
    const ctx = SillyTavern.getContext();
    const storedScript = getStoredEntry(ctx.chat[messageId])?.script;
    if (Array.isArray(storedScript)) fixUserSpeaker(storedScript, messageId);
    const line = storedScript?.[index];
    if (!line) return;
    // show which line was picked right away (the voice may still need a few seconds to be made)
    const pickRoot = document.querySelector(`#chat .mes[mesid="${messageId}"] .mes_text`);
    highlightLine(messageId, line.orig ?? line.text, line, pickRoot ? cursorBefore(pickRoot, messageId, storedScript, index) : 0);
    if (isBlockedAdultKey(line.audioKey)) { clearHighlight(); return; }
    let url = line.audioKey ? await getCachedAudio(line.audioKey) : null;
    if (mySession !== session || generationAtStart !== generationEpoch) return;
    if (!url) {
        // read mode (or 이어 듣기 '전부'): make just this line now
        const localSfx = localSfxFor(line);
        const voiceId = pickVoice(line) || (localSfx ? 'local-sfx' : '');
        if (!voiceId) {
            toastr.warning('이 대사에 쓸 목소리가 없어요. 캐스트나 기본 목소리를 지정해 주세요.', 'MultiCast TTS');
            clearHighlight();
            return;
        }
        const $btn = $(`#chat .mes[mesid="${messageId}"] .${LINE_BTN}[data-line="${index}"]`);
        $btn.addClass('vc_line_loading fa-spinner fa-spin').removeClass('fa-circle-play');
        try {
            const made = await synthesize(buildTtsText(line), voiceId, { ...voiceSettingsFor(line), localSfx });
            line.audioKey = made.key;
            noteClipInfo(made.key, line);
            url = made.url;
            if (ctx.chat === SillyTavern.getContext().chat) ctx.saveChat();
        } catch (e) {
            console.error(LOG, e);
            toastr.error(String(e.message ?? e), 'MultiCast TTS');
        }
        redecorateMessage(messageId);
        if (!url) clearHighlight();
        if (mySession !== session || generationAtStart !== generationEpoch || !url) return;
    }
    if (!url) {
        clearHighlight();
        toastr.info('이 기기에는 이 대사 음성이 없어요. 🔊로 메시지를 재생하면 다시 만들어져요.', 'MultiCast TTS');
        return;
    }
    setLinePlaying({ messageId, index });
    apiSetPlaying(messageId);
    setNowPlaying({ messageId, line, index: null, total: null });
    const hlRoot = document.querySelector(`#chat .mes[mesid="${messageId}"] .mes_text`);
    const script = getStoredEntry(ctx.chat[messageId])?.script ?? [];
    highlightLine(messageId, line.orig ?? line.text, line, hlRoot ? cursorBefore(hlRoot, messageId, script, index) : 0);
    await playUrl(url, mySession, line);
    if (mySession === session) {
        clearHighlight();
        setLinePlaying(null);
        currentAudio = null;
        paused = false;
        setNowPlaying(null);
        apiSetIdleSoon('done');
        // 이어 듣기 (not in 한 줄씩 mode): go on line by line, across messages that have audio
        const s = getSettings();
        if (!singleOnly && s.continuePlay && !s.stepMode && !autoHolds.size && generationAtStart === generationEpoch) {
            const make = readMode() !== 'off' || s.continueMode === 'all';
            const target = findStepTarget({ messageId, index }, 1, make);
            if (target) {
                const nextLine = getStoredEntry(SillyTavern.getContext().chat[target.messageId])?.script?.[target.index];
                await sleep(target.messageId !== messageId
                    ? pauseBetweenMessages()
                    : pauseBefore(line, nextLine ?? line, 0) || 150);
                if (mySession !== session) return;
                if (target.messageId !== messageId) {
                    document.querySelector(`#chat .mes[mesid="${target.messageId}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
                }
                playScriptLine(target.messageId, target.index);
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Saved line audio of this chat, as a list
// ---------------------------------------------------------------------------

let clipPlayKey = null;

function setClipPlaying(key) {
    $('.vc_clip_play.vc_line_playing').removeClass('vc_line_playing fa-stop').addClass('fa-play');
    clipPlayKey = key;
    if (key) $(`.vc_clip_play[data-key="${key}"]`).addClass('vc_line_playing fa-stop').removeClass('fa-play');
}

function variantLabel(key) {
    if (key === 'display') return '화면';
    if (key === 'original') return '원문';
    if (String(key).startsWith('tr:')) return `번역·${String(key).slice(3)}`;
    return String(key);
}

function collectSavedLines() {
    const chat = SillyTavern.getContext().chat ?? [];
    const out = [];
    for (let mesId = chat.length - 1; mesId >= 0; mesId--) {
        const root = chat[mesId]?.extra?.[MODULE_NAME];
        if (!root) continue;
        const variants = root.variants ?? (Array.isArray(root.script) ? { display: root } : {});
        for (const [vKey, entry] of Object.entries(variants)) {
            (entry?.script ?? []).forEach((line) => {
                if (line?.audioKey && !isLocalSfxKey(line.audioKey)) out.push({ mesId, vKey, line });
            });
        }
    }
    return out;
}

async function playClip(key, line = null) {
    if (clipPlayKey === key) {
        stopPlayback();
        return;
    }
    stopPlayback();
    const mySession = session;
    const url = await getCachedAudio(key);
    if (mySession !== session) return;
    if (!url) {
        toastr.info('이 기기에는 저장된 음성이 없어요.', 'MultiCast TTS');
        return;
    }
    setClipPlaying(key);
    await playUrl(url, mySession, line);
    if (mySession === session) {
        setClipPlaying(null);
        currentAudio = null;
    }
}

async function downloadClip(item) {
    try {
        const blob = await getStore()?.getItem(item.line.audioKey);
        if (!blob) {
            toastr.info('이 기기에는 저장된 음성이 없어요.', 'MultiCast TTS');
            return;
        }
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = `${safeFileName(item.line.speaker)}_${item.mesId}_${safeFileName(item.line.text).slice(0, 20)}.mp3`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    } catch (e) {
        toastr.error(String(e.message ?? e), 'MultiCast TTS');
    }
}

/** Delete one line's audio from this device and unpin it everywhere in this chat (next play makes it again). */
async function deleteClip(key) {
    const ctx = SillyTavern.getContext();
    if (clipPlayKey === key) stopPlayback();
    try { await getStore()?.removeItem(key); } catch { /* ignore */ }
    const index = await loadIndex();
    delete index[key];
    saveIndexSoon();
    if (memoryUrls.has(key)) {
        URL.revokeObjectURL(memoryUrls.get(key));
        memoryUrls.delete(key);
    }
    const touched = new Set();
    (ctx.chat ?? []).forEach((message, mesId) => {
        const root = message?.extra?.[MODULE_NAME];
        if (!root) return;
        const variants = root.variants ?? (Array.isArray(root.script) ? { display: root } : {});
        for (const entry of Object.values(variants)) {
            for (const line of entry?.script ?? []) {
                if (line?.audioKey === key) {
                    delete line.audioKey;
                    touched.add(mesId);
                }
            }
        }
    });
    if (touched.size) await ctx.saveChat();
    touched.forEach(id => redecorateMessage(id));
}

async function openSavedList() {
    const ctx = SillyTavern.getContext();
    if (!ctx.chat?.length) return openAllVoices(); // no chat open → the list across every bot
    const items = collectSavedLines();
    const index = await loadIndex();
    const speakers = [...new Set(items.map(i => i.line.speaker || '?'))].sort();

    const $box = $(`
        <div class="vc_saved">
            <div class="vc_saved_head">
                <b>이 채팅에서 만든 대사 음성</b> <span class="vc_hint">${items.length}개</span>
                <span class="menu_button menu_button_icon vc_switch_list"><i class="fa-solid fa-folder-open"></i><span>모든 봇 보기</span></span>
            </div>
            <div class="vc_saved_filters">
                <select class="text_pole vc_saved_speaker"><option value="">모든 캐릭터</option>${speakers.map(n => `<option value="${escapeHtml(n)}">${escapeHtml(n)}</option>`).join('')}</select>
                <input class="text_pole vc_saved_search" type="search" placeholder="대사 검색" />
                <label class="checkbox_label vc_saved_favonly"><input type="checkbox" class="vc_saved_fav_only" /><span>⭐만</span></label>
            </div>
            <div class="vc_saved_list"></div>
        </div>`);
    const $list = $box.find('.vc_saved_list');

    const render = () => {
        const who = String($box.find('.vc_saved_speaker').val() ?? '');
        const q = String($box.find('.vc_saved_search').val() ?? '').trim().toLowerCase();
        const favOnly = $box.find('.vc_saved_fav_only').prop('checked');
        const shown = items.filter(i => (!who || (i.line.speaker || '?') === who)
            && (!favOnly || isFav(i.line.audioKey))
            && (!q || `${i.line.text} ${i.line.orig ?? ''}`.toLowerCase().includes(q)));
        if (!shown.length) {
            $list.html('<div class="vc_empty">저장된 대사 음성이 없어요. 메시지를 🔊로 한 번 재생하면 여기에 쌓여요.</div>');
            return;
        }
        $list.empty();
        let lastGroup = '';
        for (const item of shown) {
            const group = `${item.mesId}|${item.vKey}`;
            if (group !== lastGroup) {
                lastGroup = group;
                const name = ctx.chat[item.mesId]?.name ?? '';
                $list.append(`<div class="vc_saved_group" data-mes="${item.mesId}">#${item.mesId} ${escapeHtml(name)} <span class="vc_hint">· ${escapeHtml(variantLabel(item.vKey))}</span></div>`);
            }
            const missing = !index[item.line.audioKey];
            const $row = $(`
                <div class="vc_saved_row${missing ? ' vc_missing' : ''}">
                    <div class="vc_icon_btn vc_clip_play fa-solid fa-play" data-key="${escapeHtml(item.line.audioKey)}" title="듣기"></div>
                    <div class="vc_saved_text"><b>${escapeHtml(item.line.speaker || '?')}</b> ${escapeHtml(item.line.text)}${missing ? ' <span class="vc_hint">(이 기기에 없음)</span>' : ''}</div>
                    <div class="vc_icon_btn vc_clip_fav ${isFav(item.line.audioKey) ? 'vc_on fa-solid' : 'fa-regular'} fa-star" title="즐겨찾기 (시간이 지나도 안 지워져요)"></div>
                    <div class="vc_icon_btn vc_clip_dl fa-solid fa-download" title="mp3로 받기"></div>
                    <div class="vc_icon_btn vc_clip_del fa-solid fa-trash-can" title="이 음성 지우기"></div>
                </div>`);
            $row.find('.vc_clip_fav').on('click', async function () {
                const on = !isFav(item.line.audioKey);
                if (!(await setFav(item.line.audioKey, on, item.line))) return;
                $(this).toggleClass('vc_on fa-solid', on).toggleClass('fa-regular', !on);
                toastr.info(on ? '⭐ 즐겨찾기했어요. 시간이 지나도 안 지워져요.' : '즐겨찾기를 해제했어요.', 'MultiCast TTS', { timeOut: 1500 });
            });
            $row.find('.vc_clip_play').on('click', () => playClip(item.line.audioKey, item.line));
            $row.find('.vc_clip_dl').on('click', () => downloadClip(item));
            $row.find('.vc_clip_del').on('click', async () => {
                const ok = await ctx.Popup.show.confirm('MultiCast TTS', `${isFav(item.line.audioKey) ? '⭐ 즐겨찾기한 음성이에요. ' : ''}이 대사 음성을 지울까요? 다음에 메시지를 재생하면 새로 만들어져요(크레딧 사용).`);
                if (!ok) return;
                const key = item.line.audioKey;
                await deleteClip(key);
                for (let i = items.length - 1; i >= 0; i--) {
                    if (!items[i].line.audioKey || items[i].line.audioKey === key) items.splice(i, 1);
                }
                $box.find('.vc_saved_head .vc_hint').text(`${items.length}개`);
                render();
                toastr.success('지웠어요.', 'MultiCast TTS', { timeOut: 1200 });
            });
            $list.append($row);
        }
        if (clipPlayKey) setClipPlaying(clipPlayKey);
    };
    $box.find('.vc_saved_speaker').on('change', render);
    $box.find('.vc_saved_search').on('input', render);
    $box.find('.vc_saved_fav_only').on('change', render);
    let switchTo = null;
    $list.on('click', '.vc_saved_group', function () {
        const el = document.querySelector(`#chat .mes[mesid="${$(this).data('mes')}"]`);
        if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        else toastr.info('채팅을 위로 스크롤해서 그 메시지를 불러와 주세요.', 'MultiCast TTS');
    });
    render();

    const popup = new ctx.Popup($box, ctx.POPUP_TYPE.TEXT, '', {
        okButton: '닫기',
        wide: true,
        allowVerticalScrolling: true,
        leftAlign: true,
    });
    popup.dlg?.classList.add('vc_editor_popup');
    $box.find('.vc_switch_list').on('click', () => { switchTo = 'all'; popup.completeCancelled?.(); });
    await popup.show();
    if (clipPlayKey) stopPlayback();
    if (switchTo === 'all') setTimeout(() => openAllVoices(), 50);
}

// ---------------------------------------------------------------------------
// Bottom mini player — a little handle above the input; swipe it up (or tap) to open
// ---------------------------------------------------------------------------

/** Character color: the cast row's highlight color, else a soft pastel picked from the name. */
function characterColor(name) {
    const entry = name ? findCastEntry(name) : null;
    if (/^#[0-9a-f]{6}$/i.test(entry?.color ?? '')) return entry.color;
    let h = 0;
    for (const ch of String(name ?? '?')) h = (h * 31 + ch.charCodeAt(0)) % 360;
    return `hsl(${h}, 70%, 72%)`;
}

let playerOpen = true;

/** The player lives in the page flow right above the input bar (re-docks if ST rebuilt it). */
function placePlayer() {
    const el = document.getElementById('vc_player');
    const form = document.getElementById('send_form');
    if (el && form && el.nextElementSibling !== form) form.parentElement?.insertBefore(el, form);
    // the player floats above the input bar, so its container must be the positioning box
    const box = el?.parentElement;
    if (box && box !== document.body && getComputedStyle(box).position === 'static') box.style.position = 'relative';
}

function setPlayerOpen(open) {
    playerOpen = !!open;
    placePlayer();
    $('#vc_player').attr('data-open', playerOpen ? '1' : '0');
}

function buildPlayer() {
    if (document.getElementById('vc_player')) return;
    const $p = $(`
        <div id="vc_player" class="vc_player" data-open="1" data-state="idle">
            <div class="vc_player_handle" title="MultiCast 플레이어 (위로 밀거나 눌러서 열기)">
                <span class="vc_handle_bar"></span>
                <span class="vc_eq vc_handle_eq"><i></i><i></i><i></i></span>
            </div>
            <div class="vc_player_card">
                <span class="vc_player_avatar"></span>
                <span class="vc_eq vc_player_eq"><i></i><i></i><i></i></span>
                <span class="vc_player_pos"></span>
                <div class="vc_player_btns">
                    <div class="vc_pbtn" data-act="prev" title="이전 대사"><i class="fa-solid fa-backward-step"></i></div>
                    <div class="vc_pbtn vc_pbtn_main" data-act="toggle" title="재생 / 일시정지"><i class="fa-solid fa-play"></i></div>
                    <div class="vc_pbtn" data-act="next" title="다음 대사"><i class="fa-solid fa-forward-step"></i></div>
                    <div class="vc_pbtn" data-act="stop" title="정지"><i class="fa-solid fa-stop"></i></div>
                    <div class="vc_pbtn vc_pbtn_step" data-act="step" title="한 줄씩 듣기 (⏭ 누를 때마다 한 대사)">1</div>
                </div>
            </div>
        </div>`);
    const form = document.getElementById('send_form');
    if (form?.parentElement) form.parentElement.insertBefore($p[0], form);
    else $('body').append($p);
    placePlayer();

    $p.on('click', '.vc_player_handle', () => setPlayerOpen(!playerOpen));
    // pointerdown instead of click → reacts the moment the finger touches
    $p.on('pointerdown', '.vc_pbtn', function (e) {
        e.preventDefault();
        const act = $(this).data('act');
        if (act === 'toggle') togglePause();
        else if (act === 'stop') stopPlayback();
        else if (act === 'step') {
            getSettings().stepMode = !getSettings().stepMode;
            save();
            $('#voice_cast_step').prop('checked', getSettings().stepMode);
            toastr.info(getSettings().stepMode ? '한 줄씩 듣기: ⏭ 누를 때마다 한 대사씩' : '한 줄씩 듣기 끔', 'MultiCast TTS', { timeOut: 1500 });
            updatePlayer();
        }
        else if (act === 'prev') skipLine(-1);
        else if (act === 'next') skipLine(1);
    });

    // swipe: up on the handle opens, down on the card closes
    let startY = null;
    const el = $p[0];
    el.addEventListener('touchstart', (e) => { startY = e.touches[0].clientY; }, { passive: true });
    el.addEventListener('touchmove', (e) => {
        if (startY === null) return;
        const dy = e.touches[0].clientY - startY;
        if (!playerOpen && dy < -25) { setPlayerOpen(true); startY = null; }
        else if (playerOpen && dy > 35) { setPlayerOpen(false); startY = null; }
    }, { passive: true });
    el.addEventListener('touchend', () => { startY = null; }, { passive: true });

    window.addEventListener('resize', placePlayer);
    $p.find('.vc_player_handle').attr('title', 'MultiCast 플레이어 (위로 밀거나 눌러서 열기)');
    applyPlayerSetting();
}

function applyPlayerSetting() {
    const on = !!getSettings().player && !!getSettings().enabled;
    $('#vc_player').toggle(on);
    if (on) placePlayer();
    updatePlayer();
}

function updatePlayer() {
    const $p = $('#vc_player');
    if (!$p.length) return;
    const busy = !!nowPlaying;
    $p.attr('data-state', !busy ? 'idle' : paused ? 'paused' : 'playing');
    const line = nowPlaying?.line;
    const isSfx = line?.type === 'sfx';
    const name = !busy ? 'MultiCast' : isSfx ? '효과음' : (line?.speaker || '?');
    const color = !busy ? 'hsl(36, 85%, 70%)' : characterColor(isSfx ? 'SFX' : line?.speaker);
    $p[0].style.setProperty('--vc-c', color);
    $p.find('.vc_player_avatar').text(isSfx ? '🔔' : [...name][0]?.toUpperCase() ?? '?').attr('title', name);
    $p.find('.vc_player_pos').text(busy && nowPlaying.total ? `${nowPlaying.index + 1}/${nowPlaying.total}` : '');
    $p.find('.vc_player_card').attr('title', busy ? `${name}${line?.type === 'thought' ? ' (속마음)' : ''}${paused ? ' · 일시정지' : ''}` : '대기 중 · ⏯ 누르면 마지막 메시지 재생');
    $p.find('.vc_pbtn_step').toggleClass('vc_on', !!getSettings().stepMode);
    $p.find('.vc_pbtn_main i').attr('class', `fa-solid ${busy && !paused ? 'fa-pause' : 'fa-play'}`);
}

// ---------------------------------------------------------------------------
// Save a whole message as one mp3
// ---------------------------------------------------------------------------

function safeFileName(str) {
    return String(str ?? '').replace(/[\\/:*?"<>|\s]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40) || 'voice';
}

/**
 * Render a message the way it plays: breathing pauses, sound effects layered under the voices
 * (겹쳐 재생), 🔁 sounds looping until the message ends (max 3, softer when stacked), cast volumes.
 * Returns { blob (wav), seconds, count } or null when the browser can't do it.
 */
async function mixMessageAudio(lines, urls, messageId) {
    const OAC = globalThis.OfflineAudioContext || globalThis.webkitOfflineAudioContext;
    if (!OAC) return null;
    const SR = 44100;
    const decoder = new OAC(1, SR, SR);
    const bufs = [];
    for (const url of urls) {
        if (!url) { bufs.push(null); continue; }
        try {
            bufs.push(await decoder.decodeAudioData(await (await fetch(url)).arrayBuffer()));
        } catch (e) {
            console.warn(LOG, 'mixdown: could not decode a line', e);
            bufs.push(null);
        }
    }
    if (!bufs.some(Boolean)) return null;

    const root = messageId !== null ? document.querySelector(`#chat .mes[mesid="${messageId}"] .mes_text`) : null;
    const s = getSettings();
    const voices = [];  // { buf, at, gain }
    const beds = [];    // { buf, start, end, base, key }
    let t = 0.05;
    let prev = null;
    let cursor = 0;
    let count = 0;
    let rateIgnored = (Number(s.rate) || 1) !== 1;
    for (let i = 0; i < lines.length; i++) {
        const buf = bufs[i];
        if (!buf) continue;
        const src = lines[i].src;
        count++;
        if (src.type === 'sfx' && isLoopSfxKey(src.audioKey)) {
            const key = src.audioKey;
            if (beds.some(b => b.key === key && b.end === null)) continue; // same loop already going
            const live = beds.filter(b => b.end === null);
            if (live.length >= BED_MAX) { live[0].end = t; live[0].fade = 0.8; }
            beds.push({ buf, start: t, end: null, base: castVolumeFor(src) * 0.3, key });
            continue;
        }
        if (src.type === 'sfx' && s.sfxOverlay) {
            voices.push({ buf, at: t, gain: castVolumeFor(src) * 0.85 });
            continue;
        }
        const text = src.orig ?? src.text;
        let range = null;
        if (root) {
            try { range = findLineRanges(root, messageId, text, cursor)[0] ?? null; } catch { range = null; }
        }
        if (prev && pacingProfile()) {
            const narr = range?.vcStart !== undefined && range.vcStart >= cursor ? range.vcStart - cursor : 0;
            t += pauseBefore(prev, src, narr) / 1000;
        }
        if (range?.vcEnd) cursor = range.vcEnd;
        const own = Number(findCastEntry(src.speaker)?.rate);
        if (own > 0 && own !== 1) rateIgnored = true;
        voices.push({ buf, at: t, gain: castVolumeFor(src) });
        t += buf.duration;
        prev = src;
    }
    const end = t;
    for (const b of beds) {
        if (b.end === null) { b.end = end; b.fade = 1.8; }
    }
    const tail = Math.max(end, ...voices.map(v => v.at + v.buf.duration), ...beds.map(b => b.end + b.fade));
    const ctx = new OAC(1, Math.ceil((tail + 0.2) * SR), SR);
    for (const v of voices) {
        const node = ctx.createBufferSource();
        node.buffer = v.buf;
        const g = ctx.createGain();
        g.gain.value = v.gain;
        node.connect(g).connect(ctx.destination);
        node.start(v.at);
    }
    // loops: fade in, re-balance whenever another loop starts or stops, fade out at the end
    const points = [...new Set(beds.flatMap(b => [b.start, b.end]))].sort((a, b) => a - b);
    for (const b of beds) {
        const node = ctx.createBufferSource();
        node.buffer = b.buf;
        node.loop = true;
        const g = ctx.createGain();
        g.gain.setValueAtTime(0, b.start);
        for (const p of points) {
            if (p < b.start || p >= b.end) continue;
            const n = beds.filter(o => o.start <= p && o.end > p).length;
            g.gain.setTargetAtTime(b.base * (BED_GAIN[Math.min(n, BED_GAIN.length) - 1] ?? 0.65), p, 0.12);
        }
        g.gain.setTargetAtTime(0, b.end, b.fade / 4);
        node.connect(g).connect(ctx.destination);
        node.start(b.start);
        node.stop(b.end + b.fade + 0.1);
    }
    const out = await ctx.startRendering();
    return { blob: encodeWavMono(out.getChannelData(0), SR), seconds: out.duration, count, rateIgnored };
}

/** 16-bit mono WAV; scales down only if the mix would clip. */
function encodeWavMono(data, sampleRate) {
    let peak = 0;
    for (let i = 0; i < data.length; i++) { const a = Math.abs(data[i]); if (a > peak) peak = a; }
    const k = peak > 0.98 ? 0.98 / peak : 1;
    const buf = new ArrayBuffer(44 + data.length * 2);
    const v = new DataView(buf);
    const str = (o, x) => { for (let i = 0; i < x.length; i++) v.setUint8(o + i, x.charCodeAt(i)); };
    str(0, 'RIFF'); v.setUint32(4, 36 + data.length * 2, true); str(8, 'WAVE');
    str(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
    v.setUint32(24, sampleRate, true); v.setUint32(28, sampleRate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
    str(36, 'data'); v.setUint32(40, data.length * 2, true);
    for (let i = 0; i < data.length; i++) {
        const x = Math.max(-1, Math.min(1, data[i] * k));
        v.setInt16(44 + i * 2, x < 0 ? x * 0x8000 : x * 0x7fff, true);
    }
    return new Blob([buf], { type: 'audio/wav' });
}

/** Ask which kind of file: plain mp3 (lines joined) or 들리는 그대로 (wav mix). Returns 'mp3' | 'wav' | null. */
async function chooseDownloadKind() {
    const ctx = SillyTavern.getContext();
    const html = `
        <div style="text-align:left">
            <h3 style="margin-top:0">어떤 파일로 받을까요?</h3>
            <p><b>🎵 mp3로 받기</b><br><span class="vc_hint">대사 음성만 순서대로 이어 붙여요. 파일이 작아서(1분에 1MB쯤) 게시판·커뮤니티에 올리기 좋아요. 대사 사이 쉼은 없고, 효과음은 겹치지 않고 차례로 한 번씩 들어가요.</span></p>
            <p><b>🎧 들리는 그대로 받기 (wav)</b><br><span class="vc_hint">재생할 때랑 똑같이 쉼·겹친 효과음·🔁 반복·캐스트 볼륨까지 섞어요. 파일이 커서(1분에 5MB쯤) mp3만 받는 사이트엔 못 올릴 수 있어요. 말하기 속도 설정은 반영되지 않아요.</span></p>
        </div>`;
    const MP3 = 2;
    const popup = new ctx.Popup(html, ctx.POPUP_TYPE.TEXT, '', {
        okButton: '🎧 들리는 그대로 (wav)',
        cancelButton: '취소',
        customButtons: [{ text: '🎵 mp3로 받기', result: MP3 }],
    });
    const r = await popup.show();
    if (r === MP3) return 'mp3';
    if (r === ctx.POPUP_RESULT?.AFFIRMATIVE || r === 1) return 'wav';
    return null;
}

async function downloadMessageAudio(messageId, scriptOverride = null, { kind = 'mp3' } = {}) {
    const generationAtStart = generationEpoch;
    const ctx = SillyTavern.getContext();
    const message = ctx.chat[messageId];
    if (!message) return;
    try {
        const script = scriptOverride ?? await getScript(messageId);
        if (generationAtStart !== generationEpoch) return;
        const lines = buildPlayableLines(script, { keepThoughts: !!scriptOverride });
        if (!lines.length) {
            toastr.info('저장할 대사가 없어요.', 'MultiCast TTS');
            return;
        }
        const total = lines.length;
        toastr.info(`음성 ${total}줄을 준비하고 있어요…`, 'MultiCast TTS', { timeOut: 2000 });
        const { promises, done } = synthesizeAll(
            lines.map(l => ({ text: l.ttsText, voiceId: l.voiceId, src: l.src })),
            session,
        );
        if (!scriptOverride) savePinsWhenDone(done, messageId);
        const urls = await Promise.all(promises);
        if (generationAtStart !== generationEpoch) return;
        // 들리는 그대로: mix pauses, overlapping / 🔁 looping sound effects and volumes into one file
        let mixed = null;
        try {
            if (kind === 'wav') mixed = await mixMessageAudio(lines, urls, messageId);
        } catch (e) {
            console.warn(LOG, 'mixdown failed, saving the plain joined file instead', e);
        }
        if (mixed) {
            const a = document.createElement('a');
            a.href = URL.createObjectURL(mixed.blob);
            a.download = `${safeFileName(message.name)}_${messageId}.wav`;
            document.body.append(a);
            a.click();
            a.remove();
            setTimeout(() => URL.revokeObjectURL(a.href), 10000);
            toastr.success(`들리는 그대로 저장했어요 (${mixed.count}/${total}줄, ${Math.round(mixed.seconds)}초).${mixed.rateIgnored ? ' 말하기 속도 설정은 파일에 반영되지 않아요.' : ''}`, 'MultiCast TTS');
            return;
        }
        const parts = [];
        for (const url of urls) {
            if (!url) continue;
            parts.push(await (await fetch(url)).arrayBuffer());
        }
        if (!parts.length) {
            toastr.error('음성을 만들지 못했어요.', 'MultiCast TTS');
            return;
        }
        // ElevenLabs returns MP3 frames with identical settings, so plain concatenation plays back fine
        const blob = new Blob(parts, { type: 'audio/mpeg' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = `${safeFileName(message.name)}_${messageId}.mp3`;
        document.body.append(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(a.href), 10000);
        toastr.success(`mp3로 저장했어요 (${parts.length}/${total}줄).`, 'MultiCast TTS');
    } catch (e) {
        console.error(LOG, e);
        toastr.error(String(e.message ?? e), 'MultiCast TTS');
    }
}

// ---------------------------------------------------------------------------
// Message buttons
// ---------------------------------------------------------------------------

const BUTTON_HTML = '<div class="mes_button vc_play_btn fa-solid fa-volume-high" title="MultiCast TTS 재생 (Shift+클릭: 다시 분류)"></div>'
    + '<div class="mes_button vc_edit_btn fa-solid fa-scroll" title="MultiCast TTS 대본 편집"></div>';

const QUICK_HTML = `<div class="vc_quick_btns">${BUTTON_HTML}</div>`;

/** "Buttons on the message" option: CSS swaps which copy is visible (… menu or the message itself). */
function applyQuickButtons() {
    document.body.classList.toggle('vc_quick_on', !!getSettings().quickButtons);
}

function injectButtons() {
    // Template: every newly rendered message gets the buttons automatically
    const $tpl = $('#message_template .extraMesButtons');
    if ($tpl.length && !$tpl.find('.vc_play_btn').length) {
        $tpl.prepend(BUTTON_HTML);
    }
    const $tplHint = $('#message_template .mes_buttons .extraMesButtonsHint');
    if ($tplHint.length && !$('#message_template .vc_quick_btns').length) {
        $tplHint.before(QUICK_HTML);
    }
    // Already-rendered messages
    $('#chat .mes .extraMesButtons').each(function () {
        if (!$(this).find('.vc_play_btn').length) $(this).prepend(BUTTON_HTML);
    });
    $('#chat .mes .mes_buttons').each(function () {
        if ($(this).find('.vc_quick_btns').length) return;
        const $hint = $(this).find('.extraMesButtonsHint');
        if ($hint.length) $hint.before(QUICK_HTML);
    });
}

function onEditButtonClick(e) {
    e.preventDefault();
    e.stopPropagation();
    const messageId = Number($(this).closest('.mes').attr('mesid'));
    if (Number.isNaN(messageId)) return;
    openScriptEditor(messageId);
}

function onButtonClick(e) {
    e.preventDefault();
    e.stopPropagation();
    const messageId = Number($(this).closest('.mes').attr('mesid'));
    if (Number.isNaN(messageId)) return;

    if (playingMessageId === messageId && !e.shiftKey) {
        stopPlayback();
        return;
    }
    if (e.shiftKey) {
        reclassifyAndPlay(messageId);
        return;
    }
    if (readMode() !== 'off' && !isPrepared(messageId)) {
        prepareMessage(messageId);
        return;
    }
    playMessage(messageId);
}

/** Read mode: has this message been made ready (script, and in 'all' mode every line's audio)? */
function isPrepared(messageId) {
    const script = getStoredEntry(SillyTavern.getContext().chat[messageId])?.script;
    if (!Array.isArray(script)) return false;
    if (readMode() === 'tap') return true;
    return buildPlayableLines(script).every(l => l.src.audioKey);
}

/** Read mode: get the message ready for reading along — no editor, no playback, just ▶ next to the lines. */
async function prepareMessage(messageId) {
    const token = generationEpoch;
    if (readMode() === 'all') return preloadMessage(messageId, { readAlong: true });
    const show = (html, state) => { if (playingMessageId !== messageId) setStatus(messageId, html, state); };
    try {
        show('<i class="fa-solid fa-spinner fa-spin"></i> 대사 분류 중…');
        await getScript(messageId);
        if (token !== generationEpoch) return show('생성 대기열 중지됨', 'done');
        redecorateMessage(messageId);
        show('<i class="fa-solid fa-circle-play"></i> 준비됨 · 대사 ▶를 눌러 들어요', 'done');
    } catch (e) {
        console.error(LOG, 'prepare failed', e);
        show('<i class="fa-solid fa-triangle-exclamation"></i> 분류 실패', 'error');
    }
}

async function reclassifyAndPlay(messageId) {
    const ctx = SillyTavern.getContext();
    const cached = getStoredEntry(ctx.chat[messageId]);
    if (cached?.edited) {
        const ok = await ctx.Popup.show.confirm('MultiCast TTS', '직접 고친 대본이 있어요. 다시 분류하면 수정한 내용이 사라져요. 계속할까요?');
        if (!ok) return;
    }
    playMessage(messageId, { force: true });
}

// ---------------------------------------------------------------------------
// Auto play
// ---------------------------------------------------------------------------

/** A script that costs nothing (no AI call): 1인 모드, or voice tags the RP model already wrote. */
function prepareFreeScript(messageId) {
    const s = getSettings();
    const message = SillyTavern.getContext().chat?.[messageId];
    if (!message || message.is_user || message.is_system || s.voiceLang === 'translate') return;
    const free = soloOn() || (s.inlineTags && alignVoiceTags(message, getMessageText(message))?.missing.length === 0);
    if (free) getScript(messageId).catch(e => console.debug(LOG, 'free script failed', e));
}

async function onCharacterMessageRendered(messageId, type) {
    hideVoiceTagText(document.querySelector(`#chat .mes[mesid="${messageId}"] .mes_text`));
    const token = generationEpoch;
    if (generationPaused) return;
    const s = getSettings();
    // free scripts (1인 모드 · the model's own voice tags) are made on arrival so the ▶ buttons are there to tap
    if (s.enabled && type !== 'first_message') prepareFreeScript(messageId);
    if (!s.enabled || (!s.autoPlay && !s.pregenerate && readMode() === 'off')) return;
    if (type === 'first_message') return;

    const ctx = SillyTavern.getContext();
    const message = ctx.chat[messageId];
    if (!message || message.is_user || message.is_system) return;

    const waitSec = Number(s.translationWaitSec) || 0;
    if (s.voiceLang === 'display' && waitSec > 0) {
        const until = Date.now() + waitSec * 1000;
        while (Date.now() < until && !getShownTranslation(ctx.chat[messageId])) {
            await new Promise(r => setTimeout(r, 300));
        }
    }
    // the chat might have changed while waiting
    if (SillyTavern.getContext().chat[messageId] !== message || token !== generationEpoch || generationPaused) return;
    if (readMode() !== 'off') prepareMessage(messageId);
    else if (s.autoPlay && !autoHolds.size) playMessage(messageId);
    else preloadMessage(messageId); // auto play on hold (another extension asked, e.g. during a call) → just get it ready
}

/** Classify + generate a message's audio in the background without playing it. */
async function preloadMessage(messageId, { readAlong = false } = {}) {
    const token = generationEpoch;
    const chatAtStart = SillyTavern.getContext().chat;
    const isActive = () => token === generationEpoch && !generationPaused && getSettings().enabled && SillyTavern.getContext().chat === chatAtStart
        && (readAlong ? readMode() === 'all' : getSettings().pregenerate);
    const show = (html, state) => { if (playingMessageId !== messageId) setStatus(messageId, html, state); };
    try {
        show('<i class="fa-solid fa-spinner fa-spin"></i> 미리 분류 중…');
        const script = await getScript(messageId);
        if (!isActive()) return show(null);
        const lines = buildPlayableLines(script);
        if (!lines.length) return show(null);
        const total = lines.length;
        show(`<i class="fa-solid fa-spinner fa-spin"></i> 미리 만드는 중 0/${total}`);
        const { done } = synthesizeAll(
            lines.map(l => ({ text: l.ttsText, voiceId: l.voiceId, src: l.src })),
            isActive,
            (n) => {
                show(`<i class="fa-solid fa-spinner fa-spin"></i> ${readAlong ? '음성 만드는 중' : '미리 만드는 중'} ${n}/${total}`);
                redecorateMessage(messageId); // ▶ shows up as soon as each line is ready
            },
        );
        savePinsWhenDone(done, messageId);
        await done;
        if (isActive()) show(readAlong ? '<i class="fa-solid fa-circle-play"></i> 준비됨 · 대사 ▶를 눌러 들어요' : '<i class="fa-solid fa-check"></i> 준비됨', 'done');
        else show(null);
    } catch (e) {
        console.error(LOG, 'preload failed', e);
        show('<i class="fa-solid fa-triangle-exclamation"></i> 미리 만들기 실패', 'error');
    }
}

// ---------------------------------------------------------------------------
// Settings UI
// ---------------------------------------------------------------------------

let voiceList = [];

function voiceOptionsHtml(selected) {
    const opts = ['<option value="">(없음)</option>'];
    for (const v of voiceList) {
        const g = (v.gender ? ` · ${v.gender}` : '') + (v.category ? ` · ${v.category}` : '');
        opts.push(`<option value="${v.id}"${v.id === selected ? ' selected' : ''}>${escapeHtml(v.name)}${g}</option>`);
    }
    if (selected && !voiceList.some(v => v.id === selected)) {
        opts.push(`<option value="${selected}" selected>(저장된 ID: ${selected.slice(0, 8)}…)</option>`);
    }
    return opts.join('');
}

function escapeHtml(str) {
    return String(str ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '\'': '&#39;' }[c]));
}

// --- Voice sample preview (ElevenLabs' own sample clip — free, no credits) ---

let previewAudio = null;
let previewBtn = null;

function stopPreview() {
    previewAudio?.pause();
    previewAudio = null;
    $(previewBtn).removeClass('fa-circle-stop vc_previewing').addClass('fa-circle-play');
    previewBtn = null;
}

async function playVoicePreview(voiceId, btn) {
    if (previewBtn === btn) { stopPreview(); return; }
    stopPreview();
    if (!voiceId) {
        toastr.info('먼저 목소리를 골라주세요.', 'MultiCast TTS', { timeOut: 1500 });
        return;
    }
    if (!voiceList.length) await loadVoices(false).catch(() => {});
    const v = voiceList.find(x => x.id === voiceId);
    if (!v?.preview) {
        toastr.info('이 목소리는 일레븐랩스에 샘플이 없어요.', 'MultiCast TTS', { timeOut: 2000 });
        return;
    }
    const audio = new Audio(v.preview);
    const master = Number(getSettings().volume);
    audio.volume = Math.min(1, Number.isNaN(master) ? 1 : Math.max(0, master));
    previewAudio = audio;
    previewBtn = btn;
    $(btn).addClass('fa-circle-stop vc_previewing').removeClass('fa-circle-play');
    audio.onended = () => { if (previewAudio === audio) stopPreview(); };
    audio.onerror = () => { if (previewAudio === audio) { stopPreview(); toastr.warning('샘플을 재생하지 못했어요.', 'MultiCast TTS'); } };
    audio.play().catch(() => { if (previewAudio === audio) stopPreview(); });
}

/** A small ▶ that plays the sample of whatever voice `getId()` returns. */
function previewButton(getId) {
    const $b = $('<div class="vc_voice_prev fa-solid fa-circle-play" title="목소리 샘플 듣기 (크레딧 안 씀)"></div>');
    $b.on('click', function (e) {
        e.preventDefault();
        e.stopPropagation();
        playVoicePreview(getId(), this);
    });
    return $b;
}

/** The one 🎧 sample row under "목소리 목록 불러오기": pick any voice and hear its sample. */
function addDefaultPreviewButtons() {
    const $sel = $('#voice_cast_preview_voice');
    if (!$sel.length || $sel.next('.vc_voice_prev').length) return;
    $sel.after(previewButton(() => String($sel.val() ?? '')));
    $sel.on('change', () => {
        // picking another voice while one plays → play the new one right away
        if (previewBtn) playVoicePreview(String($sel.val() ?? ''), $sel.next('.vc_voice_prev')[0]);
    });
}

// ---------------------------------------------------------------------------
// 내 효과음 (user sound files)
const CUSTOM_SFX_MAX_MB = 5;

function renderCustomSfxList() {
    const list = getSettings().customSfx ?? [];
    const $list = $('#voice_cast_custom_sfx_list').empty();
    if (!list.length) {
        $list.append('<div class="vc_hint vc_sub">아직 없어요.</div>');
        return;
    }
    for (const c of list) {
        const $row = $(`
            <div class="vc_custom_sfx_row" data-id="${escapeHtml(c.id)}">
                <div class="vc_icon_btn vc_custom_sfx_play fa-solid fa-play" title="들어보기"></div>
                <input class="text_pole vc_custom_sfx_name" type="text" placeholder="이름" />
                <input class="text_pole vc_custom_sfx_words" type="text" placeholder="영어 단어 (쉼표로)" />
                <div class="vc_icon_btn vc_custom_sfx_adult" title="🔞 성인 소리 (🔞 성인 효과음을 켰을 때만 나와요)" style="font-size:0.9em;opacity:${c.adult ? 1 : 0.3};filter:${c.adult ? 'none' : 'grayscale(1)'}">🔞</div>
                <div class="vc_icon_btn vc_custom_sfx_loop" title="🔁 반복: 켜면 이 소리는 그 메시지 대사가 끝날 때까지 작게 반복돼요" style="font-size:0.9em;opacity:${c.loop ? 1 : 0.3};filter:${c.loop ? 'none' : 'grayscale(1)'}">🔁</div>
                <div class="vc_icon_btn vc_custom_sfx_del fa-solid fa-trash-can" title="지우기"></div>
            </div>`);
        $row.find('.vc_custom_sfx_name').val(c.name ?? '');
        $row.find('.vc_custom_sfx_words').val(c.words ?? '');
        $list.append($row);
    }
}

function bindCustomSfxUI() {
    const s = getSettings();
    if (!Array.isArray(s.customSfx)) s.customSfx = [];
    renderCustomSfxList();
    $('#voice_cast_custom_sfx_add').on('click', () => $('#voice_cast_custom_sfx_file').trigger('click'));
    $('#voice_cast_custom_sfx_file').on('change', async function () {
        const files = [...(this.files ?? [])];
        this.value = '';
        const st = getCustomSfxStore();
        if (!st) {
            toastr.error('이 브라우저에서는 파일을 저장할 수 없어요.', 'MultiCast TTS');
            return;
        }
        let added = 0;
        for (const file of files) {
            if (file.size > CUSTOM_SFX_MAX_MB * 1024 * 1024) {
                toastr.warning(`${file.name}: ${CUSTOM_SFX_MAX_MB}MB보다 커서 건너뛰었어요. 짧은 소리만 넣어주세요.`, 'MultiCast TTS');
                continue;
            }
            const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
            try {
                await st.setItem(id, file);
            } catch (e) {
                console.warn(LOG, e);
                toastr.error(`${file.name}: 저장하지 못했어요.`, 'MultiCast TTS');
                continue;
            }
            const base = file.name.replace(/\.[^.]+$/, '');
            const words = base.toLowerCase().replace(/[^a-z]+/g, ' ').trim();
            s.customSfx.push({ id, name: base, words });
            added++;
        }
        if (added) {
            save();
            renderCustomSfxList();
            toastr.success(`내 효과음 ${added}개를 추가했어요. 영어 단어를 확인해 주세요.`, 'MultiCast TTS');
        }
    });
    $('#voice_cast_custom_sfx_export').on('click', exportSfxPack);
    $('#voice_cast_custom_sfx_import').on('click', () => $('#voice_cast_custom_sfx_pack').trigger('click'));
    $('#voice_cast_custom_sfx_pack').on('change', async function () {
        const file = this.files?.[0];
        this.value = '';
        if (file) await importSfxPack(file);
    });
    $('#voice_cast_custom_sfx_list')
        .on('input change', '.vc_custom_sfx_name, .vc_custom_sfx_words', function () {
            const id = $(this).closest('.vc_custom_sfx_row').data('id');
            const c = s.customSfx.find(x => String(x.id) === String(id));
            if (!c) return;
            if ($(this).hasClass('vc_custom_sfx_name')) c.name = String($(this).val());
            else c.words = String($(this).val());
            save();
            if (!$(this).hasClass('vc_custom_sfx_name')) setTimeout(updateInlinePrompt, 0);
        })
        .on('click', '.vc_custom_sfx_adult', function () {
            const id = $(this).closest('.vc_custom_sfx_row').data('id');
            const c = s.customSfx.find(x => String(x.id) === String(id));
            if (!c) return;
            c.adult = !c.adult;
            save();
            $(this).css({ opacity: c.adult ? 1 : 0.3, filter: c.adult ? 'none' : 'grayscale(1)' });
            setTimeout(updateInlinePrompt, 0);
        })
        .on('click', '.vc_custom_sfx_loop', function () {
            const id = $(this).closest('.vc_custom_sfx_row').data('id');
            const c = s.customSfx.find(x => String(x.id) === String(id));
            if (!c) return;
            c.loop = !c.loop;
            save();
            $(this).css({ opacity: c.loop ? 1 : 0.3, filter: c.loop ? 'none' : 'grayscale(1)' });
        })
        .on('click', '.vc_custom_sfx_play', async function () {
            const id = $(this).closest('.vc_custom_sfx_row').data('id');
            const url = await getCachedAudio(SFX_KEY_PREFIX + CUSTOM_SFX_PREFIX + id, { preview: true });
            if (!url) {
                toastr.warning('파일을 찾을 수 없어요. 지우고 다시 추가해 주세요.', 'MultiCast TTS');
                return;
            }
            const audio = new Audio(url);
            const master = Number(getSettings().volume);
            audio.volume = Math.min(1, Number.isNaN(master) ? 1 : Math.max(0, master));
            audio.play().catch(() => {});
        })
        .on('click', '.vc_custom_sfx_del', async function () {
            const id = String($(this).closest('.vc_custom_sfx_row').data('id'));
            s.customSfx = s.customSfx.filter(x => String(x.id) !== id);
            save();
            await getCustomSfxStore()?.removeItem(id).catch(() => {});
            const key = SFX_KEY_PREFIX + CUSTOM_SFX_PREFIX + id;
            if (memoryUrls.has(key)) {
                URL.revokeObjectURL(memoryUrls.get(key));
                memoryUrls.delete(key);
            }
            renderCustomSfxList();
        });
}

// 효과음 팩: all of 내 효과음 (sound + words + 🔞) in one .json file, to carry to another device
const SFX_PACK_FORMAT = 'multicast-tts-sfx-pack';

function blobToDataUrl(blob) {
    return new Promise((resolve, reject) => {
        const r = new FileReader();
        r.onload = () => resolve(String(r.result));
        r.onerror = () => reject(r.error);
        r.readAsDataURL(blob);
    });
}

function dataUrlToBlob(dataUrl) {
    const m = /^data:([^;,]*)(;base64)?,(.*)$/s.exec(String(dataUrl ?? ''));
    if (!m) return null;
    const type = m[1] || 'audio/mpeg';
    if (!m[2]) return new Blob([decodeURIComponent(m[3])], { type });
    const bin = atob(m[3]);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new Blob([bytes], { type });
}

async function exportSfxPack() {
    const list = getSettings().customSfx ?? [];
    const st = getCustomSfxStore();
    if (!list.length || !st) {
        toastr.info('내보낼 내 효과음이 없어요.', 'MultiCast TTS');
        return;
    }
    const sounds = [];
    for (const c of list) {
        try {
            const blob = await st.getItem(c.id);
            if (!blob) continue;
            sounds.push({ name: c.name ?? '', words: c.words ?? '', adult: !!c.adult, loop: !!c.loop, data: await blobToDataUrl(blob) });
        } catch (e) {
            console.warn(LOG, 'pack export: skipped', c.name, e);
        }
    }
    if (!sounds.length) {
        toastr.warning('소리 파일을 읽지 못했어요.', 'MultiCast TTS');
        return;
    }
    const json = JSON.stringify({ format: SFX_PACK_FORMAT, version: 1, sounds });
    const url = URL.createObjectURL(new Blob([json], { type: 'application/json' }));
    const a = document.createElement('a');
    const d = new Date();
    a.href = url;
    a.download = `MultiCast_SFX_${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
    toastr.success(`효과음 ${sounds.length}개를 팩 파일로 저장했어요.`, 'MultiCast TTS');
}

async function importSfxPack(file) {
    const s = getSettings();
    if (!Array.isArray(s.customSfx)) s.customSfx = [];
    const st = getCustomSfxStore();
    if (!st) {
        toastr.error('이 브라우저에서는 파일을 저장할 수 없어요.', 'MultiCast TTS');
        return;
    }
    let pack;
    try {
        pack = JSON.parse(await file.text());
    } catch {
        pack = null;
    }
    if (!pack || pack.format !== SFX_PACK_FORMAT || !Array.isArray(pack.sounds)) {
        toastr.error('MultiCast TTS 효과음 팩 파일이 아니에요.', 'MultiCast TTS');
        return;
    }
    let added = 0;
    let skipped = 0;
    for (const snd of pack.sounds) {
        const name = String(snd?.name ?? '').slice(0, 80);
        const words = String(snd?.words ?? '').slice(0, 300);
        // already have the same sound (same name + words) → skip, so loading a pack twice doesn't double it
        if (s.customSfx.some(c => (c.name ?? '') === name && (c.words ?? '') === words)) { skipped++; continue; }
        const blob = dataUrlToBlob(snd?.data);
        if (!blob || !/^audio\//.test(blob.type) || blob.size > CUSTOM_SFX_MAX_MB * 1024 * 1024) { skipped++; continue; }
        const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
        try {
            await st.setItem(id, blob);
        } catch (e) {
            console.warn(LOG, e);
            skipped++;
            continue;
        }
        s.customSfx.push({ id, name, words, ...(snd?.adult ? { adult: true } : {}), ...(snd?.loop ? { loop: true } : {}) });
        added++;
    }
    save();
    renderCustomSfxList();
    setTimeout(updateInlinePrompt, 0);
    if (added) toastr.success(`효과음 ${added}개를 불러왔어요.${skipped ? ` (${skipped}개는 이미 있거나 못 읽어서 건너뜀)` : ''}`, 'MultiCast TTS');
    else toastr.info('새로 넣을 효과음이 없었어요. (이미 다 있어요)', 'MultiCast TTS');
}

function renderVoiceSelects() {
    const s = getSettings();
    $('#voice_cast_male_voice').html(voiceOptionsHtml(s.maleVoiceId));
    $('#voice_cast_female_voice').html(voiceOptionsHtml(s.femaleVoiceId));
    $('#voice_cast_unknown_voice').html(voiceOptionsHtml(s.unknownVoiceId));
    $('#voice_cast_sfx_voice').html(voiceOptionsHtml(s.sfxVoiceId));
    const keep = $('#voice_cast_preview_voice').val();
    $('#voice_cast_preview_voice').html(voiceOptionsHtml(keep || '').replace('<option value="">(없음)</option>', '<option value="">목소리를 골라 샘플 듣기</option>'));
    renderCastList();
}

const openAdv = new Set(); // which cast rows have their acting panel open ("scope:index")

function castArray(scope) {
    return scope === 'bot' ? getBotCast(true) : getSettings().cast;
}

/** The per-character settings panel (opened in its own window from the ⚙ on a cast row). */
function castAdvHtml() {
    return `
        <div class="vc_cast_adv">
            <div class="vc_row">
                <label>성격</label>
                <select class="text_pole vc_cast_temper" style="width:auto">
                    <option value="">기본 (대사대로)</option>
                    ${Object.entries(TEMPERS).map(([k, t]) => `<option value="${k}">${t.label}</option>`).join('')}
                </select>
            </div>
            <div class="vc_row">
                <label>감정 폭</label>
                <select class="text_pole vc_cast_range" style="width:auto">
                    <option value="">기본</option>
                    ${Object.entries(RANGE_LABELS).map(([k, l]) => `<option value="${k}">${k} · ${l}</option>`).join('')}
                </select>
                <span class="vc_hint vc_cast_range_hint"></span>
            </div>
            <input type="text" class="text_pole vc_cast_always" placeholder="항상 붙일 태그 (영어, 쉼표로) 예: soft-spoken, slow drawl" title="이 캐릭터 대사마다 [태그]로 붙어서 말투를 일정하게 잡아줘요. v3/v4 전용. 1~2개 추천." />
            <input type="text" class="text_pole vc_cast_note" placeholder="연기 메모 (선택) 예: 화나도 목소리 안 높임, 말끝을 흐림" />
            <div class="vc_row">
                <label>형광펜 색</label>
                <input type="color" class="vc_cast_color" />
                <div class="menu_button menu_button_icon vc_cast_color_reset" title="기본 형광펜 색으로"><i class="fa-solid fa-xmark"></i><span>기본색</span></div>
            </div>
            <label>음량: <span class="vc_cast_vol_val"></span></label>
            <input type="range" class="vc_cast_vol" min="0" max="2" step="0.05" />
            <label>속도: <span class="vc_cast_rate_val"></span></label>
            <input type="range" class="vc_cast_rate" min="0.7" max="1.5" step="0.05" />
            <label>Stability: <span class="vc_cast_stab_val"></span></label>
            <input type="range" class="vc_cast_stab" min="0" max="1" step="0.05" />
            <label>Similarity: <span class="vc_cast_sim_val"></span></label>
            <input type="range" class="vc_cast_sim" min="0" max="1" step="0.05" />
            <div class="vc_row">
                <span class="vc_hint">낮은 Stability = 감정 폭이 크고 들쭉날쭉 · 높으면 차분하고 일정해요.</span>
                <div class="menu_button menu_button_icon vc_cast_adv_reset"><i class="fa-solid fa-rotate-left"></i><span>공통 설정 따르기</span></div>
            </div>
        </div>`;
}

function fillCastAdv($row, entry) {
    const g = getSettings();
    const stab = entry.stability ?? null;
    const sim = entry.similarity ?? null;
    $row.find('.vc_cast_stab').val(stab ?? g.stability);
    $row.find('.vc_cast_sim').val(sim ?? g.similarity);
    $row.find('.vc_cast_stab_val').text(stab === null ? `공통 (${Math.round(g.stability * 100)}%)` : `${Math.round(stab * 100)}%`);
    $row.find('.vc_cast_sim_val').text(sim === null ? `공통 (${Math.round(g.similarity * 100)}%)` : `${Math.round(sim * 100)}%`);
    $row.find('.vc_cast_temper').val(entry.temper ?? '');
    $row.find('.vc_cast_range').val(entry.range ? String(entry.range) : '');
    $row.find('.vc_cast_range_hint').text(entry.range ? '' : `지금 ${rangeFor(entry)} · ${RANGE_LABELS[rangeFor(entry)]}`);
    $row.find('.vc_cast_note').val(entry.actingNote ?? '');
    $row.find('.vc_cast_always').val(entry.alwaysTags ?? '');
    $row.find('.vc_cast_color').val(/^#[0-9a-f]{6}$/i.test(entry.color ?? '') ? entry.color : '#ffd54f');
    $row.find('.vc_cast_color').toggleClass('vc_color_unset', !entry.color);
    const vol = entry.volume ?? null;
    $row.find('.vc_cast_vol').val(vol ?? 1);
    $row.find('.vc_cast_vol_val').text(vol === null ? '100%' : `${Math.round(vol * 100)}%`);
    const crate = entry.rate ?? null;
    $row.find('.vc_cast_rate').val(crate ?? 1);
    $row.find('.vc_cast_rate_val').text(crate === null ? '기본 (1배)' : `${Number(crate).toFixed(2).replace(/0$/, '')}배`);
}

/** ⚙ on a cast row → this character's settings in a window; 저장 keeps them, 취소 puts everything back. */
async function openCastAdvPopup(scope, i) {
    const ctx = SillyTavern.getContext();
    const list = castArray(scope);
    const entry = list?.[i];
    if (!entry) return;
    const before = structuredClone(entry);
    const name = String(entry.names ?? '').split(',')[0]?.trim() || '이름 없는 캐릭터';
    const $box = $(`
        <div class="vc_cast_popup">
            <h3>🎭 <span class="vc_cast_popup_name"></span> 설정</h3>
            <div class="vc_cast_row" data-scope="${scope}" data-index="${i}">${castAdvHtml()}</div>
        </div>`);
    $box.find('.vc_cast_popup_name').text(name);
    const $row = $box.find('.vc_cast_row');
    const refill = () => { const e = castArray(scope)?.[i]; if (e) fillCastAdv($row, e); };
    refill();
    bindCastAdvHandlers($box);
    // re-read after changes that reset or recompute other fields
    $box.on('change', '.vc_cast_temper, .vc_cast_range', () => setTimeout(refill, 0));
    $box.on('click', '.vc_cast_color_reset, .vc_cast_adv_reset', () => setTimeout(refill, 0));
    const popup = new ctx.Popup($box, ctx.POPUP_TYPE.TEXT, '', { okButton: '저장', cancelButton: '취소', wide: false, leftAlign: true, allowVerticalScrolling: true });
    popup.dlg?.classList.add('vc_cast_popup_dlg');
    const result = await popup.show();
    if (result !== ctx.POPUP_RESULT.AFFIRMATIVE) {
        const cur = castArray(scope);
        if (cur?.[i]) {
            for (const k of Object.keys(cur[i])) delete cur[i][k];
            Object.assign(cur[i], before);
        }
    } else {
        toastr.success(`${name} 설정을 저장했어요.`, 'MultiCast TTS', { timeOut: 1500 });
    }
    save();
    renderCastList();
}

function renderCastList() {
    const s = getSettings();
    const bot = currentBot();

    const renderInto = ($list, list, scope) => {
        $list.empty();
        if (!list?.length) {
            $list.append('<div class="vc_hint">(비어 있어요)</div>');
            return;
        }
        list.forEach((entry, i) => {
            const moveTitle = scope === 'bot' ? '공통 캐스트로 옮기기 (모든 봇에 적용)' : '이 봇 캐스트로 옮기기';
            const hasCustom = ['stability', 'similarity', 'volume', 'rate', 'temper', 'range', 'actingNote', 'alwaysTags', 'color'].some(k => (entry[k] ?? '') !== '');
            const $row = $(`
                <div class="vc_cast_row" data-index="${i}" data-scope="${scope}">
                    <input type="text" class="text_pole vc_cast_names" placeholder="이름, 별명 (쉼표로 구분)" />
                    <select class="text_pole vc_cast_gender">
                        <option value="u">?</option>
                        <option value="m">남</option>
                        <option value="f">여</option>
                    </select>
                    <select class="text_pole vc_cast_voice">${voiceOptionsHtml(entry.voiceId)}</select>
                    <div class="vc_cast_btns">
                        <div class="vc_cast_adv_toggle fa-solid fa-sliders ${hasCustom ? 'vc_custom' : ''}" title="이 캐릭터만 따로 설정 (성격 / 형광펜 / 음량 / 속도 / Stability / Similarity)"></div>
                        ${scope === 'global' && !bot ? '' : `<div class="vc_cast_move fa-solid ${scope === 'bot' ? 'fa-globe' : 'fa-user-tag'}" title="${moveTitle}"></div>`}
                        <div class="vc_cast_delete fa-solid fa-trash-can" title="삭제"></div>
                    </div>
                </div>`);
            $row.find('.vc_cast_names').val(entry.names ?? '');
            $row.find('.vc_cast_gender').val(entry.gender ?? 'u');
            $list.append($row);
        });
    };

    if (bot) {
        $('#voice_cast_bot_cast_title').text(`🎭 이 봇 캐스트 — ${bot.name}`);
        $('#voice_cast_bot_cast_block').show();
        $('#voice_cast_no_bot').hide();
        renderInto($('#voice_cast_bot_cast_list'), getBotCast(true), 'bot');
    } else {
        $('#voice_cast_bot_cast_block').hide();
        $('#voice_cast_no_bot').show();
    }
    renderInto($('#voice_cast_cast_list'), s.cast, 'global');
}

async function loadVoices(showToast = false) {
    try {
        voiceList = await fetchVoices();
        voiceList.sort((a, b) => a.name.localeCompare(b.name));
        $('#voice_cast_key').addClass('success');
        renderVoiceSelects();
        if (showToast) toastr.success(`목소리 ${voiceList.length}개를 불러왔어요.`, 'MultiCast TTS');
    } catch (e) {
        console.warn(LOG, 'voice list failed', e);
        $('#voice_cast_key').removeClass('success');
        renderVoiceSelects();
        if (showToast) {
            const st = e?.status;
            toastr.error(`목소리 목록을 못 불러왔어요 (${st ? `HTTP ${st}` : '연결 오류'}). ${connectionErrorText(e)}`, 'MultiCast TTS', { timeOut: 12000 });
        }
        throw e;
    }
}

function connectionErrorText(e) {
    const st = e?.status;
    return st === 400 ? '실리태번에 ElevenLabs 키가 저장돼 있지 않아요. 🔑 버튼으로 키를 다시 넣어주세요.'
        : st === 404 ? '이 실리태번 버전에는 필요한 기능이 없어요. 실리태번 1.15.0 이상으로 업데이트해 주세요.'
        : st === 500 ? '일레븐랩스가 요청을 거절했거나 연결이 안 됐어요. 키가 맞는지(sk_로 시작, 권한: Text to Speech + Voices 읽기), 인터넷 연결을 확인해 주세요. 자세한 이유는 실리태번 서버 화면(콘솔)에 나와요.'
        : '실리태번 서버와 연결이 안 됐어요.';
}

/** 🔌 연결 확인: is the key saved, accepted by ElevenLabs, and are voices readable? (no credits used) */
async function checkConnection() {
    const $out = $('#voice_cast_conn_status');
    $out.attr('data-state', 'busy').text('확인 중…');
    try {
        await loadVoices(false);
        const own = voiceList.filter(v => !['premade'].includes(v.category)).length;
        $out.attr('data-state', 'ok').text(`✅ 연결됐어요 · 목소리 ${voiceList.length}개 (내 목소리 ${own}개) · 모델 ${modelInfo(getSettings().model).label}`);
        toastr.success('일레븐랩스 연결 OK!', 'MultiCast TTS', { timeOut: 2000 });
    } catch (e) {
        const st = e?.status;
        $out.attr('data-state', 'error').text(`❌ 연결 실패 (${st ? `HTTP ${st}` : '연결 오류'}) · ${connectionErrorText(e)}`);
    }
}

async function showLastScript() {
    const ctx = SillyTavern.getContext();
    let id = ctx.chat.length - 1;
    while (id >= 0 && !getStoredEntry(ctx.chat[id])) id--;
    if (id < 0) {
        toastr.info('아직 분류된 메시지가 없어요. 메시지의 📜 버튼으로 바로 편집할 수도 있어요.', 'MultiCast TTS');
        return;
    }
    openScriptEditor(id);
}

// ---------------------------------------------------------------------------
// Script editor
// ---------------------------------------------------------------------------

function voiceName(id) {
    return voiceList.find(v => v.id === id)?.name ?? (id ? `${id.slice(0, 8)}…` : '없음');
}

function editorRowHtml() {
    return `
    <div class="vc_edit_row">
        <div class="vc_edit_head">
            <select class="text_pole vc_e_type" title="종류">
                <option value="speech">💬 대사</option>
                <option value="thought">💭 속마음</option>
                <option value="sfx">🔔 효과음</option>
            </select>
            <input type="text" class="text_pole vc_e_speaker" placeholder="화자" title="화자 이름 (캐스트 표와 매칭돼요)" />
            <select class="text_pole vc_e_gender" title="성별">
                <option value="u">?</option>
                <option value="m">남</option>
                <option value="f">여</option>
            </select>
            <select class="text_pole vc_e_voice" title="목소리 (자동 = 캐스트 표/성별로 결정)"></select>
            <input type="text" class="text_pole vc_e_tag" placeholder="태그 (예: angry)" title="감정/연기 태그. 비우면 태그 없이 읽어요" />
            <div class="vc_e_btns">
                <span class="vc_e_has fa-solid fa-circle-check" title="이 줄 음성이 이미 만들어져 있어요 (다시 들어도 크레딧 안 씀)" hidden></span>
                <div class="vc_icon_btn vc_e_play fa-solid fa-play" title="이 줄만 듣기 (저장된 음성이 있으면 그걸 재생)"></div>
                <div class="vc_icon_btn vc_e_regen fa-solid fa-dice" title="이 줄 음성 새로 뽑기 (크레딧 사용)"></div>
                <div class="vc_icon_btn vc_e_fav fa-regular fa-star" title="즐겨찾기 (시간이 지나도 안 지워져요)"></div>
                <div class="vc_icon_btn vc_e_dl fa-solid fa-download" title="이 줄 음성만 mp3로 받기 (▶로 먼저 들어서 만든 뒤)"></div>
                <div class="vc_icon_btn vc_e_up fa-solid fa-arrow-up" title="위로"></div>
                <div class="vc_icon_btn vc_e_down fa-solid fa-arrow-down" title="아래로"></div>
                <div class="vc_icon_btn vc_e_del fa-solid fa-trash-can" title="삭제"></div>
            </div>
        </div>
        <textarea class="text_pole vc_e_text" rows="2" placeholder="대사"></textarea>
    </div>`;
}

function makeEditorRow(line) {
    const $row = $(editorRowHtml());
    $row.find('.vc_e_type').val(['thought', 'sfx'].includes(line.type) ? line.type : 'speech');
    $row.find('.vc_e_speaker').val(line.speaker ?? '');
    $row.find('.vc_e_gender').val(['m', 'f'].includes(line.gender) ? line.gender : 'u');
    $row.find('.vc_e_tag').val(line.tag ?? '');
    $row.find('.vc_e_text').val(line.text ?? '');
    if (line.orig) {
        $row.data('orig', line.orig);
        $row.find('.vc_e_text').attr('title', `원문: ${line.orig}`);
    }
    refreshRowVoiceSelect($row, line.voiceId ?? '');
    // remember which audio take belongs to this line, and what the line looked like when it was made
    if (line.audioKey) {
        $row.data('audioKey', line.audioKey);
        $row.data('sig', lineSignature(readEditorRow($row)));
    }
    updateRowBadge($row);
    return $row;
}

/** ✓ on rows whose voice is already made (and the line wasn't changed since). */
function updateRowBadge($row) {
    const key = $row.data('audioKey');
    const has = !!key && $row.data('sig') === lineSignature(readEditorRow($row)) && (storeIndex === null || keyHasAudio(key));
    const el = $row.find('.vc_e_has')[0];
    if (el) el.hidden = !has;
    const fav = has && isFav(key);
    $row.find('.vc_e_fav').toggleClass('vc_on fa-solid', fav).toggleClass('fa-regular', !fav).toggleClass('vc_disabled', !has);
    $row.find('.vc_e_dl').toggleClass('vc_disabled', !has).css('opacity', has ? '' : 0.25);
}

function lineSignature(line) {
    return JSON.stringify([line.speaker, line.gender, line.type, line.tag, line.text, line.voiceId ?? '']);
}

/** Rebuilds the voice dropdown so the "auto" option shows which voice would be used right now. */
function refreshRowVoiceSelect($row, selected) {
    const line = readEditorRow($row, { ignoreVoice: true });
    const auto = voiceName(pickVoice(line));
    const html = `<option value="">(자동: ${escapeHtml(auto)})</option>` + voiceOptionsHtml(selected).replace('<option value="">(없음)</option>', '');
    const $sel = $row.find('.vc_e_voice').html(html);
    $sel.val(selected ?? '');
}

function readEditorRow($row, { ignoreVoice = false } = {}) {
    const line = {
        speaker: String($row.find('.vc_e_speaker').val() ?? '').trim() || 'unknown',
        gender: String($row.find('.vc_e_gender').val() ?? 'u'),
        type: ['thought', 'sfx'].includes($row.find('.vc_e_type').val()) ? $row.find('.vc_e_type').val() : 'speech',
        tag: String($row.find('.vc_e_tag').val() ?? '').replace(/[[\]]/g, '').trim(),
        text: String($row.find('.vc_e_text').val() ?? '').trim(),
    };
    if ($row.data('orig')) line.orig = $row.data('orig');
    const voiceId = ignoreVoice ? '' : String($row.find('.vc_e_voice').val() ?? '');
    if (voiceId) line.voiceId = voiceId;
    if (!ignoreVoice) {
        // keep the saved take only while the line is unchanged
        const audioKey = $row.data('audioKey');
        if (audioKey && $row.data('sig') === lineSignature(line)) line.audioKey = audioKey;
    }
    return line;
}

function readEditor($editor) {
    return $editor.find('.vc_edit_row').toArray()
        .map(el => readEditorRow($(el)))
        .filter(l => l.text);
}

function buildEditor(messageId, script) {
    const s = getSettings();
    const tagsOn = s.useTags && modelInfo(s.model).tags;
    const $editor = $(`
        <div class="vc_editor">
            <h3>📜 메시지 #${messageId} 대본</h3>
            <div class="vc_hint">
                화자·성별·목소리·태그·대사를 고칠 수 있어요. 고친 줄만 새로 생성되고, 안 고친 줄은 저장된 음성을 다시 써요.
                ${tagsOn ? '' : '<br>⚠️ 지금 모델/설정에서는 태그가 꺼져 있어서 태그 없이 읽어요.'}
            </div>
            <div class="vc_edit_lines"></div>
            <div class="menu_button menu_button_icon vc_add_line"><i class="fa-solid fa-plus"></i><span>줄 추가</span></div>
        </div>`);
    const $lines = $editor.find('.vc_edit_lines');
    for (const line of script) $lines.append(makeEditorRow(line));
    if (!script.length) $lines.append('<div class="vc_empty">(분류된 대사가 없어요. 직접 추가할 수 있어요)</div>');

    $editor.on('click', '.vc_add_line', () => {
        $lines.find('.vc_empty').remove();
        $lines.append(makeEditorRow({ speaker: '', gender: 'u', type: 'speech', tag: '', text: '' }));
    });
    $editor.on('click', '.vc_e_del', function () {
        $(this).closest('.vc_edit_row').remove();
    });
    $editor.on('click', '.vc_e_up', function () {
        const $row = $(this).closest('.vc_edit_row');
        $row.prev('.vc_edit_row').before($row);
    });
    $editor.on('click', '.vc_e_down', function () {
        const $row = $(this).closest('.vc_edit_row');
        $row.next('.vc_edit_row').after($row);
    });
    const previewRow = async ($row, fresh) => {
        const line = readEditorRow($row);
        if (!line.text) return;
        if (fresh) line._fresh = true;
        await playMessage(null, { script: [line] });
        // the take that just played becomes this line's audio (saved when the script is saved)
        if (line.audioKey) {
            $row.data('audioKey', line.audioKey);
            $row.data('sig', lineSignature(readEditorRow($row, { ignoreVoice: false })));
        }
        updateRowBadge($row);
    };
    $editor.on('click', '.vc_e_play', function () {
        previewRow($(this).closest('.vc_edit_row'), false);
    });
    $editor.on('click', '.vc_e_regen', function () {
        previewRow($(this).closest('.vc_edit_row'), true);
    });
    $editor.on('click', '.vc_e_fav', async function () {
        const $row = $(this).closest('.vc_edit_row');
        const line = readEditorRow($row);
        if (!line.audioKey) {
            toastr.info('먼저 ▶로 들어서 음성을 만들어 주세요.', 'MultiCast TTS', { timeOut: 2000 });
            return;
        }
        const on = !isFav(line.audioKey);
        if (!(await setFav(line.audioKey, on, line))) return;
        noteClipInfo(line.audioKey, line);
        updateRowBadge($row);
        toastr.info(on ? '⭐ 즐겨찾기했어요. 시간이 지나도 안 지워져요.' : '즐겨찾기를 해제했어요.', 'MultiCast TTS', { timeOut: 1500 });
    });
    // ⬇ save just this line's take (the one heard last) as its own file
    $editor.on('click', '.vc_e_dl', async function () {
        const line = readEditorRow($(this).closest('.vc_edit_row'));
        if (!line.audioKey) {
            toastr.info('먼저 ▶로 들어서 음성을 만들어 주세요.', 'MultiCast TTS', { timeOut: 2000 });
            return;
        }
        const url = await getCachedAudio(line.audioKey, { preview: true });
        if (!url) {
            toastr.info('이 기기에는 저장된 음성이 없어요. ▶로 다시 들어주세요.', 'MultiCast TTS');
            return;
        }
        try {
            const blob = await (await fetch(url)).blob();
            const a = document.createElement('a');
            a.href = URL.createObjectURL(blob);
            const who = line.type === 'sfx' ? 'SFX' : line.speaker;
            const ext = { 'audio/wav': 'wav', 'audio/x-wav': 'wav', 'audio/wave': 'wav', 'audio/ogg': 'ogg', 'audio/flac': 'flac', 'audio/mp4': 'm4a', 'audio/x-m4a': 'm4a', 'audio/aac': 'aac', 'audio/webm': 'webm' }[blob.type] ?? 'mp3';
            a.download = `${safeFileName(who)}_${messageId ?? 'line'}_${safeFileName(line.text).slice(0, 20)}.${ext}`;
            document.body.appendChild(a);
            a.click();
            a.remove();
            setTimeout(() => URL.revokeObjectURL(a.href), 5000);
        } catch (e) {
            console.warn(LOG, e);
            toastr.error('파일을 만들지 못했어요.', 'MultiCast TTS');
        }
    });
    // editing a line means its old take no longer matches → hide the ✓
    $editor.on('input change', '.vc_edit_row input, .vc_edit_row select, .vc_edit_row textarea', function () {
        updateRowBadge($(this).closest('.vc_edit_row'));
    });
    // keep the "auto" voice label in sync when speaker/gender change
    $editor.on('change', '.vc_e_speaker, .vc_e_gender', function () {
        const $row = $(this).closest('.vc_edit_row');
        refreshRowVoiceSelect($row, String($row.find('.vc_e_voice').val() ?? ''));
    });
    return $editor;
}

const EDITOR_SAVE_ONLY = 1001;  // POPUP_RESULT.CUSTOM1
const EDITOR_RECLASSIFY = 1002; // POPUP_RESULT.CUSTOM2

async function openScriptEditor(messageId) {
    const ctx = SillyTavern.getContext();
    if (!ctx.chat[messageId]) return;
    if (!voiceList.length) await loadVoices(false).catch(() => {});
    await loadIndex();

    let script;
    // a stored script opens at once; if it has to be (re)classified, say so instead of looking frozen
    const slowNote = setTimeout(() => toastr.info('대사 분류 중...', 'MultiCast TTS', { timeOut: 2500 }), 300);
    try {
        script = await getScript(messageId);
    } catch (e) {
        console.error(LOG, e);
        toastr.error(String(e.message ?? e), 'MultiCast TTS');
        script = [];
    } finally {
        clearTimeout(slowNote);
    }

    // loop so "re-classify" can reopen the editor with fresh results
    // eslint-disable-next-line no-constant-condition
    while (true) {
        const $editor = buildEditor(messageId, script);
        const popup = new ctx.Popup($editor, ctx.POPUP_TYPE.TEXT, '', {
            okButton: '저장하고 재생',
            cancelButton: '닫기',
            wide: true,
            allowVerticalScrolling: true,
            leftAlign: true,
            customButtons: [
                {
                    text: '파일로 받기',
                    icon: 'fa-download',
                    action: async () => {
                        const current = readEditor($editor);
                        const isChanged = JSON.stringify(current) !== JSON.stringify(script);
                        const kind = await chooseDownloadKind();
                        if (kind) downloadMessageAudio(messageId, isChanged ? current : null, { kind });
                    },
                },
                { text: '저장만', result: EDITOR_SAVE_ONLY, icon: 'fa-floppy-disk' },
                { text: 'AI로 다시 분류', result: EDITOR_RECLASSIFY, icon: 'fa-rotate' },
            ],
        });
        popup.dlg?.classList.add('vc_editor_popup');
        const result = await popup.show();
        const edited = readEditor($editor);
        const changed = JSON.stringify(edited) !== JSON.stringify(script);

        if (result === EDITOR_RECLASSIFY) {
            const wasEdited = getStoredEntry(ctx.chat[messageId])?.edited || changed;
            if (wasEdited) {
                const ok = await ctx.Popup.show.confirm('MultiCast TTS', '다시 분류하면 직접 고친 내용이 사라져요. 계속할까요?');
                if (!ok) continue;
            }
            try {
                toastr.info('대사 다시 분류 중...', 'MultiCast TTS', { timeOut: 1500 });
                script = await getScript(messageId, { force: true });
            } catch (e) {
                toastr.error(String(e.message ?? e), 'MultiCast TTS');
            }
            continue;
        }

        // only new voice takes (lines heard in the editor), nothing else edited → keep those takes, even on 닫기
        const withoutAudio = arr => JSON.stringify(arr.map(({ audioKey, ...rest }) => rest));
        if (changed && withoutAudio(edited) === withoutAudio(script)) {
            const stored = getStoredEntry(ctx.chat[messageId])?.script;
            if (Array.isArray(stored) && stored.length === edited.length) {
                edited.forEach((l, i) => { if (l.audioKey) stored[i].audioKey = l.audioKey; });
                await ctx.saveChat();
                redecorateMessage(messageId);
                script = stored;
            }
            if (result === ctx.POPUP_RESULT.AFFIRMATIVE) playMessage(messageId, {});
            return;
        }

        if (result === ctx.POPUP_RESULT.AFFIRMATIVE || result === EDITOR_SAVE_ONLY) {
            if (changed) {
                await saveEditedScript(messageId, edited);
                redecorateMessage(messageId);
                toastr.success('대본을 저장했어요.', 'MultiCast TTS', { timeOut: 1500 });
            }
            if (result === ctx.POPUP_RESULT.AFFIRMATIVE) {
                // unchanged → play the stored script itself so new takes get pinned to it
                playMessage(messageId, changed ? { script: edited } : {});
            }
        }
        return;
    }
}

// ---------------------------------------------------------------------------
// Settings export / import
// ---------------------------------------------------------------------------

function exportSettings() {
    const data = {
        app: 'voice_cast',
        format: 1,
        exportedAt: new Date().toISOString(),
        settings: structuredClone(getSettings()),
    };
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `voice-cast-settings-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 10000);
    toastr.success('설정을 파일로 저장했어요.', 'MultiCast TTS');
}

async function importSettings(file) {
    const ctx = SillyTavern.getContext();
    let data;
    try {
        data = JSON.parse(await file.text());
    } catch {
        toastr.error('설정 파일을 읽지 못했어요.', 'MultiCast TTS');
        return;
    }
    const incoming = data?.app === 'voice_cast' ? data.settings : null;
    if (!incoming || typeof incoming !== 'object') {
        toastr.error('MultiCast TTS 설정 파일이 아니에요.', 'MultiCast TTS');
        return;
    }
    const ok = await ctx.Popup.show.confirm('MultiCast TTS', '지금 설정을 이 파일의 설정으로 바꿀까요? (저장된 음성과 대본은 그대로예요)');
    if (!ok) return;

    const s = getSettings();
    for (const key of Object.keys(defaultSettings)) {
        if (Object.hasOwn(incoming, key)) s[key] = structuredClone(incoming[key]);
    }
    // connection profiles are per-install: keep the imported one only if it exists here
    const profiles = ctx.extensionSettings?.connectionManager?.profiles ?? [];
    if (s.profileId && !profiles.some(pr => pr.id === s.profileId)) s.profileId = '';
    getSettings(); // re-validate shapes
    save();
    syncListeningUI();
    renderCustomSfxList();
    renderVoiceSelects();
    toastr.success('설정을 가져왔어요. 새로고침하면 모든 칸에 반영돼요.', 'MultiCast TTS');
}

// ---------------------------------------------------------------------------
// Voice language quick switch (wand menu + slash command)
// ---------------------------------------------------------------------------

/** Keep the 번역할 언어 dropdown in step when the language is changed elsewhere (slash command). */
function syncTranslateUI() {
    const v = String(getSettings().translateTo || '').trim();
    const preset = $('#voice_cast_translate_pick option').filter(function () { return this.value.toLowerCase() === v.toLowerCase(); }).val();
    $('#voice_cast_translate_pick').val(preset ?? '__custom__');
    $('#voice_cast_translate_to').val(v).toggle(!preset);
}

function setVoiceLang(mode) {
    const s = getSettings();
    s.voiceLang = mode;
    save();
    $('#voice_cast_voice_lang').val(mode);
    $('#voice_cast_translate_block').toggle(mode === 'translate');
    updateWandItem();
    refreshLineButtons({ rebuild: true });
    markAllScriptButtons(); // each voice language has its own script
    toastr.info(`음성 언어: ${voiceLangLabel()}`, 'MultiCast TTS', { timeOut: 1500 });
}

function cycleVoiceLang() {
    const order = ['display', 'original', 'translate'];
    const cur = order.indexOf(getSettings().voiceLang);
    setVoiceLang(order[(cur + 1) % order.length]);
}

function setSfx(on) {
    getSettings().sfxEnabled = !!on;
    save();
    updateInlinePrompt();
    $('#voice_cast_sfx').prop('checked', !!on);
    updateWandItem();
    if (on && !modelInfo(getSettings().model).tags) {
        toastr.warning('지금 모델은 [태그]를 몰라서 효과음이 안 나와요. Eleven v3나 v4를 골라주세요.', 'MultiCast TTS');
    } else {
        toastr.info(`효과음 ${on ? '켬' : '끔'}`, 'MultiCast TTS', { timeOut: 1500 });
    }
}

function updateWandItem() {
    $('#voice_cast_wand_label').text(`MultiCast TTS: ${voiceLangLabel()}`);
    $('#voice_cast_wand_sfx_label').text(`MultiCast TTS: 효과음 ${getSettings().sfxEnabled ? '켜짐' : '꺼짐'}`);
}

function addWandItem() {
    if ($('#voice_cast_wand').length) return;
    const $menu = $('#extensionsMenu');
    if (!$menu.length) return;
    // one entry only — the quick toggles live in a small popup so the wand menu stays short
    const $item = $(`
        <div id="voice_cast_wand" class="list-group-item flex-container flexGap5" title="MultiCast TTS 빠른 메뉴 (음성 언어 · 기다림 없이 바로 듣기 · 효과음 · 저장된 음성)">
            <div class="extensionsMenuExtensionButton fa-solid fa-headphones"></div>
            <span>MultiCast TTS</span>
        </div>`);
    $item.on('click', openQuickMenu);
    $menu.append($item);
    updateSoloUI();
    updateInlinePrompt();
}

function setInlineTags(on) {
    getSettings().inlineTags = !!on;
    save();
    $('#voice_cast_inline').prop('checked', !!on);
    updateInlinePrompt();
    toastr.info(on ? '🚀 기다림 없이 바로 듣기 켬 (새로 받는 답변부터)' : '🚀 기다림 없이 바로 듣기 끔', 'MultiCast TTS', { timeOut: 1800 });
}

async function openQuickMenu() {
    const ctx = SillyTavern.getContext();
    const $box = $('<div class="vc_quick_menu"></div>');
    let popup = null;
    const rows = [
        { id: 'lang', icon: 'fa-language', label: () => `음성 언어: ${voiceLangLabel()}`, hint: '누를 때마다 화면대로 → 원문 → AI 번역', run: () => cycleVoiceLang() },
        { id: 'inline', icon: 'fa-rocket', label: () => `기다림 없이 바로 듣기: ${getSettings().inlineTags ? '켜짐' : '꺼짐'}`, hint: '답변을 쓸 때 대본도 같이 만들어요', run: () => setInlineTags(!getSettings().inlineTags) },
        { id: 'sfx', icon: 'fa-bell', label: () => `효과음: ${getSettings().sfxEnabled ? '켜짐' : '꺼짐'}`, hint: '', run: () => setSfx(!getSettings().sfxEnabled) },
        { id: 'saved', icon: 'fa-list', label: () => '이 채팅 대사 음성', hint: '', run: () => { popup?.completeCancelled?.(); setTimeout(openSavedList, 50); } },
        { id: 'all', icon: 'fa-folder-open', label: () => '모든 봇 대사 음성 · ⭐ 즐겨찾기', hint: '봇·캐릭터별로 골라 보기', run: () => { popup?.completeCancelled?.(); setTimeout(() => openAllVoices(), 50); } },
        // buttons other extensions added (e.g. 📱 폰 열기) — they close this menu and run their own action
        ...[...quickActions.values()].map(a => ({
            id: `ext_${a.id}`, icon: a.icon, label: () => a.label, hint: a.hint,
            run: () => { popup?.completeCancelled?.(); setTimeout(() => { try { a.run(); } catch (e) { console.warn(LOG, 'quick action failed', a.id, e); } }, 50); },
        })),
    ];
    const render = () => {
        $box.empty();
        for (const r of rows) {
            const $r = $(`<div class="vc_quick_row menu_button" data-id="${r.id}">
                <i class="fa-solid ${r.icon}"></i><span class="vc_quick_label"></span>${r.hint ? '<small class="vc_quick_hint"></small>' : ''}
            </div>`);
            $r.find('.vc_quick_label').text(r.label());
            if (r.hint) $r.find('.vc_quick_hint').text(r.hint);
            $r.on('click', () => { r.run(); render(); });
            $box.append($r);
        }
    };
    render();
    popup = new ctx.Popup($box, ctx.POPUP_TYPE.TEXT, '', { okButton: '닫기', leftAlign: true });
    await popup.show();
}

function settingsHtml() {
    const modelOptions = MODELS.map(m => `<option value="${m.id}">${m.label}</option>`).join('')
        + '<option value="__custom__">✏️ 직접 입력 (새 모델 ID)</option>';
    return `
    <div id="voice_cast_settings" class="extension_settings">
        <div class="inline-drawer">
            <div class="inline-drawer-toggle inline-drawer-header">
                <b><svg xmlns="http://www.w3.org/2000/svg" class="vc_title_icon" aria-hidden="true" focusable="false" viewBox="3 0 58 58"><path d="M12 38V29C12 17.95 20.95 9 32 9s20 8.95 20 20v9" fill="none" stroke="#F52D56" stroke-width="6" stroke-linecap="round"/><path d="M32 11C32 3 39 1 46 3c-2 7-7 10-14 8Z" fill="#26B576"/><rect x="6" y="32" width="17" height="23" rx="8.5" fill="#F52D56"/><rect x="41" y="32" width="17" height="23" rx="8.5" fill="#F52D56"/></svg> MultiCast TTS</b>
                <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
            </div>
            <div class="inline-drawer-content">
                <label class="checkbox_label"><input id="voice_cast_enabled" type="checkbox" /><span>사용</span></label>
                <div class="vc_row">
                    <div id="voice_cast_stop" class="menu_button menu_button_icon"><i class="fa-solid fa-stop"></i><span>재생 정지</span></div>
                    <button type="button" id="voice_cast_generation_toggle" class="menu_button">음성 생성 중지</button>
                    <div id="voice_cast_show_script" class="menu_button menu_button_icon"><i class="fa-solid fa-scroll"></i><span>마지막 대본 편집</span></div>
                </div>
                <div id="voice_cast_generation_status" class="vc_hint" role="status" aria-live="polite"></div>
                <div class="vc_hint">재생 정지는 현재 재생과 그 재생의 대기열을 멈춰요. 음성 생성 중지는 미리 만들기를 포함한 새 생성을 막고, 현재 듣는 대사는 끝까지 재생해요.</div>
                <div class="vc_listening_setup">
                    <label for="voice_cast_listening_mode">듣는 방식</label>
                    <select id="voice_cast_listening_mode" class="text_pole">
                        <option value="manual">눌러서 듣기</option>
                        <option value="auto">새 답변 자동으로 듣기</option>
                        <option value="read">읽다가 대사만 듣기</option>
                    </select>
                    <div id="voice_cast_listening_hint" class="vc_hint"></div>
                    <label class="checkbox_label"><input id="voice_cast_line_btns" type="checkbox" /><span>대사 옆에 ▶ 버튼 보이기</span></label>
                    <div class="vc_hint vc_sub">대본이 준비된 대사마다 ▶가 생겨요. 꽉 찬 ▶는 바로 재생, 빈 ▶는 누를 때 그 줄만 만들어요. '읽다가 대사만 듣기'에서는 끄더라도 보여요 (꾹 눌러서 듣기를 켜면 숨겨져요). 이어듣기를 켜면 ▶부터 쭉 이어서 들어요.</div>
                    <label class="checkbox_label"><input id="voice_cast_hold" type="checkbox" /><span>대사 꾹 눌러서 듣기</span></label>
                    <div class="vc_hint vc_sub">대사를 0.5초 누르고 있으면 그 줄을 들어요. 짧게 탭하는 건 번역기(원문 보기)에 그대로 양보해요. ▶ 버튼을 끄고 이것만 써도 돼요 (그럼 '읽다가 대사만 듣기'에서도 ▶가 안 떠요).</div>
                    <div id="voice_cast_precreate_options">
                        <label class="checkbox_label"><input id="voice_cast_precreate" type="checkbox" /><span>새 답변 음성을 미리 만들어두기</span></label>
                        <div class="vc_hint vc_sub">누르면 바로 들을 수 있지만, 듣지 않은 대사도 생성 크레딧을 써요.</div>
                    </div>
                </div>
                <details class="vc_group" data-group="start">
                    <summary class="vc_group_title">🔑 시작하기 · 키 · 모델 · 기본 목소리</summary>
                    <div class="vc_group_body">
                <div class="vc_row">
                    <div id="voice_cast_key" class="menu_button menu_button_icon manage-api-keys" data-key="api_key_elevenlabs" title="실리태번 비밀 저장소에 키를 저장해요 (기본 TTS와 공유)">
                        <i class="fa-solid fa-key"></i><span>ElevenLabs API 키 설정</span>
                    </div>
                </div>
                <div class="vc_row">
                    <div id="voice_cast_check" class="menu_button menu_button_icon" title="키가 저장돼 있고 일레븐랩스가 받아주는지 확인해요 (크레딧 안 씀)"><i class="fa-solid fa-plug-circle-check"></i><span>연결 확인</span></div>
                </div>
                <div id="voice_cast_conn_status" class="vc_conn_status"></div>
                <div class="vc_hint">키는 실리태번 서버의 비밀 저장소에 저장돼요. 기본 TTS 확장은 꺼둬도 괜찮아요.</div>
                <div class="vc_row">
                    <a class="menu_button menu_button_icon" href="${ELEVENLABS_HISTORY_URL}" target="_blank" rel="noopener noreferrer" title="일레븐랩스 생성 기록(History)을 새 탭에서 열어요">
                        <i class="fa-solid fa-clock-rotate-left"></i><span>일레븐랩스 기록 열기</span>
                    </a>
                    <a class="menu_button menu_button_icon" href="https://elevenlabs.io/app/developers/api-keys" target="_blank" rel="noopener noreferrer" title="API 키 관리 페이지">
                        <i class="fa-solid fa-up-right-from-square"></i><span>API 키 페이지</span>
                    </a>
                </div>
                <div class="vc_hint">개인 요금제는 로깅을 끌 수 없어서, 기록은 History에서 직접 지워야 해요. MultiCast TTS에 저장된 음성은 지워도 그대로 남아요.</div>
                <label for="voice_cast_model">모델</label>
                <select id="voice_cast_model" class="text_pole">${modelOptions}</select>
                <div id="voice_cast_custom_model_block" style="display:none">
                    <input id="voice_cast_custom_model" type="text" class="text_pole" placeholder="예: eleven_v5" />
                    <div class="vc_hint">일레븐랩스 문서에 나온 model_id를 그대로 적으면 돼요. 새 모델은 태그 지원으로 간주해요 (아래 체크박스로 끌 수 있어요).</div>
                </div>
                <div class="vc_section_title">🗣️ 기본 목소리</div>
                <div class="vc_row">
                    <div id="voice_cast_load_voices" class="menu_button menu_button_icon"><i class="fa-solid fa-rotate"></i><span>목소리 목록 불러오기</span></div>
                </div>
                <div class="vc_voice_pick" title="일레븐랩스 샘플이라 크레딧이 안 들어요">
                    <span>🎧</span>
                    <select id="voice_cast_preview_voice" class="text_pole"></select>
                </div>
                <label for="voice_cast_male_voice">남자</label>
                <select id="voice_cast_male_voice" class="text_pole"></select>
                <label for="voice_cast_female_voice">여자</label>
                <select id="voice_cast_female_voice" class="text_pole"></select>
                <label for="voice_cast_unknown_voice">성별 모름 (비우면 남자 목소리)</label>
                <select id="voice_cast_unknown_voice" class="text_pole"></select>
                    </div>
                </details>
                <details class="vc_group" data-group="cast">
                    <summary class="vc_group_title">🎭 캐스트 (캐릭터별 목소리)</summary>
                    <div class="vc_group_body">
                <div id="voice_cast_bot_cast_block">
                    <div id="voice_cast_bot_cast_title" class="vc_section_title">🎭 이 봇 캐스트</div>
                    <div class="vc_hint">이 봇 채팅방에서만 쓰는 목소리예요. 새 채팅을 열어도 그대로 유지돼요. 캐릭터와 페르소나 이름은 처음 한 번 자동으로 추가되고, 고치거나 지워도 다시 생기지 않아요.</div>
                    <div id="voice_cast_bot_cast_list"></div>
                    <div class="menu_button menu_button_icon vc_cast_add" data-scope="bot"><i class="fa-solid fa-plus"></i><span>캐릭터 추가</span></div>
                </div>
                <div id="voice_cast_no_bot" class="vc_hint" style="display:none">채팅을 열면 그 봇 전용 캐스트가 여기 나와요.</div>

                <div class="vc_section_title">🌐 공통 캐스트 (모든 봇)</div>
                <div class="vc_hint">어느 봇에서나 같은 목소리를 쓸 캐릭터예요 (예: 내 페르소나는 {{user}}). 이름이 겹치면 이 봇 캐스트가 우선이에요.</div>
                <div id="voice_cast_cast_list"></div>
                <div class="menu_button menu_button_icon vc_cast_add" data-scope="global"><i class="fa-solid fa-plus"></i><span>캐릭터 추가</span></div>
                    </div>
                </details>
                <details class="vc_group" data-group="play">
                    <summary class="vc_group_title">▶️ 재생</summary>
                    <div class="vc_group_body">
                <div class="vc_row">
                    <label>🌬️ 호흡 (대사 사이 쉼)</label>
                    <div class="menu_button vc_pause_preset" data-preset="off">바로</div>
                    <div class="menu_button vc_pause_preset" data-preset="natural">자연스럽게</div>
                    <div class="menu_button vc_pause_preset" data-preset="slow">여유 있게</div>
                </div>
                <div class="vc_pause_sliders">
                    <label>같은 사람 다음 줄: <span id="voice_cast_pause_same_val"></span></label>
                    <input id="voice_cast_pause_same" type="range" min="0" max="1500" step="50" />
                    <label>말하는 사람이 바뀔 때: <span id="voice_cast_pause_change_val"></span></label>
                    <input id="voice_cast_pause_change" type="range" min="0" max="2500" step="50" />
                    <label>사이 지문만큼 더 쉬기: <span id="voice_cast_pause_narr_val"></span></label>
                    <input id="voice_cast_pause_narr" type="range" min="0" max="3" step="0.1" />
                    <label>다음 메시지로 넘어갈 때: <span id="voice_cast_pause_between_val"></span></label>
                    <input id="voice_cast_pause_between" type="range" min="0" max="4000" step="100" />
                </div>
                <div class="vc_hint">대사 사이에 쉬는 시간을 직접 맞춰요. '사이 지문만큼'은 두 대사 사이 지문이 길수록 더 쉬어요 (100% = 지문을 읽는 시간쯤).</div>
                <label class="checkbox_label"><input id="voice_cast_continue" type="checkbox" /><span>이어 듣기</span></label>
                <div class="vc_hint vc_sub">메시지가 끝나면 다음 메시지로 자동으로 넘어가요</div>
                <div class="vc_row">
                    <label for="voice_cast_continue_mode">이어 들을 메시지</label>
                    <select id="voice_cast_continue_mode" class="text_pole" style="width:auto">
                        <option value="saved">이미 만든 음성만 (크레딧 X)</option>
                        <option value="all">전부 (없으면 새로 만들기 · 크레딧 O)</option>
                    </select>
                </div>
                <div class="vc_hint">⏮ ⏭는 메시지 끝에서 누르면 이전/다음 메시지로 넘어가요. 이미 만든 음성이 있는 메시지로만 넘어가서 크레딧을 안 써요 (깡통 · 유저 메시지 모두).</div>
                <label class="checkbox_label"><input id="voice_cast_step" type="checkbox" /><span>한 줄씩 듣기</span></label>
                <div class="vc_hint vc_sub">대사 하나 끝날 때마다 멈추고 ⏭를 기다려요 · 플레이어 '1' 버튼과 같아요</div>
                <label class="checkbox_label"><input id="voice_cast_listen_on" type="checkbox" /><span>🎯 특정 캐릭터만 듣기</span></label>
                <div class="vc_hint vc_sub">이 깡통에서만 · 체크 안 한 캐릭터는 건너뛰고 크레딧도 안 써요</div>
                <div id="voice_cast_listen_list" class="vc_listen_list" style="display:none"></div>
                <label>볼륨: <span id="voice_cast_volume_val"></span></label>
                <input id="voice_cast_volume" type="range" min="0" max="1" step="0.05" />
                <label>재생 속도: <span id="voice_cast_rate_val"></span></label>
                <input id="voice_cast_rate" type="range" min="0.7" max="1.5" step="0.05" />
                <div class="vc_row">
                    <label for="voice_cast_translation_wait">자동 재생 시 번역 기다리기 (초, 0=안 기다림)</label>
                    <input id="voice_cast_translation_wait" type="number" class="text_pole" min="0" max="60" step="1" style="width:70px" />
                </div>
                <div class="vc_row">
                    <label for="voice_cast_concurrency">동시 생성 개수</label>
                    <input id="voice_cast_concurrency" type="number" class="text_pole" min="1" max="5" step="1" style="width:60px" />
                </div>
                    </div>
                </details>
                <details class="vc_group" data-group="view">
                    <summary class="vc_group_title">🎨 화면</summary>
                    <div class="vc_group_body">
                <label class="checkbox_label" title="입력창 위에 작은 손잡이가 생겨요. 위로 밀거나 누르면 플레이어가 올라와요."><input id="voice_cast_player" type="checkbox" /><span>🎧 하단 플레이어</span></label>
                <div class="vc_hint vc_sub">입력창 위 짧은 선을 위로 밀거나 눌러서 열어요</div>
                <label class="checkbox_label" title="메시지 … 메뉴를 열지 않아도 🔊(재생)과 📜(대본) 버튼이 메시지에 바로 보여요."><input id="voice_cast_quick" type="checkbox" /><span>🔊 📜 버튼 메시지에 바로 보이기</span></label>
                <label class="checkbox_label"><input id="voice_cast_highlight" type="checkbox" /><span>읽는 대사 채팅에 형광펜 표시</span></label>
                    </div>
                </details>
                <details class="vc_group" data-group="acting">
                    <summary class="vc_group_title">🧠 대사 분류 · 연기</summary>
                    <div class="vc_group_body">
                <label class="checkbox_label"><input id="voice_cast_thoughts" type="checkbox" /><span>속마음(*별표*)도 읽기</span></label>
                <div class="vc_row">
                    <label for="voice_cast_voice_lang">🌐 음성 언어</label>
                    <select id="voice_cast_voice_lang" class="text_pole" style="width:auto">
                        <option value="display">화면에 보이는 대로 (번역본 우선)</option>
                        <option value="original">원문 그대로 (번역 무시)</option>
                        <option value="translate">AI가 번역해서 읽기</option>
                    </select>
                </div>
                <div id="voice_cast_translate_block" class="vc_row" style="display:none">
                    <label for="voice_cast_translate_pick">번역할 언어</label>
                    <select id="voice_cast_translate_pick" class="text_pole" style="width:auto">
                        <option value="English">English · 영어</option>
                        <option value="Japanese">Japanese · 일본어</option>
                        <option value="Korean">Korean · 한국어</option>
                        <option value="Chinese">Chinese · 중국어</option>
                        <option value="French">French · 프랑스어</option>
                        <option value="Spanish">Spanish · 스페인어</option>
                        <option value="German">German · 독일어</option>
                        <option value="__custom__">✏️ 직접 입력</option>
                    </select>
                    <input id="voice_cast_translate_to" type="text" class="text_pole" style="width:140px; display:none" placeholder="예: Italian" />
                </div>
                <div class="vc_hint">원문/번역은 메시지마다 따로 저장돼서 왔다 갔다 해도 다시 만들지 않아요. 요술봉(🪄) 메뉴에서도 바로 바꿀 수 있어요.</div>
                <div class="vc_section_title">🧠 대사 분류 AI</div>
                <div class="vc_hint">비워두면 지금 연결된 메인 API를 써요. 싼 모델 프로필을 따로 골라두는 걸 추천!</div>
                <select id="voice_cast_profile" class="text_pole"></select>
                <label class="checkbox_label"><input id="voice_cast_solo" type="checkbox" /><span id="voice_cast_solo_label">이 봇은 1인 모드</span></label>
                <div class="vc_hint vc_sub">👤 AI 분류 없이 따옴표 대사를 전부 이 봇 목소리로 바로 읽어요 (내 메시지는 내 목소리). 기다림·비용 0. 감정 태그와 효과음은 빠지고, 조연 대사도 봇 목소리로 나와요. 봇마다 따로 기억해요.</div>
                <label class="checkbox_label"><input id="voice_cast_inline" type="checkbox" /><span>🚀 기다림 없이 바로 듣기</span></label>
                <div class="vc_hint vc_sub">분류 대기 없이 바로 재생돼요. 대신 RP 모델이 태그를 같이 써서 답장마다 토큰이 조금 늘어요.</div>
                <div class="vc_hint vc_sub">태그는 화면에 안 보이고 대본을 만든 뒤 지워져요. 모델이 빼먹은 대사만 빠른 분류로 메워요. 켠 뒤 새로 받는 답변부터 적용되고, 답변이 이상해지면 꺼주세요.</div>
                <div id="voice_cast_inline_stats" class="vc_hint vc_sub"></div>
                <label class="checkbox_label"><input id="voice_cast_fast" type="checkbox" /><span>⚡ 빠른 분류</span></label>
                <div class="vc_hint vc_sub">따옴표 대사를 확장이 먼저 뽑고, AI는 누가·어떤 감정인지만 짧게 답해요. 훨씬 빨라요. 속마음 읽기를 켜면 *별표* 구간도 AI가 속마음인지 지문인지 골라요. 따옴표·별표가 없거나 'AI 번역해서 읽기'를 켜면 원래 방식으로 해요.</div>
                <div class="vc_row">
                    <label for="voice_cast_max_tokens">최대 응답 토큰</label>
                    <input id="voice_cast_max_tokens" type="number" class="text_pole" min="256" max="16000" step="128" style="width:90px" />
                </div>
                <div class="vc_row">
                    <label for="voice_cast_context_chars">이전 메시지 참고 길이 (글자, 0=안 씀)</label>
                    <input id="voice_cast_context_chars" type="number" class="text_pole" min="0" max="10000" step="100" style="width:90px" />
                </div>
                <div class="vc_row">
                    <label for="voice_cast_emotion">🎭 감정 연기 강도</label>
                    <select id="voice_cast_emotion" class="text_pole" style="width:auto">
                        <option value="subtle">은은하게</option>
                        <option value="natural">자연스럽게 (기본)</option>
                        <option value="strong">과감하게</option>
                    </select>
                </div>
                <div class="vc_hint">감정 폭을 따로 안 정한 캐릭터의 기본값이에요 (은은하게 2 · 자연스럽게 3 · 과감하게 5). 캐릭터마다 성격·감정 폭은 캐스트 줄의 🎚에서 정해요. 새로 분류하는 대사부터 적용돼요.</div>
                <label for="voice_cast_extra">추가 지시 (선택, 영어 권장)</label>
                <textarea id="voice_cast_extra" class="text_pole" rows="2" placeholder="e.g. Lines in 「」 are phone calls."></textarea>
                <label class="checkbox_label"><input id="voice_cast_use_tags" type="checkbox" /><span>감정 태그로 연기시키기</span></label>
                <div class="vc_hint vc_sub">[angry] 같은 태그 · v3/v4 전용</div>
                <div class="vc_row">
                    <label for="voice_cast_thought_tag">속마음에 붙일 태그</label>
                    <input id="voice_cast_thought_tag" type="text" class="text_pole" style="width:120px" placeholder="whispering" />
                </div>
                <label>Stability: <span id="voice_cast_stability_val"></span></label>
                <input id="voice_cast_stability" type="range" min="0" max="1" step="0.05" />
                <label>Similarity: <span id="voice_cast_similarity_val"></span></label>
                <input id="voice_cast_similarity" type="range" min="0" max="1" step="0.05" />
                    </div>
                </details>
                <details class="vc_group" data-group="sfx">
                    <summary class="vc_group_title">🔔 효과음</summary>
                    <div class="vc_group_body">
                <label class="checkbox_label"><input id="voice_cast_sfx" type="checkbox" /><span>효과음 넣기</span></label>
                <div class="vc_hint vc_sub">지문의 문 쾅, 발소리 같은 소리를 대본에 따로 한 줄로 넣어요</div>
                <label class="checkbox_label"><input id="voice_cast_sfx_overlay" type="checkbox" /><span>효과음을 대사랑 겹쳐서 재생</span></label>
                <div class="vc_hint vc_sub">효과음이 따로 차례를 기다리지 않고 대사 밑에 깔려요</div>
                <label class="checkbox_label"><input id="voice_cast_sfx_adult" type="checkbox" /><span>🔞 성인 장면 효과음도 넣기</span></label>
                <div class="vc_hint vc_sub">키스·젖은 소리·살 부딪히는 소리 같은 것도 효과음 줄로 넣어요. 소리 파일은 아래 '내 효과음'에 직접 넣고 영어 단어(kiss, wet, slap, slurp …)를 붙인 뒤 🔞 버튼을 켜주세요. 🔞 켠 소리는 이 옵션이 켜져 있을 때만 나와요. 한 메시지에 최대 8개까지 넣어요. 분류 AI나 ElevenLabs가 거절하면 안 나올 수 있어요.</div>
                <label class="checkbox_label"><input id="voice_cast_sfx_local" type="checkbox" /><span>내장 효과음 파일 먼저 쓰기</span></label>
                <div class="vc_hint vc_sub">문, 발소리, 총소리, 천둥 등 47개 소리가 들어 있어요. 크레딧을 안 쓰고 어느 모델에서나 나와요.</div>
                <div class="vc_hint">내장 소리에 맞는 게 없으면 ElevenLabs [태그]로 만들어요. 이건 Eleven v3 / v4 / v4 Turbo처럼 [태그]를 아는 모델에서만 나와요. 효과음은 대사와 섞지 않고 대본에 🔔 효과음 줄로 따로 들어가서, 편집기에서 고치거나 지울 수 있어요. 켠 뒤 새로 분류하는 메시지부터 들어가요.</div>
                <div class="vc_custom_sfx">
                    <div class="vc_row vc_custom_sfx_head" style="flex-wrap:wrap;gap:4px">
                        <b>🎧 내 효과음</b>
                        <div style="display:flex;flex-wrap:wrap;gap:4px;justify-content:flex-end">
                            <div id="voice_cast_custom_sfx_add" class="menu_button menu_button_icon" title="내 기기의 소리 파일을 추가해요"><i class="fa-solid fa-plus"></i><span>파일 추가</span></div>
                            <div id="voice_cast_custom_sfx_import" class="menu_button menu_button_icon" title="효과음 팩 파일(.json)을 불러와요 — 소리·단어·🔞 설정이 한 번에 들어가요"><i class="fa-solid fa-file-import"></i><span>팩 불러오기</span></div>
                            <div id="voice_cast_custom_sfx_export" class="menu_button menu_button_icon" title="내 효과음 전부를 팩 파일 하나로 저장해요 — 다른 기기에서 불러오기로 옮길 수 있어요"><i class="fa-solid fa-file-export"></i><span>팩 내보내기</span></div>
                        </div>
                        <input id="voice_cast_custom_sfx_file" type="file" accept="audio/*" multiple hidden />
                        <input id="voice_cast_custom_sfx_pack" type="file" accept=".json,application/json" hidden />
                    </div>
                    <div class="vc_hint">내장 소리보다 먼저 써요. 오른쪽 칸에 이 소리가 나올 <b>영어 단어</b>를 쉼표로 적어주세요 (예: phone ring, ringtone). 🔞를 켜면 성인 효과음이 켜져 있을 때만 나오고, 🔁를 켜면 그 메시지 대사가 끝날 때까지 작게 반복돼요. 파일은 이 브라우저에만 저장돼요. 다른 기기(폰 등)로 옮길 땐 <b>팩 내보내기</b>로 파일 하나를 만들어서 거기서 <b>팩 불러오기</b> 하면 소리·단어·🔞 설정이 한 번에 들어가요.</div>
                    <div id="voice_cast_custom_sfx_list" class="vc_custom_sfx_list"></div>
                </div>
                <label for="voice_cast_sfx_voice">효과음에 쓸 목소리 (비우면 '성별 모름' 목소리)</label>
                <select id="voice_cast_sfx_voice" class="text_pole"></select>
                    </div>
                </details>
                <details class="vc_group" data-group="store">
                    <summary class="vc_group_title">💾 저장된 음성 · 설정 옮기기</summary>
                    <div class="vc_group_body">
                <div class="vc_hint">한 번 만든 음성은 이 브라우저에 저장돼서 다시 들을 땐 크레딧을 안 써요. 용량을 넘으면 오래된 것부터 지워져요.</div>
                <div class="vc_row">
                    <label for="voice_cast_cache_mb">최대 용량 (MB)</label>
                    <input id="voice_cast_cache_mb" type="number" class="text_pole" min="10" max="5000" step="10" style="width:90px" />
                </div>
                <div class="vc_row">
                    <span id="voice_cast_cache_stats" class="vc_hint"></span>
                    <div id="voice_cast_saved_list" class="menu_button menu_button_icon"><i class="fa-solid fa-list"></i><span>이 채팅 음성 목록</span></div>
                    <div id="voice_cast_all_list" class="menu_button menu_button_icon"><i class="fa-solid fa-folder-open"></i><span>모든 봇 음성 · ⭐</span></div>
                    <div id="voice_cast_cache_clear" class="menu_button menu_button_icon"><i class="fa-solid fa-broom"></i><span>전부 지우기</span></div>
                </div>
                <div class="vc_section_title">📦 설정 옮기기</div>
                <div class="vc_hint">캐스트(봇별·공통), 기본 목소리, 분류·연기 설정을 파일 하나로 저장하고 다른 기기에서 불러와요. API 키는 들어가지 않아요.</div>
                <div class="vc_row">
                    <div id="voice_cast_export" class="menu_button menu_button_icon"><i class="fa-solid fa-file-export"></i><span>내보내기</span></div>
                    <div id="voice_cast_import" class="menu_button menu_button_icon"><i class="fa-solid fa-file-import"></i><span>가져오기</span></div>
                    <input id="voice_cast_import_file" type="file" accept=".json,application/json" style="display:none" />
                </div>
                    </div>
                </details>
            </div>
        </div>
    </div>`;
}

function bindSettingsUI() {
    const s = getSettings();
    const ctx = SillyTavern.getContext();

    const bindCheck = (id, key) => {
        $(id).prop('checked', !!s[key]).on('change', function () {
            s[key] = $(this).prop('checked');
            save();
        });
    };
    const bindNumber = (id, key) => {
        $(id).val(s[key]).on('change', function () {
            const v = Number($(this).val());
            s[key] = Number.isFinite(v) ? v : defaultSettings[key];
            save();
        });
    };
    const bindRange = (id, key, fmt) => {
        const $out = $(`${id}_val`);
        $(id).val(s[key]);
        $out.text(fmt(s[key]));
        $(id).on('input', function () {
            s[key] = Number($(this).val());
            $out.text(fmt(s[key]));
            save();
        });
    };
    const pct = v => `${Math.round(Number(v) * 100)}%`;

    bindCheck('#voice_cast_enabled', 'enabled');
    $('#voice_cast_enabled').on('change', applyPlayerSetting);
    syncListeningUI();
    updateGenerationUI();
    $('#voice_cast_listening_mode').on('change', function () {
        stopPlayback();
        generationEpoch++;
        for (const cancel of generationQueues) cancel();
        setListeningMode(String($(this).val()), false);
        syncListeningUI();
        refreshLineButtons({ rebuild: true });
    });
    $('#voice_cast_precreate').on('change', function () {
        generationEpoch++;
        for (const cancel of generationQueues) cancel();
        setListeningMode(listeningMode(), !!this.checked);
        syncListeningUI();
        refreshLineButtons({ rebuild: true });
    });
    $('#voice_cast_generation_toggle').on('click', () => {
        if (generationPaused) resumeGeneration();
        else stopGeneration();
    });
    bindCheck('#voice_cast_quick', 'quickButtons');
    bindCheck('#voice_cast_player', 'player');
    $('#voice_cast_player').on('change', applyPlayerSetting);
    bindCheck('#voice_cast_line_btns', 'lineButtons');
    bindCheck('#voice_cast_hold', 'holdToPlay');
    $('#voice_cast_hold').on('change', () => { refreshLineButtons({ rebuild: true }); $('body').toggleClass('vc_hold_on', !!getSettings().holdToPlay); });
    $('body').toggleClass('vc_hold_on', !!s.holdToPlay);
    $('#voice_cast_line_btns').on('change', () => refreshLineButtons());
    $('#voice_cast_saved_list').on('click', openSavedList);
    $('#voice_cast_all_list').on('click', () => openAllVoices());
    $('#voice_cast_quick').on('change', applyQuickButtons);
    bindCheck('#voice_cast_thoughts', 'includeThoughts');
    const syncLangUI = () => {
        $('#voice_cast_voice_lang').val(s.voiceLang);
        $('#voice_cast_translate_block').toggle(s.voiceLang === 'translate');
        updateWandItem();
    };
    const LANG_PRESETS = ['English', 'Japanese', 'Korean', 'Chinese', 'French', 'Spanish', 'German'];
    const syncTranslatePick = () => {
        const preset = LANG_PRESETS.find(l => l.toLowerCase() === String(s.translateTo || '').trim().toLowerCase());
        $('#voice_cast_translate_pick').val(preset ?? '__custom__');
        $('#voice_cast_translate_to').val(s.translateTo).toggle(!preset);
    };
    syncTranslatePick();
    $('#voice_cast_translate_pick').on('change', function () {
        const v = String($(this).val());
        if (v === '__custom__') {
            $('#voice_cast_translate_to').val('').show().trigger('focus');
            return;
        }
        s.translateTo = v;
        $('#voice_cast_translate_to').val(v).hide();
        save();
        updateWandItem();
    });
    syncLangUI();
    $('#voice_cast_voice_lang').on('change', function () {
        s.voiceLang = String($(this).val());
        save();
        syncLangUI();
    });
    $('#voice_cast_translate_to').on('change', function () {
        s.translateTo = String($(this).val() ?? '').trim() || 'English';
        $(this).val(s.translateTo);
        save();
        updateWandItem();
    });
    bindCheck('#voice_cast_use_tags', 'useTags');
    bindCheck('#voice_cast_highlight', 'highlight');
    bindNumber('#voice_cast_translation_wait', 'translationWaitSec');
    bindNumber('#voice_cast_max_tokens', 'maxTokens');
    bindNumber('#voice_cast_context_chars', 'contextChars');
    bindCheck('#voice_cast_fast', 'fastClassify');
    bindCheck('#voice_cast_inline', 'inlineTags');
    renderInlineStats();
    $('#voice_cast_inline, #voice_cast_enabled, #voice_cast_thoughts').on('change', () => setTimeout(updateInlinePrompt, 0));
    $('#voice_cast_solo').on('change', function () { setSolo(!!this.checked); });
    updateSoloUI();
    bindNumber('#voice_cast_concurrency', 'concurrency');
    bindRange('#voice_cast_stability', 'stability', pct);
    bindRange('#voice_cast_similarity', 'similarity', pct);
    bindRange('#voice_cast_volume', 'volume', pct);
    bindRange('#voice_cast_rate', 'rate', v => `${Number(v).toFixed(2).replace(/0$/, '')}배`);
    $('#voice_cast_rate').on('input', function () { if (currentAudio) currentAudio.playbackRate = Number($(this).val()) || 1; });
    // remember which setting groups are open
    $('#voice_cast_settings .vc_group').each(function () {
        this.open = (s.openGroups ?? []).includes(this.dataset.group);
    }).on('toggle', function () {
        const set = new Set(s.openGroups ?? []);
        if (this.open) set.add(this.dataset.group); else set.delete(this.dataset.group);
        s.openGroups = [...set];
        save();
    });
    const pauseFields = [
        ['#voice_cast_pause_same', 'pauseSame', v => (v ? `${(v / 1000).toFixed(2).replace(/0$/, '')}초` : '안 쉼')],
        ['#voice_cast_pause_change', 'pauseChange', v => (v ? `${(v / 1000).toFixed(2).replace(/0$/, '')}초` : '안 쉼')],
        ['#voice_cast_pause_narr', 'pauseNarr', v => (v ? `${Math.round(v * 100)}%` : '안 씀')],
        ['#voice_cast_pause_between', 'pauseBetween', v => (v ? `${(v / 1000).toFixed(1)}초` : '바로')],
    ];
    const syncPause = () => {
        for (const [id, key, fmt] of pauseFields) {
            $(id).val(s[key]);
            $(`${id}_val`).text(fmt(Number(s[key]) || 0));
        }
    };
    for (const [id, key, fmt] of pauseFields) {
        $(id).on('input', function () {
            s[key] = Number($(this).val());
            $(`${id}_val`).text(fmt(s[key]));
            save();
        });
    }
    $('.vc_pause_preset').on('click', function () {
        const p = PACING[$(this).data('preset')];
        Object.assign(s, p ? { pauseSame: p.same, pauseChange: p.change, pauseNarr: p.perChar / 12, pauseBetween: p.between } : { pauseSame: 0, pauseChange: 0, pauseNarr: 0, pauseBetween: 600 });
        save();
        syncPause();
    });
    syncPause();
    bindCheck('#voice_cast_continue', 'continuePlay');
    bindCheck('#voice_cast_step', 'stepMode');
    $('#voice_cast_listen_on').on('change', function () {
        const st = listenState(true);
        if (!st) return;
        st.on = !!this.checked;
        save();
        renderListenList();
        refreshLineButtons({ rebuild: true });
    });
    renderListenList();
    $('#voice_cast_step').on('change', updatePlayer);
    $('#voice_cast_continue_mode').val(s.continueMode).on('change', function () {
        s.continueMode = String($(this).val());
        save();
    });

    $('#voice_cast_emotion').val(s.emotionLevel).on('change', function () {
        s.emotionLevel = String($(this).val());
        save();
    });
    $('#voice_cast_extra').val(s.extraInstructions).on('input', function () {
        s.extraInstructions = String($(this).val());
        save();
    });
    $('#voice_cast_thought_tag').val(s.thoughtTag).on('input', function () {
        s.thoughtTag = String($(this).val()).replace(/[[\]]/g, '').trim();
        save();
    });
    // Model: preset list or a custom-typed model_id (so new models work without an update)
    const $model = $('#voice_cast_model');
    const $customBlock = $('#voice_cast_custom_model_block');
    const $customInput = $('#voice_cast_custom_model');
    if (isPresetModel(s.model)) {
        $model.val(s.model);
    } else {
        $model.val('__custom__');
        $customInput.val(s.model);
        $customBlock.show();
    }
    $model.on('change', function () {
        const v = String($(this).val());
        if (v === '__custom__') {
            $customBlock.show();
            const typed = String($customInput.val() ?? '').trim();
            if (typed) { s.model = typed; save(); }
            $customInput.trigger('focus');
        } else {
            $customBlock.hide();
            s.model = v;
            save();
        }
    });
    $customInput.on('input', function () {
        const typed = String($(this).val() ?? '').trim();
        if (typed) { s.model = typed; save(); }
    });

    // Audio cache
    bindNumber('#voice_cast_cache_mb', 'audioCacheMB');
    const refreshCacheStats = async () => {
        const { count, mb } = await cacheStats();
        $('#voice_cast_cache_stats').text(`저장된 음성 ${count}개 · ${mb.toFixed(1)}MB`);
    };
    refreshCacheStats();
    $('#voice_cast_settings .inline-drawer-toggle').on('click', () => { refreshCacheStats(); renderListenList(); });
    $('#voice_cast_cache_clear').on('click', async () => {
        const ok = await ctx.Popup.show.confirm('MultiCast TTS', '저장된 음성을 전부 지울까요? ⭐ 즐겨찾기한 음성은 남겨요. 다시 들으면 새로 생성돼요(크레딧 사용).');
        if (!ok) return;
        await clearAudioCache();
        refreshCacheStats();
        toastr.success('저장된 음성을 지웠어요.', 'MultiCast TTS');
    });

    // Connection profile dropdown
    try {
        ctx.ConnectionManagerRequestService.handleDropdown(
            '#voice_cast_profile',
            s.profileId,
            (profile) => {
                s.profileId = profile?.id ?? '';
                save();
            },
        );
        const $first = $('#voice_cast_profile option[value=""]');
        $first.text('(현재 메인 API 사용)');
    } catch (e) {
        console.warn(LOG, 'Connection Manager unavailable:', e);
        $('#voice_cast_profile').html('<option value="">(Connection Manager 꺼짐 — 메인 API 사용)</option>').prop('disabled', true);
        s.profileId = '';
    }

    // Default voices
    $('#voice_cast_male_voice').on('change', function () { s.maleVoiceId = String($(this).val()); save(); });
    $('#voice_cast_female_voice').on('change', function () { s.femaleVoiceId = String($(this).val()); save(); });
    $('#voice_cast_unknown_voice').on('change', function () { s.unknownVoiceId = String($(this).val()); save(); });
    $('#voice_cast_sfx_voice').on('change', function () { s.sfxVoiceId = String($(this).val()); save(); });
    bindCustomSfxUI();
    $('#voice_cast_sfx_local').prop('checked', s.sfxLocal !== false).on('change', function () { s.sfxLocal = !!this.checked; save(); });
    bindCheck('#voice_cast_sfx_overlay', 'sfxOverlay');
    bindCheck('#voice_cast_sfx_adult', 'adultSfx');
    $('#voice_cast_sfx_adult').on('change', () => setTimeout(updateInlinePrompt, 0));
    $('#voice_cast_sfx').prop('checked', !!s.sfxEnabled).on('change', function () { setSfx($(this).prop('checked')); });
    $('#voice_cast_load_voices').on('click', () => loadVoices(true).catch(() => {}));
    $('#voice_cast_check').on('click', checkConnection);

    // Cast list (delegated)
    // Cast lists (bot + shared), delegated
    const rowRef = (el) => {
        const $row = $(el).closest('.vc_cast_row');
        return { list: castArray(String($row.data('scope'))), i: Number($row.data('index')), scope: String($row.data('scope')) };
    };
    $('#voice_cast_settings')
        .on('click', '.vc_cast_add', function () {
            castArray(String($(this).data('scope'))).push({ names: '', gender: 'u', voiceId: '' });
            save();
            renderCastList();
            $(`#voice_cast_${$(this).data('scope') === 'bot' ? 'bot_cast_list' : 'cast_list'} .vc_cast_names`).last().trigger('focus');
        })
        .on('input', '.vc_cast_names', function () {
            const { list, i } = rowRef(this);
            if (list?.[i]) { list[i].names = String($(this).val()); save(); }
        })
        .on('change', '.vc_cast_gender', function () {
            const { list, i } = rowRef(this);
            if (list?.[i]) { list[i].gender = String($(this).val()); save(); }
        })
        .on('change', '.vc_cast_voice', function () {
            const { list, i } = rowRef(this);
            if (list?.[i]) { list[i].voiceId = String($(this).val()); save(); }
        })
        .on('click', '.vc_cast_delete', function () {
            const { list, i } = rowRef(this);
            if (!list?.[i]) return;
            list.splice(i, 1);
            openAdv.clear();
            save();
            renderCastList();
        })
        .on('click', '.vc_cast_adv_toggle', function () {
            const { i, scope } = rowRef(this);
            openCastAdvPopup(scope, i);
        });
    $('#voice_cast_settings')
        .on('click', '.vc_cast_move', function () {
            const { list, i, scope } = rowRef(this);
            if (!list?.[i]) return;
            const target = castArray(scope === 'bot' ? 'global' : 'bot');
            if (!target) return;
            target.push(list.splice(i, 1)[0]);
            openAdv.clear();
            save();
            renderCastList();
        });

    $('#voice_cast_stop').on('click', stopPlayback);
    $('#voice_cast_export').on('click', exportSettings);
    $('#voice_cast_import').on('click', () => $('#voice_cast_import_file').val('').trigger('click'));
    $('#voice_cast_import_file').on('change', function () {
        const file = this.files?.[0];
        if (file) importSettings(file);
    });
    $('#voice_cast_show_script').on('click', showLastScript);
    foldLongHints();
}

/**
 * Long grey explanations fold behind a small ⓘ next to the setting they explain (tap to open/close).
 * Short ones and live status lines (they have an id) stay as they are.
 */
function foldLongHints() {
    $('#voice_cast_settings .vc_hint').each(function () {
        if (this.id || this.dataset.vcFold || $(this).closest('.vc_cast_row, .vc_custom_sfx_list, .vc_listen_list').length) return;
        if ((this.textContent || '').trim().length < 40) return;
        this.dataset.vcFold = '1';
        this.hidden = true;
        const hint = this;
        const $i = $('<span class="vc_info fa-solid fa-circle-info" role="button" tabindex="0" title="설명 보기"></span>');
        $i.on('click keydown', (e) => {
            if (e.type === 'keydown' && e.key !== 'Enter' && e.key !== ' ') return;
            e.preventDefault();   // inside a <label>: don't flip the checkbox
            e.stopPropagation();
            hint.hidden = !hint.hidden;
            $i.toggleClass('vc_on', !hint.hidden);
        });
        let prev = this.previousElementSibling;
        if (prev?.matches('.vc_hint') && !prev.dataset.vcFold && prev.previousElementSibling?.matches('label, .checkbox_label')) prev = prev.previousElementSibling;
        if (prev && (prev.matches('label, .checkbox_label, .vc_row, .vc_section_title') )) {
            const $label = prev.matches('.checkbox_label') ? $(prev).find('span').first() : $(prev);
            $label.append(' ', $i);
        } else {
            $(this).before($('<div class="vc_info_row"></div>').append($i, ' <span class="vc_hint">설명</span>'));
        }
    });
}

/** Handlers for the per-character settings panel (lives in its own window). */
function bindCastAdvHandlers($root) {
    const rowRef = (el) => {
        const $row = $(el).closest('.vc_cast_row');
        return { list: castArray(String($row.data('scope'))), i: Number($row.data('index')), scope: String($row.data('scope')) };
    };
    $root
        .on('change', '.vc_cast_temper', function () {
            const { list, i } = rowRef(this);
            if (!list?.[i]) return;
            const v = String($(this).val() ?? '');
            if (v) list[i].temper = v; else delete list[i].temper;
            save();
            renderCastList();
        })
        .on('change', '.vc_cast_range', function () {
            const { list, i } = rowRef(this);
            if (!list?.[i]) return;
            const v = Number($(this).val());
            if (v >= 1 && v <= 5) list[i].range = v; else delete list[i].range;
            save();
            renderCastList();
        })
        .on('change', '.vc_cast_always', function () {
            const { list, i } = rowRef(this);
            if (!list?.[i]) return;
            const v = String($(this).val() ?? '').split(',').map(t => t.trim().replace(/^\[|\]$/g, '')).filter(Boolean).join(', ');
            if (v) list[i].alwaysTags = v; else delete list[i].alwaysTags;
            $(this).val(v);
            save();
        })
        .on('change', '.vc_cast_note', function () {
            const { list, i } = rowRef(this);
            if (!list?.[i]) return;
            const v = String($(this).val() ?? '').trim();
            if (v) list[i].actingNote = v; else delete list[i].actingNote;
            save();
        })
        .on('input change', '.vc_cast_color', function () {
            const { list, i } = rowRef(this);
            if (!list?.[i]) return;
            list[i].color = String($(this).val());
            $(this).removeClass('vc_color_unset');
            $(this).closest('.vc_cast_row').find('.vc_cast_adv_toggle').addClass('vc_custom');
            save();
        })
        .on('click', '.vc_cast_color_reset', function () {
            const { list, i } = rowRef(this);
            if (!list?.[i]) return;
            delete list[i].color;
            save();
            renderCastList();
        })
        .on('input', '.vc_cast_rate', function () {
            const { list, i } = rowRef(this);
            if (!list?.[i]) return;
            const v = Number($(this).val());
            list[i].rate = v;
            const $row = $(this).closest('.vc_cast_row');
            $row.find('.vc_cast_rate_val').text(`${v.toFixed(2).replace(/0$/, '')}배`);
            $row.find('.vc_cast_adv_toggle').addClass('vc_custom');
            save();
        })
        .on('input', '.vc_cast_vol', function () {
            const { list, i } = rowRef(this);
            if (!list?.[i]) return;
            const v = Number($(this).val());
            list[i].volume = v;
            const $row = $(this).closest('.vc_cast_row');
            $row.find('.vc_cast_vol_val').text(`${Math.round(v * 100)}%`);
            $row.find('.vc_cast_adv_toggle').addClass('vc_custom');
            save();
        })
        .on('input', '.vc_cast_stab, .vc_cast_sim', function () {
            const { list, i } = rowRef(this);
            if (!list?.[i]) return;
            const isStab = $(this).hasClass('vc_cast_stab');
            const v = Number($(this).val());
            list[i][isStab ? 'stability' : 'similarity'] = v;
            const $row = $(this).closest('.vc_cast_row');
            $row.find(isStab ? '.vc_cast_stab_val' : '.vc_cast_sim_val').text(`${Math.round(v * 100)}%`);
            $row.find('.vc_cast_adv_toggle').addClass('vc_custom');
            save();
        })
        .on('click', '.vc_cast_adv_reset', function () {
            const { list, i } = rowRef(this);
            if (!list?.[i]) return;
            delete list[i].stability;
            delete list[i].similarity;
            delete list[i].volume;
            delete list[i].rate;
            delete list[i].temper;
            delete list[i].range;
            delete list[i].actingNote;
            delete list[i].alwaysTags;
            delete list[i].color;
            save();
            renderCastList();
        })
        ;
}

// ---------------------------------------------------------------------------
// Slash commands
// ---------------------------------------------------------------------------

function registerCommands() {
    const { SlashCommandParser, SlashCommand, SlashCommandArgument, SlashCommandNamedArgument, ARGUMENT_TYPE } = SillyTavern.getContext();
    if (!SlashCommandParser || !SlashCommand) return;

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'voicecast',
        aliases: ['multicast'],
        callback: async (args, value) => {
            const chat = SillyTavern.getContext().chat;
            const raw = String(value ?? '').trim();
            const id = raw === '' ? chat.length - 1 : Number(raw);
            if (!Number.isInteger(id) || !chat[id]) {
                toastr.warning('메시지 번호가 올바르지 않아요.', 'MultiCast TTS');
                return '';
            }
            await playMessage(id, { force: String(args?.force) === 'true' });
            return '';
        },
        namedArgumentList: SlashCommandNamedArgument ? [
            SlashCommandNamedArgument.fromProps({
                name: 'force',
                description: 'true면 대사를 다시 분류',
                typeList: ARGUMENT_TYPE ? [ARGUMENT_TYPE.BOOLEAN] : undefined,
                defaultValue: 'false',
            }),
        ] : [],
        unnamedArgumentList: SlashCommandArgument ? [
            SlashCommandArgument.fromProps({
                description: '메시지 번호 (비우면 마지막 메시지)',
                typeList: ARGUMENT_TYPE ? [ARGUMENT_TYPE.NUMBER] : undefined,
                isRequired: false,
            }),
        ] : [],
        helpString: '<div>MultiCast TTS로 메시지를 멀티보이스로 읽어요. 예: <code>/voicecast</code>, <code>/voicecast 12</code>, <code>/voicecast force=true</code></div>',
    }));

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'voicecast-list',
        aliases: ['multicast-list'],
        callback: async () => { await openSavedList(); return ''; },
        helpString: '<div>이 채팅에서 만든 대사 음성 목록을 열어요.</div>',
    }));

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'voicecast-save',
        aliases: ['multicast-save'],
        callback: async (_args, value) => {
            const chat = SillyTavern.getContext().chat;
            const words = String(value ?? '').trim().split(/\s+/).filter(Boolean);
            const kind = words.some(w => /^(wav|mix|그대로)$/i.test(w)) ? 'wav' : 'mp3';
            const num = words.find(w => /^\d+$/.test(w));
            const id = num === undefined ? chat.length - 1 : Number(num);
            if (!Number.isInteger(id) || !chat[id]) return '';
            await downloadMessageAudio(id, null, { kind });
            return '';
        },
        helpString: '<div>메시지 대사 전체를 파일 하나로 저장해요. 기본은 mp3(대사만 이어 붙임), <code>wav</code>를 붙이면 들리는 그대로(쉼·겹친 효과음·🔁 반복 포함). 예: <code>/voicecast-save</code>, <code>/voicecast-save 12</code>, <code>/voicecast-save 12 wav</code></div>',
    }));

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'voicecast-lang',
        aliases: ['multicast-lang'],
        callback: (_args, value) => {
            const v = String(value ?? '').trim().toLowerCase();
            const map = { display: 'display', screen: 'display', '화면': 'display', original: 'original', '원문': 'original', translate: 'translate', '번역': 'translate' };
            if (!v) cycleVoiceLang();
            else if (map[v]) setVoiceLang(map[v]);
            else { getSettings().translateTo = String(value).trim(); setVoiceLang('translate'); syncTranslateUI(); }
            return voiceLangLabel();
        },
        helpString: '<div>음성 언어 바꾸기. <code>/voicecast-lang</code> (순서대로 전환), <code>/voicecast-lang 원문</code>, <code>/voicecast-lang 화면</code>, <code>/voicecast-lang English</code> (그 언어로 AI 번역)</div>',
    }));

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'voicecast-stop',
        aliases: ['multicast-stop'],
        callback: () => { stopPlayback(); return ''; },
        helpString: '<div>MultiCast TTS 재생을 멈춰요.</div>',
    }));
}

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Public API for other extensions: window.MultiCastTTS (apiVersion 1)
// Keep its shape stable — other extensions depend on it. Add things; don't rename or remove.
// ---------------------------------------------------------------------------

const API_VERSION = 1;
const apiListeners = new Map(); // type -> Set(fn)
const autoHolds = new Set();    // reasons another extension holds auto play (e.g. 'call')
const quickActions = new Map(); // id -> { id, icon, label, hint, run }
let apiActive = false;
let apiMessageId = null;
let apiIdleTimer = null;

function emitApi(type, detail) {
    try { document.dispatchEvent(new CustomEvent(`multicast:${type}`, { detail })); } catch { /* ignore */ }
    for (const fn of apiListeners.get(type) ?? []) {
        try { fn(detail); } catch (e) { console.warn(LOG, `listener for ${type} failed`, e); }
    }
}

function apiSetPlaying(messageId) {
    clearTimeout(apiIdleTimer);
    apiMessageId = messageId ?? null;
    if (apiActive) return;
    apiActive = true;
    emitApi('playstart', { messageId: apiMessageId });
}

function apiSetIdle(reason) {
    clearTimeout(apiIdleTimer);
    if (!apiActive) return;
    apiActive = false;
    const messageId = apiMessageId;
    apiMessageId = null;
    emitApi('playend', { messageId, reason });
}

/** A short grace so going on to the next message (이어 듣기) doesn't flicker end → start. */
function apiSetIdleSoon(reason) {
    clearTimeout(apiIdleTimer);
    apiIdleTimer = setTimeout(() => {
        if (playingMessageId === null && !(currentAudio && !currentAudio.paused)) apiSetIdle(reason);
    }, 1200);
}

function apiCastEntry(e, scope, botKey) {
    const names = String(e.names ?? '').split(',').map(n => n.trim()).filter(Boolean)
        .map(n => (n.toLowerCase() === '{{user}}' ? (SillyTavern.getContext().name1 || n) : n));
    return {
        id: e.id,
        name: names[0] ?? '',
        aliases: names.slice(1),
        gender: e.gender === 'm' || e.gender === 'f' ? e.gender : 'u',
        voiceId: e.voiceId || '',
        voiceName: e.voiceId ? voiceName(e.voiceId) : '',
        alwaysTags: String(e.alwaysTags ?? '').split(',').map(t => t.trim().replace(/^\[|\]$/g, '')).filter(Boolean),
        actingNote: String(e.actingNote ?? ''),
        isUser: !!e.autoUser || names.some(n => n === SillyTavern.getContext().name1),
        scope,
        botKey: botKey ?? null,
    };
}

window.MultiCastTTS = Object.freeze({
    apiVersion: API_VERSION,
    /** true while MultiCast is playing (a message, a single line, or between lines of the same message). */
    isPlaying: () => apiActive,
    /** message id being played, or null */
    playingMessageId: () => apiMessageId,
    /** Stop whatever MultiCast is playing. */
    stop: () => stopPlayback(),
    /** Hold auto play / 이어 듣기 until released (e.g. during a call). Reasons stack; nothing already playing is stopped. */
    holdAutoPlay: (reason = 'external') => { autoHolds.add(String(reason)); },
    releaseAutoPlay: (reason = 'external') => { autoHolds.delete(String(reason)); },
    isAutoPlayHeld: () => autoHolds.size > 0,
    /**
     * Cast rows with stable ids. scope: 'current' (this bot + shared, default) or 'all' (every bot + shared).
     * Returns plain copies — changing them changes nothing in MultiCast.
     */
    getCast: ({ scope = 'current' } = {}) => {
        const s = getSettings();
        const out = [];
        if (scope === 'all') {
            for (const [key, list] of Object.entries(s.castByBot ?? {})) for (const e of list ?? []) out.push(apiCastEntry(e, 'bot', key));
        } else {
            const bot = currentBot();
            for (const e of getBotCast() ?? []) out.push(apiCastEntry(e, 'bot', bot?.key));
        }
        for (const e of s.cast ?? []) out.push(apiCastEntry(e, 'global', null));
        return out.filter(e => e.id && e.name);
    },
    /** Listen: 'playstart' { messageId } · 'playend' { messageId, reason: 'done' | 'stopped' | 'error' }. Also fired on document as 'multicast:<type>'. */
    on: (type, fn) => {
        if (typeof fn !== 'function') return;
        if (!apiListeners.has(type)) apiListeners.set(type, new Set());
        apiListeners.get(type).add(fn);
    },
    off: (type, fn) => { apiListeners.get(type)?.delete(fn); },
    /** Add a row to MultiCast's 요술봉 quick menu, e.g. { id: 'phone', icon: 'fa-mobile-screen', label: '📱 폰 열기', run() {} }. Same id replaces. */
    addQuickAction: (action) => {
        if (!action || !action.id || typeof action.run !== 'function') return false;
        const icon = /^fa-[a-z0-9-]+$/.test(String(action.icon ?? '')) ? action.icon : 'fa-puzzle-piece';
        quickActions.set(String(action.id), { id: String(action.id), icon, label: String(action.label ?? action.id), hint: String(action.hint ?? ''), run: action.run });
        return true;
    },
    removeQuickAction: (id) => quickActions.delete(String(id)),
});

jQuery(async () => {
    const { eventSource, event_types } = SillyTavern.getContext();
    getSettings();

    $('#extensions_settings2').append(settingsHtml());
    bindSettingsUI();
    renderVoiceSelects();
    addDefaultPreviewButtons();

    injectButtons();
    applyQuickButtons();
    buildPlayer();
    loadIndex(); // so ⏮/⏭ know right away which messages already have audio
    watchChatForLineButtons();
    refreshLineButtons();
    setupHoldToPlay();
    // capture phase: a ▶ inside a translator's <summary> must not fold/unfold it
    document.addEventListener('click', (e) => {
        const btn = e.target?.closest?.(`.${LINE_BTN}`);
        if (!btn) return;
        e.preventDefault();
        e.stopPropagation();
        const messageId = Number(btn.closest('.mes')?.getAttribute('mesid'));
        if (!Number.isNaN(messageId)) playScriptLine(messageId, Number(btn.dataset.line));
    }, true);
    $(document).on('click', '.vc_play_btn', onButtonClick);
    $(document).on('click', '.vc_edit_btn', onEditButtonClick);
    $(document).on('click', '.vc_skip', (e) => { e.stopPropagation(); skipLine(Number($(e.currentTarget).data('d')) || 1); });
    $(document).on('click', '.vc_status', (e) => { e.stopPropagation(); stopPlayback(); });

    eventSource.on(event_types.CHARACTER_MESSAGE_RENDERED, onCharacterMessageRendered);
    // the instruction depends on several settings (효과음, 성인, 내 효과음…) → refresh it right before each reply
    if (event_types.GENERATION_STARTED) eventSource.on(event_types.GENERATION_STARTED, updateInlinePrompt);
    eventSource.on(event_types.CHAT_CHANGED, () => {
        stopPlayback();
        setTimeout(injectButtons, 100);
        setTimeout(markAllScriptButtons, 400);
        ensureBotCast();
        renderCastList();
        updateSoloUI();
        updateInlinePrompt();
        setTimeout(() => document.querySelectorAll('#chat .mes .mes_text').forEach(hideVoiceTagText), 300);
        // the bot's linked persona can be applied right after this event
        setTimeout(() => { ensureBotCast(); renderCastList(); renderListenList(); }, 800);
    });
    if (event_types.PERSONA_CHANGED) {
        eventSource.on(event_types.PERSONA_CHANGED, () => { ensureBotCast(); renderCastList(); });
    }
    eventSource.on(event_types.MORE_MESSAGES_LOADED, injectButtons);
    eventSource.on(event_types.MESSAGE_SWIPED, (id) => { if (playingMessageId === Number(id)) stopPlayback(); });
    eventSource.on(event_types.APP_READY, () => { loadVoices(false).catch(() => {}); addWandItem(); });
    addWandItem();
    // Reload voices when the ElevenLabs key is set/changed from the key button
    for (const ev of [event_types.SECRET_WRITTEN, event_types.SECRET_ROTATED, event_types.SECRET_DELETED]) {
        if (!ev) continue;
        eventSource.on(ev, (key) => {
            if (key === 'api_key_elevenlabs') loadVoices(ev === event_types.SECRET_WRITTEN).catch(() => {});
        });
    }

    try {
        registerCommands();
    } catch (e) {
        console.warn(LOG, 'slash command registration failed', e);
    }

    console.log(LOG, 'loaded');
    // other extensions loaded earlier can wait for this (window.MultiCastTTS is already there)
    emitApi('ready', { apiVersion: API_VERSION });
});
