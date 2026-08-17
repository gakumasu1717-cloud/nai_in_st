/**
 * NaiStudio - 프롬프트 헬퍼
 *
 *  - 태그 정규화  : 중복 제거, 공백/콤마 정리
 *  - 가중치       : NAI v4 (1.1::tag::) / v3 ({tag}, [tag]) 양쪽 지원
 */

/** 태그 문자열 → 배열 */
export function splitTags(text) {
    return String(text ?? '')
        .split(',')
        .map(t => t.trim())
        .filter(Boolean);
}

/** 배열 → 태그 문자열 */
export function joinTags(tags) {
    return tags.filter(Boolean).join(', ');
}

/** 중복 제거 + 공백 정리. 순서는 첫 등장 기준 유지. */
export function normalizeTags(text) {
    const seen = new Set();
    const out = [];
    for (const tag of splitTags(text)) {
        const key = tag.toLowerCase().replace(/\s+/g, ' ');
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(tag.replace(/\s+/g, ' '));
    }
    return joinTags(out);
}

/** 두 프롬프트 병합 (뒤쪽이 앞쪽의 중복 태그를 덮어쓰지 않고 스킵) */
export function mergePrompts(base, extra) {
    return normalizeTags(`${base ?? ''}, ${extra ?? ''}`);
}

/** base에서 remove에 있는 태그를 제거 */
export function subtractPrompt(base, remove) {
    const removeSet = new Set(splitTags(remove).map(t => t.toLowerCase()));
    return joinTags(splitTags(base).filter(t => !removeSet.has(t.toLowerCase())));
}

/** 생성 직전 최종 정리 */
export function resolvePrompt(text, { normalize = true } = {}) {
    return normalize ? normalizeTags(text) : String(text ?? '').trim();
}

const V4_WEIGHT = /^(\d+(?:\.\d+)?)::([\s\S]*)::$/;

/**
 * 선택한 태그의 가중치를 step 만큼 조정한다.
 * v4 계열이면 `1.1::tag::`, 그 외에는 `{tag}` / `[tag]` 문법을 쓴다.
 */
export function adjustWeight(selection, step, isV4) {
    const text = String(selection ?? '').trim();
    if (!text) return text;

    if (isV4) {
        const match = text.match(V4_WEIGHT);
        const current = match ? Number(match[1]) : 1.0;
        const inner = match ? match[2] : text;
        const next = Math.round((current + step) * 100) / 100;
        if (Math.abs(next - 1) < 0.005) return inner;
        return `${next}::${inner}::`;
    }

    // v3: {} 는 1.05배 강화, [] 는 약화
    if (step > 0) {
        if (text.startsWith('[') && text.endsWith(']')) return text.slice(1, -1);
        return `{${text}}`;
    }
    if (text.startsWith('{') && text.endsWith('}')) return text.slice(1, -1);
    return `[${text}]`;
}

/** 캐럿 위치의 태그(콤마 기준) 범위를 구한다. */
export function getTagRangeAtCaret(value, caret) {
    const text = String(value ?? '');
    let start = text.lastIndexOf(',', Math.max(0, caret - 1)) + 1;
    let end = text.indexOf(',', caret);
    if (end === -1) end = text.length;
    while (start < end && /\s/.test(text[start])) start++;
    while (end > start && /\s/.test(text[end - 1])) end--;
    return { start, end, text: text.slice(start, end) };
}

/** 자주 쓰는 danbooru 태그 (자동완성 시드) */
export const BASE_TAGS = [
    '1girl', '1boy', '2girls', '2boys', '1girl 1boy', 'solo', 'multiple girls',
    'masterpiece', 'best quality', 'very aesthetic', 'absurdres', 'highres', 'official art',
    'looking at viewer', 'looking away', 'looking back', 'looking down', 'eye contact',
    'smile', 'grin', 'light smile', 'open mouth', 'closed mouth', 'blush', 'sad', 'angry',
    'crying', 'tears', 'surprised', 'embarrassed', 'seductive smile', 'expressionless',
    'long hair', 'short hair', 'medium hair', 'very long hair', 'twintails', 'ponytail',
    'braid', 'side ponytail', 'hair bun', 'messy hair', 'bangs', 'blunt bangs', 'ahoge',
    'black hair', 'blonde hair', 'brown hair', 'white hair', 'silver hair', 'red hair',
    'blue hair', 'pink hair', 'purple hair', 'green hair', 'grey hair', 'multicolored hair',
    'blue eyes', 'red eyes', 'green eyes', 'brown eyes', 'purple eyes', 'yellow eyes',
    'golden eyes', 'heterochromia', 'closed eyes', 'half-closed eyes', 'glowing eyes',
    'school uniform', 'serafuku', 'blazer', 'sweater', 'hoodie', 'shirt', 'white shirt',
    'dress', 'sundress', 'long dress', 'maid', 'apron', 'kimono', 'hanbok', 'suit',
    'jacket', 'coat', 'skirt', 'pleated skirt', 'shorts', 'jeans', 'thighhighs',
    'pantyhose', 'socks', 'gloves', 'necktie', 'ribbon', 'hair ribbon', 'hairband',
    'glasses', 'hat', 'beret', 'cape', 'armor', 'swimsuit', 'bikini', 'casual',
    'standing', 'sitting', 'lying', 'on back', 'kneeling', 'walking', 'running',
    'arms crossed', 'hands on hips', 'hand on own face', 'waving', 'stretching',
    'holding', 'holding cup', 'holding book', 'holding phone', 'holding weapon',
    'hug', 'hugging', 'head tilt', 'leaning forward', 'looking over shoulder',
    'upper body', 'cowboy shot', 'full body', 'portrait', 'close-up', 'from above',
    'from below', 'from side', 'dutch angle', 'wide shot', 'depth of field',
    'indoors', 'outdoors', 'classroom', 'bedroom', 'kitchen', 'cafe', 'library',
    'street', 'city', 'rooftop', 'forest', 'beach', 'ocean', 'mountain', 'garden',
    'night', 'day', 'sunset', 'sunrise', 'rain', 'snow', 'cloudy', 'starry sky',
    'cherry blossoms', 'simple background', 'white background', 'gradient background',
    'blurry background', 'scenery', 'detailed background',
    'cinematic lighting', 'soft lighting', 'backlighting', 'rim light', 'god rays',
    'dramatic shadow', 'volumetric lighting', 'lens flare', 'bloom',
    'watercolor', 'oil painting', 'sketch', 'lineart', 'monochrome', 'greyscale',
    'flat color', 'cel shading', 'pastel colors', 'vibrant colors', 'muted colors',
    'anime screencap', 'retro artstyle', 'pixel art', 'chibi', 'realistic',
];

/** 기본 UC 프리셋 */
export const UC_PRESETS = {
    'Heavy (v4)': 'blurry, lowres, error, film grain, scan artifacts, worst quality, bad quality, jpeg artifacts, very displeasing, chromatic aberration, halftone, multiple views, logo, too many watermarks, negative space, blank page',
    'Light (v4)': 'blurry, lowres, error, worst quality, bad quality, jpeg artifacts, very displeasing, logo, watermark',
    'Heavy (v3)': 'lowres, {bad}, error, fewer, extra, missing, worst quality, jpeg artifacts, bad quality, watermark, unfinished, displeasing, chromatic aberration, signature, extra digits, artistic error, username, scan, [abstract]',
    'Anatomy focus': 'bad anatomy, bad hands, extra digits, fewer digits, missing fingers, extra arms, extra legs, deformed, mutated hands, long neck',
    'None': '',
};

/** 해상도 프리셋 (NAI 기준) */
export const SIZE_PRESETS = [
    { label: 'Portrait 832x1216', width: 832, height: 1216 },
    { label: 'Landscape 1216x832', width: 1216, height: 832 },
    { label: 'Square 1024x1024', width: 1024, height: 1024 },
    { label: 'Portrait L 1024x1536', width: 1024, height: 1536 },
    { label: 'Landscape L 1536x1024', width: 1536, height: 1024 },
    { label: 'Square L 1472x1472', width: 1472, height: 1472 },
    { label: 'Small 512x768', width: 512, height: 768 },
];

export const SAMPLERS = [
    'k_euler_ancestral', 'k_euler', 'k_dpmpp_2m', 'k_dpmpp_2m_sde',
    'k_dpmpp_sde', 'k_dpmpp_2s_ancestral', 'k_dpm_2', 'k_dpm_fast', 'ddim_v3',
];

export const SCHEDULERS = ['karras', 'native', 'exponential', 'polyexponential'];

export const MODELS = [
    { id: 'nai-diffusion-4-5-full', label: 'NAI v4.5 Full' },
    { id: 'nai-diffusion-4-5-curated', label: 'NAI v4.5 Curated' },
    { id: 'nai-diffusion-4-full', label: 'NAI v4 Full' },
    { id: 'nai-diffusion-4-curated-preview', label: 'NAI v4 Curated' },
    { id: 'nai-diffusion-3', label: 'NAI v3 (Anime)' },
    { id: 'nai-diffusion-furry-3', label: 'NAI Furry v3' },
];

export function isV4Model(model) {
    return typeof model === 'string' && model.includes('nai-diffusion-4');
}
