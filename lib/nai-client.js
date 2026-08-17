/**
 * NaiStudio - 이미지 생성 클라이언트
 *
 * 백엔드 3단 폴백:
 *   1) naistudio 서버 플러그인 : 캐릭터 프롬프트 + 바이브 + 레퍼런스 + cfg_rescale 전부 지원
 *   2) autopic 서버 플러그인     : 위와 거의 동일 (AutoPic 사용자용 호환 경로)
 *   3) ST 기본 /api/novelai      : 기본 파라미터만. 캐릭터 프롬프트/바이브는 무시된다.
 *
 * 404가 뜬 백엔드는 "없음"으로 캐싱하고 다음 단계로 내려간다.
 */

import { getRequestHeaders, getContext, stUtils } from './st.js';
import { isV4Model } from './prompt-tools.js';

export const BACKEND = {
    OWN: 'naistudio',
    AUTOPIC: 'autopic',
    NATIVE: 'native',
};

const ENDPOINTS = {
    [BACKEND.OWN]: '/api/plugins/naistudio/generate-image',
    [BACKEND.AUTOPIC]: '/api/plugins/autopic/generate-image',
    [BACKEND.NATIVE]: '/api/novelai/generate-image',
};

const availability = {
    [BACKEND.OWN]: null,     // null = 미확인, true/false = 확인됨
    [BACKEND.AUTOPIC]: null,
    [BACKEND.NATIVE]: true,
};

export function getBackendAvailability() {
    return { ...availability };
}

export function resetBackendAvailability() {
    availability[BACKEND.OWN] = null;
    availability[BACKEND.AUTOPIC] = null;
}

/** 자체 플러그인 설치 여부 확인 (설정 화면 표시용) */
export async function pingOwnPlugin() {
    // 개명 전 폴더(plugins/stylestudio)로 설치해둔 경우도 인식한다
    for (const id of ['naistudio', 'stylestudio']) {
        try {
            const response = await fetch(`/api/plugins/${id}/ping`, { headers: getRequestHeaders() });
            if (!response.ok) continue;

            ENDPOINTS[BACKEND.OWN] = `/api/plugins/${id}/generate-image`;
            availability[BACKEND.OWN] = true;
            return true;
        } catch (_) { /* 다음 후보 */ }
    }

    availability[BACKEND.OWN] = false;
    return false;
}

/**
 * AutoPic 서버 플러그인 설치 여부 확인.
 *
 * generate-image 로 찌르면 진짜 생성이 돌아가 과금되므로, 부작용이 없는
 * /favorite-vibe 를 빈 body로 호출한다. AutoPic 쪽 구현은 image가 없으면
 * 아무것도 바꾸지 않고 400 JSON을 반환한다. 404면 플러그인이 없는 것.
 *
 * 단, /favorite-vibe 가 없는 구버전 AutoPic 도 404를 주므로 그때는
 * '없음'이 아니라 '알 수 없음'(null)으로 남겨 생성 시 폴백에 맡긴다.
 */
export async function probeAutopicPlugin() {
    try {
        const response = await fetch('/api/plugins/autopic/favorite-vibe', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({}),
        });

        if (response.status === 404) {
            availability[BACKEND.AUTOPIC] = null;   // 구버전일 수 있어 단정하지 않는다
            return null;
        }

        availability[BACKEND.AUTOPIC] = true;
        return true;
    } catch (_) {
        availability[BACKEND.AUTOPIC] = null;
        return null;
    }
}

function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
}

/**
 * NAI가 캐릭터 위치로 쓰는 5×5 격자.
 * NovelAI 공식 클라이언트는 이 다섯 값만 보낸다. 임의의 소수(0.35 등)는
 * 구조상 거부되진 않지만 검증된 입력이 아니므로 항상 여기에 스냅한다.
 */
export const CENTER_STEPS = [0.1, 0.3, 0.5, 0.7, 0.9];

/** 값 하나를 가장 가까운 격자점으로 스냅 */
export function snapCenterValue(value) {
    const number = Number(value);
    if (!Number.isFinite(number)) return 0.5;
    return CENTER_STEPS.reduce((best, step) =>
        Math.abs(step - number) < Math.abs(best - number) ? step : best, CENTER_STEPS[2]);
}

export function snapCenter(center) {
    return { x: snapCenterValue(center?.x), y: snapCenterValue(center?.y) };
}

/** 캐릭터 수에 맞춘 기본 배치 (격자점만 사용) */
const CENTER_LAYOUTS = {
    1: [2],
    2: [1, 3],
    3: [1, 2, 3],
    4: [0, 1, 3, 4],
    5: [0, 1, 2, 3, 4],
};

export function defaultCenter(index, total) {
    const layout = CENTER_LAYOUTS[Math.min(5, Math.max(1, total))] ?? CENTER_LAYOUTS[5];
    return { x: CENTER_STEPS[layout[index % layout.length]], y: 0.5 };
}

/** NAI Director Reference가 허용하는 캔버스 크기 */
const REFERENCE_CANVASES = [[1024, 1536], [1536, 1024], [1472, 1472]];

/**
 * 레퍼런스 이미지를 NAI가 받아주는 캔버스 크기로 레터박싱한다.
 * (임의 크기를 그대로 보내면 NAI가 400을 돌려준다)
 * @returns {Promise<string>} base64 (data URL 접두사 제외)
 */
export async function letterboxReference(base64) {
    try {
        const image = await new Promise((resolve, reject) => {
            const img = new Image();
            img.onload = () => resolve(img);
            img.onerror = reject;
            img.src = base64.startsWith('data:') ? base64 : `data:image/png;base64,${base64}`;
        });

        const ratio = image.width / image.height;
        const [canvasWidth, canvasHeight] = REFERENCE_CANVASES
            .slice()
            .sort((a, b) => Math.abs(a[0] / a[1] - ratio) - Math.abs(b[0] / b[1] - ratio))[0];

        if (image.width === canvasWidth && image.height === canvasHeight) return base64;

        const canvas = document.createElement('canvas');
        canvas.width = canvasWidth;
        canvas.height = canvasHeight;
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, canvasWidth, canvasHeight);

        const scale = Math.min(canvasWidth / image.width, canvasHeight / image.height);
        const drawWidth = Math.round(image.width * scale);
        const drawHeight = Math.round(image.height * scale);
        ctx.drawImage(image, (canvasWidth - drawWidth) / 2, (canvasHeight - drawHeight) / 2, drawWidth, drawHeight);

        return canvas.toDataURL('image/png').split(',')[1];
    } catch (error) {
        console.warn('[NaiStudio] 레퍼런스 레터박싱 실패, 원본 사용:', error);
        return base64;
    }
}

/**
 * 패널 상태 → 서버로 보낼 payload.
 * @param {object} state NaiStudio 생성 상태
 */
export function buildPayload(state) {
    const sources = (state.characters ?? [])
        .filter(c => c.enabled !== false && String(c.prompt ?? '').trim());

    const characters = sources.map((c, index) => ({
        prompt: String(c.prompt).trim(),
        uc: String(c.uc ?? '').trim(),
        center: snapCenter(c.center ?? defaultCenter(index, sources.length)),
        enabled: true,
    }));

    const vibes = (state.vibes ?? []).filter(v => v?.base64 && v.enabled !== false);

    const payload = {
        prompt: state.prompt ?? '',
        negative_prompt: state.negative ?? '',
        model: state.model,
        width: Number(state.width) || 832,
        height: Number(state.height) || 1216,
        steps: Number(state.steps) || 28,
        scale: Number(state.scale) || 5,
        cfg_rescale: Number(state.cfg_rescale) || 0,
        sampler: state.sampler || 'k_euler_ancestral',
        scheduler: state.scheduler || 'karras',
        seed: Number.isInteger(Number(state.seed)) && String(state.seed).trim() !== '' && Number(state.seed) >= 0
            ? Number(state.seed)
            : -1,
        sm: !!state.sm,
        sm_dyn: !!state.sm_dyn,
        decrisper: !!state.decrisper,
        variety_boost: !!state.variety_boost,
        upscale_ratio: Number(state.upscale_ratio) || 1,
        characterPrompts: characters,
        use_coords: !!state.use_coords && characters.length > 0,
    };

    if (vibes.length > 0) {
        payload.reference_image_multiple = vibes.map(v => v.base64);
        payload.reference_information_extracted_multiple = vibes.map(v => Number(v.infoExtracted ?? 1.0));
        payload.reference_strength_multiple = vibes.map(v => Number(v.strength ?? 0.6));
    }

    /* ── Director Reference: 전역 1장 + 캐릭터별 1장씩을 한 요청에 합친다 ── */
    const directorReferences = [];

    if (state.ref?.enabled && state.ref?.base64) {
        directorReferences.push({
            image: state.ref.base64,
            strength: Number(state.ref.strength ?? 1.0),
            fidelity: Number(state.ref.fidelity ?? 1.0),
            mode: state.ref.mode || 'character&style',
            charIndex: null,
        });
    }

    sources.forEach((character, index) => {
        const ref = character.ref;
        if (!ref?.base64 || ref.enabled === false) return;
        directorReferences.push({
            image: ref.base64,
            strength: Number(ref.strength ?? 1.0),
            fidelity: Number(ref.fidelity ?? 1.0),
            mode: ref.mode || 'character',
            charIndex: index,
        });
    });

    if (directorReferences.length > 0) {
        payload.director_references = directorReferences.slice(0, MAX_DIRECTOR_REFERENCES);

        // AutoPic 플러그인 폴백용 (단일 레퍼런스만 지원하므로 첫 장만 넘어간다)
        const primary = payload.director_references[0];
        payload.reference_image = primary.image;
        payload.reference_strength = primary.strength;
        payload.reference_fidelity = primary.fidelity;
        payload.reference_mode = primary.mode;
    }

    return payload;
}

/** NAI가 한 요청에서 받아주는 director reference 최대 장수 */
export const MAX_DIRECTOR_REFERENCES = 4;

/* ── Anlas(유료 크레딧) 가드 ─────────────────────────────────
 *
 * Opus 구독의 무료 생성 조건: 픽셀 수 1,048,576 이하 + steps 28 이하 + 1장.
 * 업스케일과 v4 vibe 인코딩은 별도로 Anlas를 소모한다.
 *
 * 주의: SillyTavern의 novel_anlas_guard 는 SD 확장의 클라이언트 코드에만 있고
 * 서버 엔드포인트에는 없다. NaiStudio는 SD 확장을 거치지 않으므로
 * 여기서 직접 같은 일을 해야 한다.
 */
export const FREE_TIER = {
    MAX_PIXELS: 1024 * 1024,
    MAX_STEPS: 28,
};

/** 현재 설정이 무료 생성 조건에 맞는지 검사 (강제하지 않고 알려주기만) */
export function checkAnlasCost(state) {
    const reasons = [];
    const width = Number(state.width) || 0;
    const height = Number(state.height) || 0;

    if (width * height > FREE_TIER.MAX_PIXELS) {
        reasons.push(`해상도 ${width}×${height} (무료는 ${FREE_TIER.MAX_PIXELS.toLocaleString()}픽셀 이하)`);
    }
    if (Number(state.steps) > FREE_TIER.MAX_STEPS) {
        reasons.push(`steps ${state.steps} (무료는 ${FREE_TIER.MAX_STEPS} 이하)`);
    }
    if (Number(state.upscale_ratio) > 1) {
        reasons.push('업스케일');
    }
    if (state.vibeEnabled && (state.vibes ?? []).some(v => v?.base64 && v.enabled !== false) && isV4Model(state.model)) {
        reasons.push('v4 Vibe 인코딩 (같은 이미지는 캐시되어 첫 1회만)');
    }

    return { free: reasons.length === 0, reasons };
}

/**
 * 무료 조건에 맞도록 파라미터를 낮춘다.
 * 결과를 바꿔버리는 항목(Vibe)은 건드리지 않고 경고만 남긴다.
 */
export function applyAnlasGuard(state) {
    const adjusted = { ...state };
    const notes = [];

    let width = Number(adjusted.width) || 832;
    let height = Number(adjusted.height) || 1216;

    if (width * height > FREE_TIER.MAX_PIXELS) {
        const ratio = Math.sqrt(FREE_TIER.MAX_PIXELS / (width * height));
        // NAI는 64의 배수만 받는다
        const newWidth = Math.max(64, Math.floor((width * ratio) / 64) * 64);
        const newHeight = Math.max(64, Math.floor((height * ratio) / 64) * 64);
        notes.push(`해상도 ${width}×${height} → ${newWidth}×${newHeight}`);
        width = newWidth;
        height = newHeight;
    }

    if (Number(adjusted.steps) > FREE_TIER.MAX_STEPS) {
        notes.push(`steps ${adjusted.steps} → ${FREE_TIER.MAX_STEPS}`);
        adjusted.steps = FREE_TIER.MAX_STEPS;
    }

    if (Number(adjusted.upscale_ratio) > 1) {
        notes.push('업스케일 해제');
        adjusted.upscale_ratio = 1;
    }

    adjusted.width = width;
    adjusted.height = height;

    return { state: adjusted, notes };
}

/** ST 기본 엔드포인트는 확장 필드를 못 받으므로 최소 payload로 축소 */
function toNativePayload(payload) {
    return {
        prompt: payload.prompt,
        negative_prompt: payload.negative_prompt,
        model: payload.model,
        width: payload.width,
        height: payload.height,
        steps: payload.steps,
        scale: payload.scale,
        sampler: payload.sampler,
        scheduler: payload.scheduler,
        seed: payload.seed,
        sm: payload.sm,
        sm_dyn: payload.sm_dyn,
        upscale_ratio: payload.upscale_ratio,
    };
}

async function readResponse(response) {
    const text = await response.text();
    const trimmed = text.trim();

    if (trimmed.startsWith('{')) {
        try {
            const json = JSON.parse(trimmed);
            if (json.image) return { image: json.image, seed: json.seed, warning: json.warning };
            const error = new Error(json.message || json.error || 'Unknown error');
            error.code = json.code;
            throw error;
        } catch (error) {
            if (error instanceof SyntaxError) return { image: trimmed };
            throw error;
        }
    }

    if (!trimmed) throw new Error('빈 응답을 받았습니다.');
    return { image: trimmed };
}

/**
 * 이미지 생성. 사용 가능한 백엔드를 순서대로 시도한다.
 * @returns {Promise<{image: string, seed?: string, backend: string, warning?: string}>}
 */
export async function generateImage(payload, { preferred = 'auto', onBackendChange } = {}) {
    const order = preferred !== 'auto'
        ? [preferred]
        : [BACKEND.OWN, BACKEND.AUTOPIC, BACKEND.NATIVE];

    let lastError = null;

    for (const backend of order) {
        if (availability[backend] === false && preferred === 'auto') continue;

        const body = backend === BACKEND.NATIVE ? toNativePayload(payload) : payload;

        try {
            const response = await fetch(ENDPOINTS[backend], {
                method: 'POST',
                headers: getRequestHeaders(),
                body: JSON.stringify(body),
            });

            if (response.status === 404) {
                availability[backend] = false;
                onBackendChange?.(backend, false);
                lastError = new Error(`${backend} 백엔드를 찾을 수 없습니다.`);
                continue;
            }

            availability[backend] = true;

            if (!response.ok) {
                const detail = await readResponse(response).catch(e => ({ image: '', warning: e.message }));
                const error = new Error(detail.warning || `${backend} 요청 실패 (${response.status})`);
                error.status = response.status;
                throw error;
            }

            const result = await readResponse(response);
            const headerSeed = response.headers?.get?.('X-NaiStudio-Seed')
                || response.headers?.get?.('X-AutoPic-Seed');

            return {
                image: result.image,
                seed: result.seed ?? headerSeed ?? undefined,
                warning: result.warning,
                backend,
            };
        } catch (error) {
            lastError = error;
            // 네트워크/서버 오류는 다음 백엔드로 폴백하지 않는다(중복 과금 방지).
            if (error.status && error.status !== 404) throw error;
        }
    }

    throw lastError ?? new Error('사용 가능한 이미지 생성 백엔드가 없습니다.');
}

/** 채팅이 실제로 열려 있는지 (캐릭터/그룹 선택 없이도 패널은 열 수 있다) */
export function isChatOpen() {
    try {
        const context = getContext();
        return Array.isArray(context?.chat)
            && typeof context?.addOneMessage === 'function'
            && (context.characterId !== undefined && context.characterId !== null || !!context.groupId);
    } catch (_) {
        return false;
    }
}

/**
 * base64 이미지를 ST 서버에 저장하고 경로를 반환.
 * 채팅방/캐릭터와 무관하게 항상 같은 폴더(user/images/<folder>/)에 넣는다.
 */
export async function saveImageToServer(base64, filenameHint = 'naistudio', folder = 'NaiStudio') {
    const characterName = folder;
    const filename = `${filenameHint}_${Date.now()}`;

    if (typeof stUtils?.saveBase64AsFile === 'function') {
        return await stUtils.saveBase64AsFile(base64, characterName, filename, 'png');
    }

    const response = await fetch('/api/images/upload', {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify({
            image: `data:image/png;base64,${base64}`,
            ch_name: characterName,
            filename,
        }),
    });

    if (!response.ok) throw new Error(`이미지 저장 실패 (${response.status})`);
    const data = await response.json();
    return data.path;
}

/** 생성한 이미지를 현재 채팅에 새 메시지로 삽입 */
export async function sendImageToChat(imagePath, title) {
    if (!isChatOpen()) {
        throw new Error('열려 있는 채팅이 없습니다. 캐릭터나 그룹을 먼저 선택하세요.');
    }

    const context = getContext();
    const message = {
        name: context.name2 || 'NaiStudio',
        is_user: false,
        is_system: false,
        send_date: Date.now(),
        mes: title || '[NaiStudio] 생성 이미지',
        extra: {
            image: imagePath,
            title: title || '',
            inline_image: false,
            generationType: 'naistudio',
        },
    };

    context.chat.push(message);
    context.addOneMessage(message);
    await context.saveChat();
    return message;
}

export { isV4Model };
