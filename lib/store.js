/**
 * NaiStudio - 설정/그림체 저장소
 *
 * 모든 데이터는 extension_settings['NaiStudio'] 에 들어가며 ST 설정과 함께 서버에 저장된다.
 * 썸네일은 용량 때문에 192px webp 로 강제 축소한다.
 */

import { extension_settings, saveSettingsDebounced } from './st.js';
import { UC_PRESETS } from './prompt-tools.js';

export const EXTENSION_NAME = 'NaiStudio';
export const SETTINGS_VERSION = 1;

export const DEFAULT_PARAMS = {
    model: 'nai-diffusion-4-5-full',
    width: 832,
    height: 1216,
    steps: 28,
    scale: 5,
    cfg_rescale: 0,
    sampler: 'k_euler_ancestral',
    scheduler: 'karras',
    sm: false,
    sm_dyn: false,
    variety_boost: true,
    decrisper: false,
    upscale_ratio: 1,
    use_coords: true,
};

const DEFAULT_SETTINGS = {
    version: SETTINGS_VERSION,
    backend: 'auto',            // auto | naistudio | autopic | native
    autoNormalize: true,        // 생성 시 태그 중복 제거
    anlasGuard: true,           // 무료 생성 조건(Opus)을 벗어나지 않게 파라미터를 낮춤
    autoSave: true,             // 생성 즉시 디스크에 저장
    saveFolder: 'NaiStudio',  // user/images/<이 폴더>/ — 채팅방과 무관하게 고정
    keepHistory: 40,
    collapsed: {},              // 패널 섹션 접힘 상태 (key → true)
    defaults: { ...DEFAULT_PARAMS },
    last: null,                 // 마지막 패널 상태
    styles: [],
    charPresets: [],          // 캐릭터 프롬프트 프리셋 (그림체와 별개로 저장)
    history: [],
    ucPresets: { ...UC_PRESETS },
};

const LEGACY_NAME = 'StyleStudio';

export function getSettings() {
    // 개명 이전(StyleStudio)에 저장된 설정이 있으면 그대로 옮겨온다
    if (!extension_settings[EXTENSION_NAME] && extension_settings[LEGACY_NAME]) {
        extension_settings[EXTENSION_NAME] = extension_settings[LEGACY_NAME];
        delete extension_settings[LEGACY_NAME];
        console.info('[NaiStudio] 이전 StyleStudio 설정을 이어받았습니다.');
        saveSettingsDebounced();
    }

    if (!extension_settings[EXTENSION_NAME]) {
        extension_settings[EXTENSION_NAME] = structuredClone(DEFAULT_SETTINGS);
    }

    const settings = extension_settings[EXTENSION_NAME];

    // 마이그레이션 / 누락 필드 보정
    for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
        if (settings[key] === undefined) {
            settings[key] = structuredClone(value);
        }
    }
    for (const [key, value] of Object.entries(DEFAULT_PARAMS)) {
        if (settings.defaults[key] === undefined) settings.defaults[key] = value;
    }
    // 제거된 기능의 잔재 정리 (와일드카드)
    if (settings.wildcards !== undefined) {
        delete settings.wildcards;
        saveSettingsDebounced();
    }

    if (!Array.isArray(settings.styles)) settings.styles = [];
    if (!Array.isArray(settings.charPresets)) settings.charPresets = [];
    if (!Array.isArray(settings.history)) settings.history = [];
    settings.version = SETTINGS_VERSION;

    return settings;
}

export function save() {
    saveSettingsDebounced();
}

function uid(prefix = 's') {
    return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
}

/* ── 그림체 프리셋 ───────────────────────────────────────── */

/**
 * @typedef {object} Style
 * @property {string} id
 * @property {string} name
 * @property {string} note
 * @property {string[]} tags        분류용 태그(그림체 자체의 라벨)
 * @property {string} positive      그림체 프롬프트(공통 태그)
 * @property {string} negative      전용 UC
 * @property {object} params        모델/스텝/스케일 등
 * @property {object[]} characters  캐릭터 프롬프트 (선택)
 * @property {object[]} vibes       바이브 이미지 (선택)
 * @property {object|null} ref      레퍼런스 이미지 (선택)
 * @property {string} thumb         dataURL 썸네일
 */

export function listStyles({ query = '', tag = '', favoriteOnly = false } = {}) {
    const q = query.trim().toLowerCase();
    return getSettings().styles.filter(style => {
        if (favoriteOnly && !style.favorite) return false;
        if (tag && !(style.tags ?? []).includes(tag)) return false;
        if (!q) return true;
        return [style.name ?? '', style.note ?? '', style.positive ?? '', (style.tags ?? []).join(' ')]
            .join(' ').toLowerCase().includes(q);
    });
}

export function getStyle(id) {
    return getSettings().styles.find(s => s.id === id) ?? null;
}

export function allStyleTags() {
    const tags = new Set();
    for (const style of getSettings().styles) {
        for (const tag of style.tags ?? []) tags.add(tag);
    }
    return [...tags].sort();
}

export function upsertStyle(style) {
    const settings = getSettings();
    const now = Date.now();

    // undefined 값이 기본값을 덮어써서 그림체가 깨지는 것을 막는다
    style = Object.fromEntries(Object.entries(style ?? {}).filter(([, v]) => v !== undefined));

    if (style.id) {
        const index = settings.styles.findIndex(s => s.id === style.id);
        if (index >= 0) {
            settings.styles[index] = { ...settings.styles[index], ...style, updatedAt: now };
            save();
            return settings.styles[index];
        }
    }

    const created = {
        id: uid('style'),
        name: '이름 없는 그림체',
        note: '',
        tags: [],
        positive: '',
        negative: '',
        params: {},
        characters: [],
        vibes: [],
        ref: null,
        thumb: '',
        favorite: false,
        ...style,
        createdAt: now,
        updatedAt: now,
    };

    settings.styles.unshift(created);
    save();
    return created;
}

export function deleteStyle(id) {
    const settings = getSettings();
    settings.styles = settings.styles.filter(s => s.id !== id);
    save();
}

export function duplicateStyle(id) {
    const style = getStyle(id);
    if (!style) return null;
    const copy = structuredClone(style);
    delete copy.id;
    copy.name = `${style.name} (복사본)`;
    return upsertStyle(copy);
}

export function exportStyles(ids = null) {
    const styles = getSettings().styles.filter(s => !ids || ids.includes(s.id));
    return JSON.stringify({ type: 'naistudio-styles', version: SETTINGS_VERSION, styles }, null, 2);
}

export function importStyles(json, { replace = false } = {}) {
    const parsed = typeof json === 'string' ? JSON.parse(json) : json;
    const incoming = Array.isArray(parsed) ? parsed : parsed?.styles;
    if (!Array.isArray(incoming)) throw new Error('그림체 목록을 찾을 수 없는 파일입니다.');

    const settings = getSettings();
    if (replace) settings.styles = [];

    let count = 0;
    for (const style of incoming) {
        if (!style || typeof style !== 'object') continue;
        const copy = { ...style };
        delete copy.id;
        upsertStyle(copy);
        count++;
    }

    save();
    return count;
}

/* ── 생성 히스토리 ───────────────────────────────────────── */

export function addHistory(entry) {
    const settings = getSettings();
    settings.history.unshift({ id: uid('h'), createdAt: Date.now(), ...entry });
    const limit = Number(settings.keepHistory) || 40;
    if (settings.history.length > limit) settings.history.length = limit;
    save();
}

export function clearHistory() {
    getSettings().history = [];
    save();
}

/* ── 이미지 유틸 ─────────────────────────────────────────── */

/** dataURL/base64 → 축소된 썸네일 dataURL */
export async function makeThumbnail(source, maxSize = 192) {
    const src = source.startsWith('data:') ? source : `data:image/png;base64,${source}`;
    const image = await new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = reject;
        img.src = src;
    });

    const ratio = Math.min(1, maxSize / Math.max(image.width, image.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(image.width * ratio));
    canvas.height = Math.max(1, Math.round(image.height * ratio));
    canvas.getContext('2d').drawImage(image, 0, 0, canvas.width, canvas.height);

    return canvas.toDataURL('image/webp', 0.7);
}

/** File/Blob → base64 (data URL 접두사 제거) */
export function blobToBase64(blob) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result).split(',')[1] ?? '');
        reader.onerror = reject;
        reader.readAsDataURL(blob);
    });
}

/* ── 캐릭터 프리셋 ─────────────────────────────────────────
 * 그림체(화풍)와 별개로 캐릭터 프롬프트만 따로 보관한다.
 * 그림체 A + 캐릭터 B·C 처럼 섞어 쓸 수 있게 하기 위함.
 */

/**
 * @typedef {object} CharPreset
 * @property {string} id
 * @property {string} name
 * @property {string[]} tags
 * @property {string} prompt   캐릭터 태그
 * @property {string} uc       이 캐릭터 전용 UC
 * @property {object|null} ref 캐릭터 레퍼런스 이미지
 * @property {string} thumb
 */

export function listCharPresets({ query = '', tag = '', favoriteOnly = false } = {}) {
    const q = query.trim().toLowerCase();
    return getSettings().charPresets.filter(item => {
        if (favoriteOnly && !item.favorite) return false;
        if (tag && !(item.tags ?? []).includes(tag)) return false;
        if (!q) return true;
        return [item.name ?? '', item.prompt ?? '', (item.tags ?? []).join(' ')]
            .join(' ').toLowerCase().includes(q);
    });
}

export function getCharPreset(id) {
    return getSettings().charPresets.find(item => item.id === id) ?? null;
}

export function allCharPresetTags() {
    const tags = new Set();
    for (const item of getSettings().charPresets) {
        for (const tag of item.tags ?? []) tags.add(tag);
    }
    return [...tags].sort();
}

export function upsertCharPreset(preset) {
    const settings = getSettings();
    const now = Date.now();
    preset = Object.fromEntries(Object.entries(preset ?? {}).filter(([, v]) => v !== undefined));

    if (preset.id) {
        const index = settings.charPresets.findIndex(item => item.id === preset.id);
        if (index >= 0) {
            settings.charPresets[index] = { ...settings.charPresets[index], ...preset, updatedAt: now };
            save();
            return settings.charPresets[index];
        }
    }

    const created = {
        id: uid('char'),
        name: '이름 없는 캐릭터',
        tags: [],
        prompt: '',
        uc: '',
        ref: null,
        thumb: '',
        favorite: false,
        note: '',
        ...preset,
        createdAt: now,
        updatedAt: now,
    };

    settings.charPresets.unshift(created);
    save();
    return created;
}

export function deleteCharPreset(id) {
    const settings = getSettings();
    settings.charPresets = settings.charPresets.filter(item => item.id !== id);
    save();
}

export function duplicateCharPreset(id) {
    const preset = getCharPreset(id);
    if (!preset) return null;
    const copy = structuredClone(preset);
    delete copy.id;
    copy.name = `${preset.name} (복사본)`;
    return upsertCharPreset(copy);
}

/** 그림체 + 캐릭터를 한 파일로 내보낸다 */
export function exportAll() {
    const settings = getSettings();
    return JSON.stringify({
        type: 'naistudio-library',
        version: SETTINGS_VERSION,
        styles: settings.styles,
        charPresets: settings.charPresets,
    }, null, 2);
}

export function importAll(json) {
    const parsed = typeof json === 'string' ? JSON.parse(json) : json;
    const result = { styles: 0, charPresets: 0 };

    const styles = Array.isArray(parsed) ? parsed : parsed?.styles;
    if (Array.isArray(styles)) {
        for (const style of styles) {
            if (!style || typeof style !== 'object') continue;
            const copy = { ...style };
            delete copy.id;
            upsertStyle(copy);
            result.styles++;
        }
    }

    if (Array.isArray(parsed?.charPresets)) {
        for (const preset of parsed.charPresets) {
            if (!preset || typeof preset !== 'object') continue;
            const copy = { ...preset };
            delete copy.id;
            upsertCharPreset(copy);
            result.charPresets++;
        }
    }

    save();
    return result;
}
