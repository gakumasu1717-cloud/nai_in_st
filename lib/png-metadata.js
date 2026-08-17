/**
 * NaiStudio - PNG 메타데이터 파서
 *
 * 지원하는 소스:
 *  1. NovelAI  : tEXt/iTXt 청크의 Software / Description / Comment
 *  2. NovelAI  : stealth alpha-LSB (tEXt가 제거된 이미지용, stealth_pnginfo / stealth_pngcomp)
 *  3. A1111    : tEXt "parameters"
 *  4. ComfyUI  : tEXt "prompt" / "workflow" (프롬프트 텍스트만 최대한 회수)
 *
 * 최종 산출물은 NaiStudio 내부 포맷(normalized)으로 통일한다.
 */

const PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];

function bytesToText(bytes) {
    try {
        return new TextDecoder('utf-8').decode(bytes);
    } catch (_) {
        return Array.from(bytes).map(b => String.fromCharCode(b)).join('');
    }
}

function bytesToLatin1(bytes) {
    let out = '';
    for (let i = 0; i < bytes.length; i++) out += String.fromCharCode(bytes[i]);
    return out;
}

/** DecompressionStream으로 zlib/gzip 해제. 실패하면 null. */
async function decompress(bytes, format) {
    if (typeof DecompressionStream === 'undefined') return null;
    for (const fmt of (format ? [format] : ['deflate', 'deflate-raw', 'gzip'])) {
        try {
            const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream(fmt));
            const buffer = await new Response(stream).arrayBuffer();
            return new Uint8Array(buffer);
        } catch (_) { /* 다음 포맷 시도 */ }
    }
    return null;
}

export function isPng(arrayBuffer) {
    const bytes = new Uint8Array(arrayBuffer);
    return PNG_SIGNATURE.every((v, i) => bytes[i] === v);
}

/**
 * PNG의 모든 텍스트 청크를 { keyword: value } 로 반환.
 */
export async function readPngTextChunks(arrayBuffer) {
    const result = {};
    if (!isPng(arrayBuffer)) return result;

    const bytes = new Uint8Array(arrayBuffer);
    const view = new DataView(arrayBuffer);
    let offset = 8;

    while (offset + 8 <= bytes.length) {
        const length = view.getUint32(offset);
        const type = bytesToText(bytes.slice(offset + 4, offset + 8));
        const dataStart = offset + 8;
        const dataEnd = dataStart + length;
        if (dataEnd + 4 > bytes.length) break;

        const data = bytes.slice(dataStart, dataEnd);

        if (type === 'tEXt') {
            const nul = data.indexOf(0);
            if (nul > 0) {
                result[bytesToLatin1(data.slice(0, nul))] = bytesToText(data.slice(nul + 1));
            }
        } else if (type === 'zTXt') {
            const nul = data.indexOf(0);
            if (nul > 0) {
                const keyword = bytesToLatin1(data.slice(0, nul));
                const inflated = await decompress(data.slice(nul + 2));
                if (inflated) result[keyword] = bytesToText(inflated);
            }
        } else if (type === 'iTXt') {
            const nul = data.indexOf(0);
            if (nul > 0) {
                const keyword = bytesToLatin1(data.slice(0, nul));
                const compressed = data[nul + 1] === 1;
                // language tag \0 translated keyword \0 text
                let cursor = nul + 3;
                let seen = 0;
                while (cursor < data.length && seen < 2) {
                    if (data[cursor] === 0) seen++;
                    cursor++;
                }
                const payload = data.slice(cursor);
                if (compressed) {
                    const inflated = await decompress(payload);
                    if (inflated) result[keyword] = bytesToText(inflated);
                } else {
                    result[keyword] = bytesToText(payload);
                }
            }
        } else if (type === 'IEND') {
            break;
        }

        offset = dataEnd + 4;
    }

    return result;
}

/**
 * NAI stealth 메타데이터(알파 채널 LSB) 추출.
 * tEXt가 제거된 이미지(디스코드/트위터 경유 등)에서도 회수 가능.
 */
export async function readStealthMetadata(blob) {
    try {
        const bitmap = await createImageBitmap(blob);
        const canvas = document.createElement('canvas');
        canvas.width = bitmap.width;
        canvas.height = bitmap.height;
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        ctx.drawImage(bitmap, 0, 0);
        bitmap.close?.();

        const { data, width, height } = ctx.getImageData(0, 0, canvas.width, canvas.height);

        // 알파가 전부 255면 stealth 데이터가 있을 수 없다.
        let hasVariedAlpha = false;
        for (let i = 3; i < data.length; i += 4) {
            if (data[i] !== 255) { hasVariedAlpha = true; break; }
        }
        if (!hasVariedAlpha) return null;

        // column-major 로 알파 LSB 수집
        const totalBits = width * height;
        const bits = new Uint8Array(totalBits);
        let bitIndex = 0;
        for (let x = 0; x < width; x++) {
            for (let y = 0; y < height; y++) {
                bits[bitIndex++] = data[(y * width + x) * 4 + 3] & 1;
            }
        }

        const readBytes = (start, count) => {
            const out = new Uint8Array(count);
            for (let i = 0; i < count; i++) {
                let byte = 0;
                for (let b = 0; b < 8; b++) {
                    byte = (byte << 1) | (bits[start + i * 8 + b] ?? 0);
                }
                out[i] = byte;
            }
            return out;
        };

        const magicCandidates = ['stealth_pngcomp', 'stealth_pnginfo'];
        const header = bytesToLatin1(readBytes(0, 20));
        const magic = magicCandidates.find(m => header.startsWith(m));
        if (!magic) return null;

        let cursor = magic.length * 8;
        let lengthBits = 0;
        for (let i = 0; i < 32; i++) lengthBits = (lengthBits << 1) | (bits[cursor + i] ?? 0);
        cursor += 32;

        const byteCount = Math.floor(lengthBits / 8);
        if (byteCount <= 0 || cursor + lengthBits > totalBits) return null;

        const payload = readBytes(cursor, byteCount);
        const text = magic === 'stealth_pngcomp'
            ? bytesToText((await decompress(payload, 'gzip')) ?? payload)
            : bytesToText(payload);

        try {
            return JSON.parse(text);
        } catch (_) {
            return { Comment: text };
        }
    } catch (error) {
        console.debug('[NaiStudio] stealth 메타데이터 추출 실패:', error);
        return null;
    }
}

/** NAI Source 문자열 → ST가 쓰는 모델 id 추정 */
export function guessNaiModel(source) {
    const value = String(source ?? '').toLowerCase();
    if (!value) return '';
    if (value.includes('v4.5') || value.includes('v4_5') || value.includes('4-5')) {
        return value.includes('curated') ? 'nai-diffusion-4-5-curated' : 'nai-diffusion-4-5-full';
    }
    if (value.includes('v4') || value.includes('4-full')) {
        return value.includes('curated') ? 'nai-diffusion-4-curated-preview' : 'nai-diffusion-4-full';
    }
    if (value.includes('furry')) return 'nai-diffusion-furry-3';
    if (value.includes('v3') || value.includes('xl')) return 'nai-diffusion-3';
    return '';
}

function normalizeCenter(center) {
    const x = Number(center?.x);
    const y = Number(center?.y);
    if (Number.isNaN(x) || Number.isNaN(y)) return { x: 0.5, y: 0.5 };
    return {
        x: Math.min(0.9, Math.max(0.1, x)),
        y: Math.min(0.9, Math.max(0.1, y)),
    };
}

/** NAI Comment JSON → normalized */
function fromNaiComment(comment, chunks) {
    const charCaptions = comment?.v4_prompt?.caption?.char_captions ?? [];
    const negCaptions = comment?.v4_negative_prompt?.caption?.char_captions ?? [];

    const characters = charCaptions.map((item, index) => ({
        prompt: String(item?.char_caption ?? '').trim(),
        uc: String(negCaptions[index]?.char_caption ?? '').trim(),
        center: normalizeCenter(item?.centers?.[0]),
        enabled: true,
    })).filter(item => item.prompt);

    const basePrompt = comment?.v4_prompt?.caption?.base_caption
        ?? comment?.prompt
        ?? chunks?.Description
        ?? '';

    return {
        found: true,
        kind: 'novelai',
        prompt: String(basePrompt).trim(),
        negative: String(comment?.v4_negative_prompt?.caption?.base_caption ?? comment?.uc ?? '').trim(),
        model: guessNaiModel(chunks?.Source || chunks?.Software),
        steps: Number(comment?.steps) || undefined,
        scale: Number(comment?.scale) || undefined,
        cfg_rescale: typeof comment?.cfg_rescale === 'number' ? comment.cfg_rescale : undefined,
        sampler: comment?.sampler || undefined,
        scheduler: comment?.noise_schedule || undefined,
        seed: comment?.seed !== undefined ? String(comment.seed) : '',
        width: Number(comment?.width) || undefined,
        height: Number(comment?.height) || undefined,
        sm: !!comment?.sm,
        sm_dyn: !!comment?.sm_dyn,
        variety_boost: comment?.skip_cfg_above_sigma !== null && comment?.skip_cfg_above_sigma !== undefined,
        decrisper: !!comment?.dynamic_thresholding,
        characters,
        raw: comment,
    };
}

/** A1111 "parameters" 텍스트 → normalized */
function fromA1111(text) {
    const value = String(text ?? '');
    const negIndex = value.search(/\nNegative prompt:/i);
    const settingsIndex = value.search(/\n(Steps:|Sampler:)/i);

    const prompt = value.slice(0, negIndex >= 0 ? negIndex : (settingsIndex >= 0 ? settingsIndex : value.length)).trim();
    const negative = negIndex >= 0
        ? value.slice(negIndex + '\nNegative prompt:'.length, settingsIndex >= 0 ? settingsIndex : value.length).trim()
        : '';
    const settings = settingsIndex >= 0 ? value.slice(settingsIndex) : '';

    const pick = (key) => settings.match(new RegExp(`${key}:\\s*([^,\\n]+)`, 'i'))?.[1]?.trim();
    const size = pick('Size')?.split('x').map(Number) ?? [];

    return {
        found: true,
        kind: 'a1111',
        prompt,
        negative,
        model: '',
        steps: Number(pick('Steps')) || undefined,
        scale: Number(pick('CFG scale')) || undefined,
        sampler: pick('Sampler') || undefined,
        seed: pick('Seed') || '',
        width: size[0] || undefined,
        height: size[1] || undefined,
        characters: [],
        raw: { parameters: value },
    };
}

/** ComfyUI workflow JSON에서 텍스트 노드만 회수 */
function fromComfy(text) {
    const collected = [];
    try {
        const json = JSON.parse(text);
        const walk = (node) => {
            if (!node || typeof node !== 'object') return;
            for (const [key, value] of Object.entries(node)) {
                if (typeof value === 'string' && value.length > 8 && /,|\bgirl\b|\bboy\b/i.test(value)) {
                    collected.push(value);
                } else if (typeof value === 'object') {
                    walk(value);
                }
                void key;
            }
        };
        walk(json);
    } catch (_) { /* noop */ }

    return {
        found: collected.length > 0,
        kind: 'comfy',
        prompt: collected[0] ?? '',
        negative: collected[1] ?? '',
        characters: [],
        raw: { comfy: text.slice(0, 4000) },
    };
}

const EMPTY_RESULT = {
    found: false,
    kind: 'unknown',
    prompt: '',
    negative: '',
    characters: [],
    seed: '',
    raw: null,
};

/**
 * 파일/Blob 하나에서 최대한 메타데이터를 뽑아 normalized 형태로 반환.
 * @param {Blob} blob
 */
export async function extractImageMetadata(blob) {
    const arrayBuffer = await blob.arrayBuffer();
    const png = isPng(arrayBuffer);
    const chunks = await readPngTextChunks(arrayBuffer);

    // 왜 못 읽었는지 사용자에게 알려주기 위한 진단 정보
    const diagnostics = {
        mime: blob.type || '(알 수 없음)',
        size: blob.size,
        isPng: png,
        chunkKeys: Object.keys(chunks),
        stealthChecked: false,
    };

    // 1) NAI tEXt
    if (chunks.Comment) {
        try {
            return { ...fromNaiComment(JSON.parse(chunks.Comment), chunks), diagnostics };
        } catch (_) {
            // Comment가 JSON이 아니면 Description만이라도 사용
            if (chunks.Description) {
                return { ...EMPTY_RESULT, found: true, kind: 'novelai', prompt: chunks.Description.trim(), raw: chunks, diagnostics };
            }
        }
    }

    // 2) A1111 / ComfyUI
    if (chunks.parameters) return { ...fromA1111(chunks.parameters), diagnostics };
    if (chunks.prompt || chunks.workflow) {
        const comfy = fromComfy(chunks.prompt || chunks.workflow);
        if (comfy.found) return { ...comfy, diagnostics };
    }

    // 3) stealth (알파 LSB)
    diagnostics.stealthChecked = true;
    const stealth = await readStealthMetadata(blob);
    if (stealth) {
        if (stealth.Comment) {
            try {
                return { ...fromNaiComment(JSON.parse(stealth.Comment), stealth), diagnostics };
            } catch (_) {
                return { ...EMPTY_RESULT, found: true, kind: 'novelai', prompt: String(stealth.Comment).trim(), raw: stealth, diagnostics };
            }
        }
        if (stealth.Description) {
            return { ...EMPTY_RESULT, found: true, kind: 'novelai', prompt: String(stealth.Description).trim(), raw: stealth, diagnostics };
        }
    }

    return { ...EMPTY_RESULT, raw: chunks, diagnostics };
}
