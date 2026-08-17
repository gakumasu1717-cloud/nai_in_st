/**
 * NaiStudio - SillyTavern 서버 플러그인
 *
 * 설치:
 *   1. 이 폴더(server-plugin)의 내용을 SillyTavern/plugins/naistudio/ 로 복사
 *   2. config.yaml 에서 enableServerPlugins: true
 *   3. ST 재시작
 *
 * 제공 라우트:
 *   GET  /api/plugins/naistudio/ping
 *   POST /api/plugins/naistudio/generate-image
 *
 * ST 기본 NovelAI 엔드포인트가 못 넘기는 것들을 여기서 처리한다:
 *   cfg_rescale, v4 character prompts(+ 개별 UC, 좌표), vibe transfer 인코딩,
 *   director reference, variety+, 시드 반환, 429 재시도, 업스케일.
 */

import fetch from 'node-fetch';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { readSecret, SECRET_KEYS } from '../../src/endpoints/secrets.js';
import { extractFileFromZipBuffer } from '../../src/util.js';

const IMAGE_NOVELAI = 'https://image.novelai.net';
const API_NOVELAI = 'https://api.novelai.net';

const REFERENCE_PIXEL_COUNT = 1011712;
const SIGMA_MAGIC_NUMBER = 19;
const SIGMA_MAGIC_NUMBER_V4_5 = 58;

const RETRY_DELAYS_MS = [1500, 3000, 5000, 8000];
const VIBE_CACHE_LIMIT = 48;
const MAX_DIRECTOR_REFERENCES = 4;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CACHE_FILE = path.join(__dirname, 'vibe-cache.json');

/** @type {Map<string, string>} sha256(model|image) → encoded vibe */
const vibeCache = new Map();

function loadCache() {
    try {
        if (!fs.existsSync(CACHE_FILE)) return;
        const raw = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf-8'));
        for (const entry of raw.entries ?? []) {
            if (entry?.key && entry?.encoded) vibeCache.set(entry.key, entry.encoded);
        }
        console.info(`[NaiStudio] vibe 캐시 ${vibeCache.size}건 로드`);
    } catch (error) {
        console.warn('[NaiStudio] vibe 캐시 로드 실패:', error?.message ?? error);
    }
}

function saveCache() {
    try {
        const entries = [...vibeCache.entries()]
            .slice(-VIBE_CACHE_LIMIT)
            .map(([key, encoded]) => ({ key, encoded }));
        fs.writeFileSync(CACHE_FILE, JSON.stringify({ entries }), 'utf-8');
    } catch (error) {
        console.warn('[NaiStudio] vibe 캐시 저장 실패:', error?.message ?? error);
    }
}

loadCache();

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function isV4Model(model) {
    return typeof model === 'string' && model.includes('nai-diffusion-4');
}

function calculateSkipCfgAboveSigma(width, height, model) {
    const magic = model?.includes('nai-diffusion-4-5') ? SIGMA_MAGIC_NUMBER_V4_5 : SIGMA_MAGIC_NUMBER;
    return Math.pow((width * height) / REFERENCE_PIXEL_COUNT, 0.5) * magic;
}

function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
}

/** NAI 공식 클라이언트가 쓰는 5×5 격자 */
const CENTER_STEPS = [0.1, 0.3, 0.5, 0.7, 0.9];
const CENTER_LAYOUTS = { 1: [2], 2: [1, 3], 3: [1, 2, 3], 4: [0, 1, 3, 4], 5: [0, 1, 2, 3, 4] };

function snapCenterValue(value) {
    const number = Number(value);
    if (!Number.isFinite(number)) return 0.5;
    return CENTER_STEPS.reduce((best, step) =>
        Math.abs(step - number) < Math.abs(best - number) ? step : best, CENTER_STEPS[2]);
}

function normalizeCenter(center, index = 0, total = 1) {
    const x = Number(center?.x);
    const y = Number(center?.y);
    if (Number.isFinite(x) && Number.isFinite(y)) {
        return { x: snapCenterValue(x), y: snapCenterValue(y) };
    }
    const layout = CENTER_LAYOUTS[Math.min(5, Math.max(1, total))] ?? CENTER_LAYOUTS[5];
    return { x: CENTER_STEPS[layout[index % layout.length]], y: 0.5 };
}

function normalizeCharacters(list) {
    if (!Array.isArray(list)) return [];
    return list
        .map(item => (typeof item === 'string' ? { prompt: item } : item))
        .filter(item => item && item.enabled !== false && String(item.prompt ?? '').trim())
        .map((item, index, array) => ({
            prompt: String(item.prompt).trim(),
            uc: String(item.uc ?? '').trim(),
            center: normalizeCenter(item.center, index, array.length),
            enabled: true,
        }));
}

function isConcurrentLock(status, text) {
    return status === 429 && String(text ?? '').includes('Concurrent generation is locked');
}

async function fetchWithRetry(url, options) {
    for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
        const result = await fetch(url, options);
        if (result.ok) return { result, errorText: '' };

        const errorText = await result.text();
        if (!isConcurrentLock(result.status, errorText) || attempt === RETRY_DELAYS_MS.length) {
            return { result, errorText };
        }

        console.warn(`[NaiStudio] NAI 생성 잠김, ${RETRY_DELAYS_MS[attempt]}ms 후 재시도 (${attempt + 1}/${RETRY_DELAYS_MS.length})`);
        await sleep(RETRY_DELAYS_MS[attempt]);
    }
    throw new Error('재시도 루프 이탈');
}

async function encodeVibe(imageB64, model, key) {
    const cacheKey = crypto.createHash('sha256').update(`${model}|${imageB64}`).digest('hex');
    if (vibeCache.has(cacheKey)) return vibeCache.get(cacheKey);

    const response = await fetch(`${IMAGE_NOVELAI}/ai/encode-vibe`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ image: imageB64, model, informationExtracted: 1.0 }),
    });

    if (!response.ok) {
        throw new Error(`encode-vibe ${response.status}: ${await response.text()}`);
    }

    const encoded = Buffer.from(await response.arrayBuffer()).toString('base64');
    vibeCache.set(cacheKey, encoded);
    if (vibeCache.size > VIBE_CACHE_LIMIT) {
        vibeCache.delete(vibeCache.keys().next().value);
    }
    saveCache();
    return encoded;
}

export const info = {
    id: 'naistudio',
    name: 'NaiStudio NAI Bridge',
    description: 'NovelAI 생성 프록시 — cfg_rescale, v4 캐릭터 프롬프트, vibe transfer, director reference 지원.',
};

/**
 * @param {import('express').Router} router
 */
export async function init(router) {
    router.get('/ping', (_request, response) => {
        response.json({ ok: true, plugin: info.id, version: 1 });
    });

    router.post('/generate-image', async (request, response) => {
        const body = request.body;
        if (!body) return response.status(400).json({ ok: false, message: '빈 요청입니다.' });

        const key = readSecret(request.user.directories, SECRET_KEYS.NOVEL);
        if (!key) {
            return response.status(400).json({ ok: false, message: 'NovelAI Access Token이 설정되어 있지 않습니다.' });
        }

        try {
            const model = body.model || 'nai-diffusion-4-5-full';
            const width = Number(body.width) || 832;
            const height = Number(body.height) || 1216;
            const seed = Number.isInteger(body.seed) && body.seed >= 0
                ? body.seed
                : Math.floor(Math.random() * 9999999999);

            const characters = normalizeCharacters(body.characterPrompts);
            const useCoords = body.use_coords !== false && characters.length > 0;

            /* ── Vibe Transfer ── */
            const rawVibes = Array.isArray(body.reference_image_multiple) ? body.reference_image_multiple : [];
            const rawInfo = Array.isArray(body.reference_information_extracted_multiple) ? body.reference_information_extracted_multiple : [];
            const rawStrength = Array.isArray(body.reference_strength_multiple) ? body.reference_strength_multiple : [];

            let vibeImages = rawVibes;
            let vibeInfo = rawInfo;
            let vibeStrength = rawStrength;
            let warning = '';

            if (rawVibes.length > 0 && isV4Model(model)) {
                const encoded = [];
                const encodedInfo = [];
                const encodedStrength = [];
                const failures = [];

                for (let i = 0; i < rawVibes.length; i++) {
                    try {
                        encoded.push(await encodeVibe(rawVibes[i], model, key));
                        encodedInfo.push(typeof rawInfo[i] === 'number' ? rawInfo[i] : 1.0);
                        encodedStrength.push(typeof rawStrength[i] === 'number' ? rawStrength[i] : 0.6);
                    } catch (error) {
                        console.warn(`[NaiStudio] vibe #${i + 1} 인코딩 실패:`, error?.message ?? error);
                        failures.push(i + 1);
                    }
                }

                if (encoded.length === 0) {
                    return response.status(502).json({
                        ok: false,
                        code: 'STYLESTUDIO_VIBE_ENCODE_FAILED',
                        message: 'Vibe 이미지 인코딩에 모두 실패했습니다. 이미지를 확인하거나 Vibe를 끄고 다시 시도하세요.',
                    });
                }

                if (failures.length > 0) {
                    warning = `일부 Vibe 이미지를 건너뛰었습니다: #${failures.join(', #')}`;
                }

                vibeImages = encoded;
                vibeInfo = encodedInfo;
                vibeStrength = encodedStrength;
            }

            /* ── Director Reference (전역 + 캐릭터별을 한 번에) ── */
            const references = Array.isArray(body.director_references) && body.director_references.length > 0
                ? body.director_references
                : (body.reference_image ? [{
                    image: body.reference_image,
                    strength: body.reference_strength,
                    fidelity: body.reference_fidelity,
                    mode: body.reference_mode,
                    charIndex: null,
                }] : []);

            const usableReferences = references
                .filter(ref => typeof ref?.image === 'string' && ref.image)
                .slice(0, MAX_DIRECTOR_REFERENCES);

            const directorParams = usableReferences.length > 0 ? {
                director_reference_images: usableReferences.map(ref => ref.image),
                director_reference_descriptions: usableReferences.map((ref) => {
                    // charIndex가 있으면 그 캐릭터에 묶고, 없으면 그림 전체에 적용한다.
                    const character = Number.isInteger(ref.charIndex) ? characters[ref.charIndex] : null;
                    return {
                        use_coords: !!character,
                        use_order: false,
                        legacy_uc: false,
                        caption: {
                            base_caption: ['character&style', 'character', 'style'].includes(ref.mode)
                                ? ref.mode
                                : (character ? 'character' : 'character&style'),
                            char_captions: character
                                ? [{ char_caption: character.prompt, centers: [character.center] }]
                                : [],
                        },
                    };
                }),
                director_reference_strength_values: usableReferences.map(ref => Number(ref.strength ?? 1.0)),
                director_reference_secondary_strength_values: usableReferences.map(ref => clamp(1.0 - Number(ref.fidelity ?? 1.0), 0, 1)),
                director_reference_information_extracted: usableReferences.map(() => 1.0),
            } : {};

            if (references.length > usableReferences.length) {
                warning = [warning, `레퍼런스는 최대 ${MAX_DIRECTOR_REFERENCES}장입니다. ${references.length - usableReferences.length}장 제외됨.`]
                    .filter(Boolean).join(' / ');
            }

            const basePrompt = String(body.prompt ?? '').trim();
            const baseNegative = String(body.negative_prompt ?? '').trim();

            console.debug(`[NaiStudio] generate | model=${model} ${width}x${height} seed=${seed} chars=${characters.length} vibe=${vibeImages.length} ref=${usableReferences.length}`);

            const { result, errorText } = await fetchWithRetry(`${IMAGE_NOVELAI}/ai/generate-image`, {
                method: 'POST',
                headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    action: 'generate',
                    input: basePrompt,
                    model,
                    parameters: {
                        params_version: 3,
                        prefer_brownian: true,
                        negative_prompt: baseNegative,
                        width,
                        height,
                        scale: Number(body.scale ?? 5),
                        cfg_rescale: Number(body.cfg_rescale ?? 0),
                        seed,
                        sampler: body.sampler || 'k_euler_ancestral',
                        noise_schedule: body.scheduler || 'karras',
                        steps: Number(body.steps ?? 28),
                        n_samples: 1,
                        ucPreset: 0,
                        qualityToggle: false,
                        add_original_image: false,
                        controlnet_strength: 1,
                        deliberate_euler_ancestral_bug: false,
                        dynamic_thresholding: !!body.decrisper,
                        legacy: false,
                        legacy_v3_extend: false,
                        sm: !!body.sm,
                        sm_dyn: !!body.sm_dyn,
                        uncond_scale: 1,
                        skip_cfg_above_sigma: body.variety_boost
                            ? calculateSkipCfgAboveSigma(width, height, model)
                            : null,
                        use_coords: useCoords,
                        characterPrompts: characters,
                        reference_image_multiple: vibeImages,
                        reference_information_extracted_multiple: vibeInfo,
                        reference_strength_multiple: vibeStrength,
                        v4_prompt: {
                            caption: {
                                base_caption: basePrompt,
                                char_captions: characters.map(c => ({
                                    char_caption: c.prompt,
                                    centers: [c.center],
                                })),
                            },
                            use_coords: useCoords,
                            use_order: true,
                        },
                        v4_negative_prompt: {
                            caption: {
                                base_caption: baseNegative,
                                char_captions: characters.map(c => ({
                                    char_caption: c.uc,
                                    centers: [c.center],
                                })),
                            },
                            legacy_uc: false,
                        },
                        ...directorParams,
                    },
                }),
            });

            if (!result.ok) {
                console.warn('[NaiStudio] NAI 오류:', result.status, errorText);
                if (isConcurrentLock(result.status, errorText) || result.status === 429) {
                    return response.status(429).json({
                        ok: false,
                        code: 'STYLESTUDIO_NAI_CONCURRENT_LOCK',
                        message: 'NovelAI가 아직 이전 생성을 처리 중입니다. 잠시 후 다시 시도하세요.',
                    });
                }
                return response.status(result.status || 500).json({
                    ok: false,
                    message: errorText || result.statusText,
                });
            }

            const imageBuffer = await extractFileFromZipBuffer(await result.arrayBuffer(), '.png');
            if (!imageBuffer) {
                return response.status(500).json({ ok: false, message: 'NAI 응답에서 PNG를 찾지 못했습니다.' });
            }

            let image = imageBuffer.toString('base64');

            /* ── 업스케일 ── */
            const upscaleRatio = Number(body.upscale_ratio);
            if (Number.isFinite(upscaleRatio) && upscaleRatio > 1) {
                try {
                    const upscaleResult = await fetch(`${API_NOVELAI}/ai/upscale`, {
                        method: 'POST',
                        headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' },
                        body: JSON.stringify({ image, width, height, scale: upscaleRatio }),
                    });

                    if (!upscaleResult.ok) throw new Error(await upscaleResult.text());

                    const upscaled = await extractFileFromZipBuffer(await upscaleResult.arrayBuffer(), '.png');
                    if (upscaled) image = upscaled.toString('base64');
                } catch (error) {
                    console.warn('[NaiStudio] 업스케일 실패, 원본 반환:', error?.message ?? error);
                    warning = warning || '업스케일에 실패해서 원본을 반환했습니다.';
                }
            }

            response.setHeader('X-NaiStudio-Seed', String(seed));
            return response.json({ ok: true, image, seed: String(seed), warning: warning || undefined });
        } catch (error) {
            console.error('[NaiStudio] 프록시 오류:', error);
            return response.status(500).json({ ok: false, message: error?.message ?? String(error) });
        }
    });

    console.log('[NaiStudio] 서버 플러그인 로드됨: /api/plugins/naistudio/');
}

export async function exit() {
    saveCache();
    console.log('[NaiStudio] 서버 플러그인 종료');
}
