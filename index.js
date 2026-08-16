/**
 * StyleStudio — SillyTavern 안의 NAI 브라우저
 *
 *  · 이미지를 드롭하면 PNG 메타데이터를 읽어 프롬프트/UC/캐릭터/파라미터를 그대로 복원
 *  · 그 상태를 "그림체"로 저장해두고 언제든 다시 꺼내 씀
 *  · 패널 안에서 태그·UC·캐릭터 프롬프트를 직접 수정하며 계속 뽑기
 *
 * 참고: AutoPic (SillyGgu) 의 NAI 프록시 구조.
 */

import {
    extension_settings, getContext, eventSource, event_types, callGenericPopup, POPUP_TYPE,
} from './lib/st.js';
import {
    getSettings, save, listStyles, getStyle, upsertStyle, deleteStyle, duplicateStyle,
    allStyleTags, exportStyles, importStyles, addHistory, clearHistory, getWildcards,
    setWildcards, makeThumbnail, blobToBase64, DEFAULT_PARAMS, EXTENSION_NAME,
} from './lib/store.js';
import {
    MODELS, SAMPLERS, SCHEDULERS, SIZE_PRESETS, BASE_TAGS, isV4Model,
    normalizeTags, mergePrompts, subtractPrompt, resolvePrompt, adjustWeight, getTagRangeAtCaret, splitTags,
} from './lib/prompt-tools.js';
import { extractImageMetadata } from './lib/png-metadata.js';
import {
    buildPayload, generateImage, saveImageToServer, sendImageToChat, letterboxReference,
    pingOwnPlugin, getBackendAvailability, resetBackendAvailability, defaultCenter, BACKEND,
    isChatOpen, MAX_DIRECTOR_REFERENCES, CENTER_STEPS, snapCenter,
} from './lib/nai-client.js';

const extensionFolderPath = new URL('.', import.meta.url).pathname.replace(/\/$/, '');

/** 패널 작업 상태 (팝업이 닫혀도 유지) */
let state = null;
/** 이번 세션에서 생성한 이미지 (base64 원본 포함) */
let sessionGallery = [];
/** 뷰어에 크게 띄우고 있는 이미지의 인덱스 (0 = 가장 최근) */
let viewerIndex = 0;
let isGenerating = false;
let cancelBatch = false;
let lastSeed = '';
/** 동시에 열려 있는 패널 수 (토스트 위치 복원 타이밍용) */
let openPanelCount = 0;
/**
 * 생성 바 내부 요소 조회.
 * 바는 팝업 컨트롤 줄로 옮겨져 패널의 자식이 아니게 되므로, 패널에 직접 물려둔
 * 참조($p.data('ssBar'))로 찾는다. 전역 변수로 들고 있으면 패널을 다시 열거나
 * 닫는 순간 stale/null 이 되어 상태 갱신이 조용히 실패한다.
 */
function bar($p, selector) {
    const $bar = $p?.data('ssBar');
    return $bar?.length ? $bar.find(selector) : $p?.find(selector) ?? $();
}

/* ══════════════════════════ 상태 ══════════════════════════ */

function blankState() {
    const settings = getSettings();
    return {
        ...structuredClone(DEFAULT_PARAMS),
        ...structuredClone(settings.defaults ?? {}),
        prompt: '',
        negative: '',
        seed: '',
        characters: [],
        vibes: [],
        vibeEnabled: false,
        ref: { enabled: false, base64: '', thumb: '', strength: 1.0, fidelity: 1.0, mode: 'character&style' },
    };
}

function getState() {
    if (!state) {
        const saved = getSettings().last;
        state = saved ? { ...blankState(), ...structuredClone(saved) } : blankState();
        if (!Array.isArray(state.characters)) state.characters = [];
        if (!Array.isArray(state.vibes)) state.vibes = [];
        if (!state.ref) state.ref = blankState().ref;
    }
    return state;
}

function persistState() {
    getSettings().last = structuredClone(getState());
    save();
}

/* ══════════════════════════ 유틸 ══════════════════════════ */

function toast(type, message, title = 'StyleStudio') {
    if (typeof toastr !== 'undefined') toastr[type](message, title);
    else console.log(`[StyleStudio] ${message}`);
}

function dataUrl(base64) {
    return base64?.startsWith('data:') ? base64 : `data:image/png;base64,${base64}`;
}

function escapeHtml(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function fillSelect($select, options, selected) {
    $select.empty();
    for (const option of options) {
        const value = typeof option === 'string' ? option : option.id ?? option.value;
        const label = typeof option === 'string' ? option : option.label;
        $select.append(`<option value="${escapeHtml(value)}">${escapeHtml(label)}</option>`);
    }
    if (selected !== undefined) $select.val(selected);
}

async function fileToImageInfo(file) {
    const base64 = await blobToBase64(file);
    const thumb = await makeThumbnail(base64, 192).catch(() => '');
    return { base64, thumb };
}

/* ══════════════════════════ 패널 열기 ══════════════════════════ */

let panelHtmlCache = null;

async function openPanel() {
    if (!panelHtmlCache) {
        panelHtmlCache = await $.get(`${extensionFolderPath}/panel.html`);
    }

    const $panel = $(panelHtmlCache);
    bindPanel($panel);
    syncUiFromState($panel);

    // 패널이 열려 있는 동안에는 토스트를 위쪽으로 (하단 생성 바와 겹침 방지)
    openPanelCount++;
    $('body').addClass('ss-panel-open');

    callGenericPopup($panel, POPUP_TYPE.TEXT, '', {
        wide: true,
        large: true,
        allowVerticalScrolling: true,
        okButton: '닫기',
    }).finally(() => {
        openPanelCount = Math.max(0, openPanelCount - 1);
        if (openPanelCount === 0) $('body').removeClass('ss-panel-open');
        persistState();
    });

    mountActionBar($panel);
    refreshBackendStatus($panel);
}

/**
 * 생성 바를 팝업의 컨트롤 줄(= '닫기' 버튼과 같은 레이어)로 옮긴다.
 * 팝업 구조를 못 찾으면 패널 하단 sticky 상태로 그대로 둔다.
 */
function mountActionBar($panel, attempt = 0) {
    // 바 참조는 bindPanel에서 이미 $panel에 물려뒀다. 여기서 다시 찾지 않는다
    // (옮긴 뒤에는 $panel.find로 찾을 수 없기 때문).
    const $bar = $panel.data('ssBar');
    if (!$bar?.length) return;

    if ($bar.hasClass('ss-in-controls')) return;   // 이미 옮겼으면 끝

    const $dialog = $panel.closest('dialog, .popup, .mock-popup');
    const $controls = $dialog.find('.popup-controls, .mock-popup-controls').first();

    if (!$controls.length) {
        // 팝업이 아직 DOM에 붙기 전일 수 있으므로 몇 번 재시도
        if (attempt < 5) setTimeout(() => mountActionBar($panel, attempt + 1), 60);
        return;
    }

    $controls.addClass('ss-controls-host').prepend($bar);
    $bar.addClass('ss-in-controls');

    updateSaveHint($panel);
    updateSeedChip($panel);
}

/* ══════════════════════════ UI ↔ 상태 ══════════════════════════ */

const FIELD_MAP = {
    prompt: '#ss_prompt',
    negative: '#ss_negative',
    model: '#ss_model',
    width: '#ss_width',
    height: '#ss_height',
    steps: '#ss_steps',
    scale: '#ss_scale',
    cfg_rescale: '#ss_cfg_rescale',
    sampler: '#ss_sampler',
    scheduler: '#ss_scheduler',
    seed: '#ss_seed',
};

const CHECK_MAP = {
    variety_boost: '#ss_variety',
    decrisper: '#ss_decrisper',
    sm: '#ss_sm',
    sm_dyn: '#ss_sm_dyn',
    use_coords: '#ss_use_coords',
};

function syncUiFromState($p) {
    const s = getState();
    const settings = getSettings();

    fillSelect($p.find('#ss_model'), MODELS, s.model);
    fillSelect($p.find('#ss_sampler'), SAMPLERS, s.sampler);
    fillSelect($p.find('#ss_scheduler'), SCHEDULERS, s.scheduler);

    const $size = $p.find('#ss_size');
    $size.empty().append('<option value="">직접 입력</option>');
    for (const preset of SIZE_PRESETS) {
        $size.append(`<option value="${preset.width}x${preset.height}">${escapeHtml(preset.label)}</option>`);
    }
    $size.val(`${s.width}x${s.height}`);

    const $uc = $p.find('#ss_uc_preset');
    $uc.empty().append('<option value="">UC 프리셋…</option>');
    for (const name of Object.keys(settings.ucPresets ?? {})) {
        $uc.append(`<option value="${escapeHtml(name)}">${escapeHtml(name)}</option>`);
    }

    for (const [key, selector] of Object.entries(FIELD_MAP)) $p.find(selector).val(s[key] ?? '');
    for (const [key, selector] of Object.entries(CHECK_MAP)) $p.find(selector).prop('checked', !!s[key]);

    $p.find('#ss_vibe_enabled').prop('checked', !!s.vibeEnabled);
    $p.find('#ss_ref_enabled').prop('checked', !!s.ref?.enabled);
    $p.find('#ss_ref_mode').val(s.ref?.mode ?? 'character&style');
    $p.find('#ss_ref_strength').val(s.ref?.strength ?? 1);
    $p.find('#ss_ref_fidelity').val(s.ref?.fidelity ?? 1);
    $p.find('#ss_ref_strength_v').text(Number(s.ref?.strength ?? 1).toFixed(2));
    $p.find('#ss_ref_fidelity_v').text(Number(s.ref?.fidelity ?? 1).toFixed(2));

    $p.find('#ss_backend_select').val(settings.backend ?? 'auto');
    $p.find('#ss_auto_normalize').prop('checked', settings.autoNormalize !== false);
    $p.find('#ss_auto_save').prop('checked', settings.autoSave !== false);
    $p.find('#ss_save_folder').val(settings.saveFolder ?? 'StyleStudio');
    $p.find('#ss_keep_history').val(settings.keepHistory ?? 40);
    $p.find('#ss_wildcards').val(wildcardsToText(getWildcards()));
    updateSaveHint($p);

    renderAppliedStyle($p);
    renderCharacters($p);
    renderQuickStyles($p);
    renderStyleGrid($p);
    renderVibes($p);
    renderRef($p);
    renderGallery($p);
}

function readUiToState($p) {
    const s = getState();
    for (const [key, selector] of Object.entries(FIELD_MAP)) {
        const value = $p.find(selector).val();
        s[key] = ['width', 'height', 'steps', 'scale', 'cfg_rescale'].includes(key) ? Number(value) : value;
    }
    for (const [key, selector] of Object.entries(CHECK_MAP)) s[key] = $p.find(selector).is(':checked');
    s.vibeEnabled = $p.find('#ss_vibe_enabled').is(':checked');
    s.ref.enabled = $p.find('#ss_ref_enabled').is(':checked');
    s.ref.mode = $p.find('#ss_ref_mode').val();
    s.ref.strength = Number($p.find('#ss_ref_strength').val());
    s.ref.fidelity = Number($p.find('#ss_ref_fidelity').val());
    return s;
}

/* ══════════════════════════ 렌더러 ══════════════════════════ */

function renderCharacters($p) {
    const s = getState();
    const $wrap = $p.find('#ss_characters').empty();

    s.characters.forEach((character, index) => {
        const center = character.center ?? defaultCenter(index, s.characters.length);
        const ref = character.ref ?? {};
        const $card = $(`
            <div class="ss-char" data-index="${index}">
                <div class="ss-char-head">
                    <label class="ss-checkline"><input type="checkbox" class="ss-char-enabled" ${character.enabled !== false ? 'checked' : ''}></label>
                    <input type="text" class="text_pole ss-char-name" placeholder="캐릭터 ${index + 1}" value="${escapeHtml(character.name ?? '')}">
                    <div class="ss-char-actions">
                        <span class="ss-linkbtn ss-char-up" title="위로"><i class="fa-solid fa-arrow-up"></i></span>
                        <span class="ss-linkbtn ss-char-down" title="아래로"><i class="fa-solid fa-arrow-down"></i></span>
                        <span class="ss-linkbtn ss-char-remove" title="삭제"><i class="fa-solid fa-trash"></i></span>
                    </div>
                </div>
                <div class="ss-char-main">
                    <div class="ss-char-ref">
                        <div class="ss-char-ref-slot ${ref.base64 ? 'has-image' : ''}" title="이 캐릭터의 레퍼런스 이미지">
                            ${ref.base64
                                ? `<img src="${ref.thumb || dataUrl(ref.base64)}" alt="">`
                                : '<i class="fa-solid fa-user-plus"></i><span>레퍼런스</span>'}
                        </div>
                        <input type="file" class="ss-char-ref-input" accept="image/*" hidden>
                        ${ref.base64 ? `
                            <label class="ss-checkline"><input type="checkbox" class="ss-char-ref-enabled" ${ref.enabled !== false ? 'checked' : ''}> 사용</label>
                            <label class="ss-char-ref-range">강도
                                <input type="range" class="ss-char-ref-strength" min="0" max="1" step="0.05" value="${ref.strength ?? 1}">
                            </label>
                            <label class="ss-char-ref-range">유지
                                <input type="range" class="ss-char-ref-fidelity" min="0" max="1" step="0.05" value="${ref.fidelity ?? 1}">
                            </label>
                            <span class="ss-linkbtn ss-char-ref-clear">비우기</span>
                        ` : ''}
                    </div>
                    <div class="ss-char-texts">
                        <textarea class="text_pole textarea_compact ss-char-prompt ss-ac" rows="2" placeholder="이 캐릭터의 태그">${escapeHtml(character.prompt ?? '')}</textarea>
                        <textarea class="text_pole textarea_compact ss-char-uc" rows="1" placeholder="이 캐릭터 전용 UC (선택)">${escapeHtml(character.uc ?? '')}</textarea>
                    </div>
                </div>
                <div class="ss-char-pos">
                    <span class="ss-char-pos-label">위치</span>
                    ${centerGridHtml(center)}
                    <span class="ss-char-pos-value">${center.x.toFixed(1)} , ${center.y.toFixed(1)}</span>
                </div>
            </div>
        `);
        $wrap.append($card);
    });

    updateReferenceSummary($p);

    $p.find('#ss_char_count').text(s.characters.length ? `(${s.characters.length}명)` : '');
    const backend = getSettings().backend;
    const availability = getBackendAvailability();
    const nativeOnly = backend === BACKEND.NATIVE
        || (backend === 'auto' && availability[BACKEND.OWN] === false && availability[BACKEND.AUTOPIC] === false);
    $p.find('#ss_char_warn').prop('hidden', !(nativeOnly && s.characters.length > 0));
}

/** 지금 어떤 그림체가 적용돼 있는지 상단에 표시 */
function renderAppliedStyle($p) {
    const applied = getState().appliedStyle;
    const $chip = $p.find('#ss_applied_style');

    if (!applied?.name) {
        $chip.prop('hidden', true).empty();
        return;
    }

    $chip.prop('hidden', false).html(`
        <i class="fa-solid fa-palette"></i>
        <span class="ss-applied-name" title="${escapeHtml(applied.positive ?? '')}">${escapeHtml(applied.name)}</span>
        <span class="ss-linkbtn ss-applied-clear" title="이 그림체 태그를 프롬프트에서 빼기"><i class="fa-solid fa-xmark"></i></span>
    `);
}

/** NAI와 동일한 5×5 위치 격자 */
function centerGridHtml(center) {
    const snapped = snapCenter(center);
    const cells = [];

    for (const y of CENTER_STEPS) {
        for (const x of CENTER_STEPS) {
            const active = Math.abs(x - snapped.x) < 0.01 && Math.abs(y - snapped.y) < 0.01;
            cells.push(`<span class="ss-grid-cell${active ? ' active' : ''}" data-x="${x}" data-y="${y}" title="${x.toFixed(1)}, ${y.toFixed(1)}"></span>`);
        }
    }

    return `<div class="ss-char-grid" title="캐릭터 위치 (NAI와 동일한 5×5 격자)">${cells.join('')}</div>`;
}

/** 전역 + 캐릭터 레퍼런스가 몇 장 붙어 있는지 요약해서 보여준다 */
function updateReferenceSummary($p) {
    const s = getState();
    const globalRef = s.ref?.enabled && s.ref?.base64 ? 1 : 0;
    const charRefs = s.characters.filter(c => c.enabled !== false && c.ref?.base64 && c.ref.enabled !== false).length;
    const total = globalRef + charRefs;

    const $summary = $p.find('#ss_ref_summary');
    if (!$summary.length) return;

    if (total === 0) {
        $summary.text('레퍼런스 없음');
        $summary.removeClass('ss-warn');
        return;
    }

    $summary.text(`레퍼런스 ${total}장 (전체 ${globalRef} + 캐릭터 ${charRefs})${total > MAX_DIRECTOR_REFERENCES ? ` — ${MAX_DIRECTOR_REFERENCES}장 초과분은 전송되지 않음` : ''}`);
    $summary.toggleClass('ss-warn', total > MAX_DIRECTOR_REFERENCES);
}

function styleCardHtml(style, compact = false) {
    const thumb = style.thumb
        ? `<img src="${style.thumb}" alt="">`
        : '<div class="ss-style-nothumb"><i class="fa-solid fa-palette"></i></div>';
    const tags = (style.tags ?? []).map(t => `<span class="ss-chip">${escapeHtml(t)}</span>`).join('');

    if (compact) {
        return `<div class="ss-quick-style" data-id="${style.id}" title="${escapeHtml(style.name)}">
            ${thumb}<span>${escapeHtml(style.name)}</span>
        </div>`;
    }

    return `<div class="ss-style-card" data-id="${style.id}">
        <div class="ss-style-thumb">${thumb}
            <span class="ss-style-fav ${style.favorite ? 'on' : ''}" title="즐겨찾기"><i class="fa-solid fa-star"></i></span>
        </div>
        <div class="ss-style-body">
            <div class="ss-style-name">${escapeHtml(style.name)}</div>
            <div class="ss-style-tags">${tags}</div>
            <div class="ss-style-prompt" title="${escapeHtml(style.positive)}">${escapeHtml(style.positive.slice(0, 120))}</div>
        </div>
        <div class="ss-style-actions">
            <div class="menu_button ss-mini ss-style-apply">적용</div>
            <div class="menu_button ss-mini ss-style-apply-prompt" title="태그만 병합">태그</div>
            <div class="menu_button ss-mini ss-style-edit">편집</div>
            <div class="menu_button ss-mini ss-style-dup">복제</div>
            <div class="menu_button ss-mini caution ss-style-del">삭제</div>
        </div>
    </div>`;
}

function renderQuickStyles($p) {
    const styles = listStyles({ favoriteOnly: true });
    const list = styles.length > 0 ? styles : listStyles().slice(0, 8);
    $p.find('#ss_quick_styles').html(
        list.length
            ? list.map(s => styleCardHtml(s, true)).join('')
            : '<div class="ss-empty">저장된 그림체가 없습니다.</div>',
    );
}

function renderStyleGrid($p) {
    const query = $p.find('#ss_style_search').val() ?? '';
    const tag = $p.find('#ss_style_tag_filter').val() ?? '';
    const favoriteOnly = $p.find('#ss_style_fav_only').is(':checked');
    const styles = listStyles({ query, tag, favoriteOnly });

    const $filter = $p.find('#ss_style_tag_filter');
    const current = $filter.val();
    $filter.empty().append('<option value="">모든 태그</option>');
    for (const t of allStyleTags()) $filter.append(`<option value="${escapeHtml(t)}">${escapeHtml(t)}</option>`);
    $filter.val(current ?? '');

    $p.find('#ss_style_grid').html(
        styles.length
            ? styles.map(s => styleCardHtml(s)).join('')
            : '<div class="ss-empty">조건에 맞는 그림체가 없습니다. 이미지를 드롭해서 하나 만들어보세요.</div>',
    );
}

function renderVibes($p) {
    const s = getState();
    const $list = $p.find('#ss_vibe_list').empty();

    if (s.vibes.length === 0) {
        $list.html('<div class="ss-empty">바이브 이미지가 없습니다.</div>');
        return;
    }

    s.vibes.forEach((vibe, index) => {
        $list.append(`
            <div class="ss-vibe" data-index="${index}">
                <img src="${vibe.thumb || dataUrl(vibe.base64)}" alt="">
                <div class="ss-vibe-controls">
                    <label class="ss-checkline"><input type="checkbox" class="ss-vibe-enabled" ${vibe.enabled !== false ? 'checked' : ''}> 사용</label>
                    <label>Strength <input type="range" class="ss-vibe-strength" min="0" max="1" step="0.05" value="${vibe.strength ?? 0.6}"><span>${Number(vibe.strength ?? 0.6).toFixed(2)}</span></label>
                    <label>Info <input type="range" class="ss-vibe-info" min="0" max="1" step="0.05" value="${vibe.infoExtracted ?? 1}"><span>${Number(vibe.infoExtracted ?? 1).toFixed(2)}</span></label>
                </div>
                <span class="ss-linkbtn ss-vibe-remove"><i class="fa-solid fa-trash"></i></span>
            </div>
        `);
    });
}

function renderRef($p) {
    const ref = getState().ref;
    const $preview = $p.find('#ss_ref_preview');
    if (ref?.base64) {
        $preview.attr('src', ref.thumb || dataUrl(ref.base64)).prop('hidden', false);
    } else {
        $preview.prop('hidden', true);
    }
}

/** 상단 대형 뷰어 (NAI 브라우저처럼 결과를 크게 보여준다) */
function renderStage($p) {
    viewerIndex = Math.min(Math.max(0, viewerIndex), Math.max(0, sessionGallery.length - 1));

    const item = sessionGallery[viewerIndex];
    const $stage = $p.find('#ss_stage');
    const $image = $p.find('#ss_stage_img');

    if (!item) {
        $stage.removeAttr('data-id');
        $image.prop('hidden', true).removeAttr('src');
        $p.find('#ss_stage_empty').prop('hidden', false);
        $p.find('#ss_stage_bar, #ss_stage_prev, #ss_stage_next, #ss_stage_tip').prop('hidden', true);
        return;
    }

    $stage.attr('data-id', item.id);
    $image.attr('src', dataUrl(item.base64)).prop('hidden', false);
    $p.find('#ss_stage_empty').prop('hidden', true);
    $p.find('#ss_stage_bar, #ss_stage_tip').prop('hidden', false);
    $p.find('#ss_stage_prev').prop('hidden', viewerIndex <= 0);
    $p.find('#ss_stage_next').prop('hidden', viewerIndex >= sessionGallery.length - 1);

    $p.find('#ss_stage_info').html([
        `${viewerIndex + 1} / ${sessionGallery.length}`,
        item.seed ? `<b>seed</b> ${escapeHtml(item.seed)}` : '',
        item.path
            ? `<span title="${escapeHtml(item.path)}"><i class="fa-solid fa-hard-drive"></i> 저장됨</span>`
            : '<span class="ss-warn">미저장</span>',
    ].filter(Boolean).join(' · '));

    $p.find('#ss_recent .ss-recent-item').removeClass('active');
    $p.find(`#ss_recent .ss-recent-item[data-id="${item.id}"]`).addClass('active');
}

function renderGallery($p) {
    const html = sessionGallery.map(item => `
        <div class="ss-gitem" data-id="${item.id}">
            <img src="${dataUrl(item.base64)}" alt="">
            <div class="ss-gitem-bar">
                <span class="ss-gitem-seed" title="${item.path ? escapeHtml(item.path) : '아직 파일로 저장되지 않음'}">
                    ${item.path ? '<i class="fa-solid fa-hard-drive"></i> ' : ''}${escapeHtml(item.seed ?? '?')}
                </span>
                <span class="ss-linkbtn ss-g-insert" title="채팅에 삽입"><i class="fa-solid fa-comment-medical"></i></span>
                <span class="ss-linkbtn ss-g-download" title="다운로드"><i class="fa-solid fa-download"></i></span>
                <span class="ss-linkbtn ss-g-restore" title="이 설정 복원"><i class="fa-solid fa-rotate-left"></i></span>
                <span class="ss-linkbtn ss-g-seed" title="시드 재사용"><i class="fa-solid fa-seedling"></i></span>
                <span class="ss-linkbtn ss-g-style" title="그림체로 저장"><i class="fa-solid fa-palette"></i></span>
                <span class="ss-linkbtn ss-g-vibe" title="바이브로 등록"><i class="fa-solid fa-fingerprint"></i></span>
                <span class="ss-linkbtn ss-g-remove" title="목록에서 제거"><i class="fa-solid fa-xmark"></i></span>
            </div>
        </div>
    `).join('');

    const empty = '<div class="ss-empty">아직 생성한 이미지가 없습니다.</div>';
    $p.find('#ss_gallery').html(html || empty);
    $p.find('#ss_recent').html(sessionGallery.slice(0, 12).map(item => `
        <div class="ss-recent-item" data-id="${item.id}" title="${escapeHtml(item.seed ?? '')}">
            <img src="${item.thumb || dataUrl(item.base64)}" alt="">
        </div>
    `).join(''));

    renderStage($p);
}

/** 생성 바 / 설정 탭에 "어디에 저장되는지"를 항상 보여준다 */
function updateSaveHint($p) {
    const settings = getSettings();
    const folder = settings.saveFolder ?? 'StyleStudio';
    const path = `user/images/${folder}/`;

    $p.find('#ss_save_path').text(path);
    bar($p, '#ss_savehint')
        .html(settings.autoSave !== false
            ? `<i class="fa-solid fa-hard-drive"></i> ${escapeHtml(path)}`
            : '<i class="fa-solid fa-triangle-exclamation"></i> 자동 저장 꺼짐')
        .attr('title', settings.autoSave !== false
            ? `생성하면 ${path} 에 바로 저장됩니다`
            : '자동 저장이 꺼져 있어 패널을 닫으면 사라집니다')
        .toggleClass('ss-warn', settings.autoSave === false);
}

function updateSeedChip($p) {
    const $chip = bar($p, '#ss_lastseed');
    if (!lastSeed) return $chip.prop('hidden', true);
    $chip.prop('hidden', false).html(`<i class="fa-solid fa-seedling"></i> ${escapeHtml(lastSeed)}`);
}

async function refreshBackendStatus($p) {
    const settings = getSettings();
    const own = await pingOwnPlugin();
    const availability = getBackendAvailability();

    const label = settings.backend === 'auto'
        ? (own ? 'StyleStudio 플러그인' : (availability[BACKEND.AUTOPIC] === true ? 'AutoPic 플러그인' : 'AutoPic → ST 기본 (미확인)'))
        : settings.backend;

    $p.find('#ss_backend_status')
        .text(`백엔드: ${label}`)
        .toggleClass('ss-backend-warn', settings.backend === 'auto' && !own);

    $p.find('#ss_backend_detail').html(
        own
            ? 'StyleStudio 서버 플러그인이 설치되어 있습니다. 캐릭터 프롬프트·바이브·시드 고정 전부 사용 가능합니다.'
            : 'StyleStudio 서버 플러그인이 없습니다. AutoPic 플러그인이 있으면 그쪽을 쓰고, 없으면 ST 기본 경로로 내려갑니다(캐릭터 프롬프트/바이브 미지원). <br>설치: <code>plugins/stylestudio/</code> 에 server-plugin 내용을 복사하고 config.yaml 의 <code>enableServerPlugins: true</code>',
    );

    renderCharacters($p);
}

/* ══════════════════════════ 이벤트 바인딩 ══════════════════════════ */

function bindPanel($p) {
    /* 탭 */
    $p.on('click', '.ss-tab', function () {
        const tab = $(this).data('tab');
        $p.find('.ss-tab').removeClass('active');
        $(this).addClass('active');
        $p.find('.ss-page').removeClass('active');
        $p.find(`.ss-page[data-page="${tab}"]`).addClass('active');
    });

    /* 폼 → 상태 즉시 반영 */
    $p.on('change input', Object.values(FIELD_MAP).concat(Object.values(CHECK_MAP)).join(','), () => {
        readUiToState($p);
    });

    $p.on('change', '#ss_size', function () {
        const value = String($(this).val() ?? '');
        if (!value) return;
        const [width, height] = value.split('x').map(Number);
        $p.find('#ss_width').val(width);
        $p.find('#ss_height').val(height);
        readUiToState($p);
    });

    $p.on('change', '#ss_uc_preset', function () {
        const name = $(this).val();
        if (!name) return;
        const preset = getSettings().ucPresets?.[name];
        if (preset === undefined) return;
        $p.find('#ss_negative').val(preset);
        readUiToState($p);
        $(this).val('');
    });

    /* 프롬프트 도구 */
    $p.on('click', '#ss_prompt_normalize', () => {
        $p.find('#ss_prompt').val(normalizeTags($p.find('#ss_prompt').val()));
        $p.find('#ss_negative').val(normalizeTags($p.find('#ss_negative').val()));
        readUiToState($p);
        toast('success', '태그를 정리했습니다.');
    });

    $p.on('click', '#ss_prompt_preview', () => {
        const resolved = resolvePrompt($p.find('#ss_prompt').val(), getWildcards(), { normalize: false });
        callGenericPopup(`<div class="ss-preview"><h3>전개 결과</h3><pre>${escapeHtml(resolved)}</pre></div>`, POPUP_TYPE.TEXT);
    });

    $p.on('click', '#ss_prompt_style_merge', async () => {
        const style = await pickStyle();
        if (!style) return;
        $p.find('#ss_prompt').val(mergePrompts(style.positive, $p.find('#ss_prompt').val()));
        readUiToState($p);
        toast('success', `"${style.name}" 태그를 병합했습니다.`);
    });

    /* 가중치 조절 + 단축키 */
    $p.on('keydown', 'textarea', function (event) {
        if (event.ctrlKey && event.key === 'Enter') {
            event.preventDefault();
            bar($p, '#ss_generate').trigger('click');
            return;
        }
        if (!event.ctrlKey || (event.key !== 'ArrowUp' && event.key !== 'ArrowDown')) return;

        event.preventDefault();
        const element = this;
        const value = element.value;
        const hasSelection = element.selectionStart !== element.selectionEnd;
        const range = hasSelection
            ? { start: element.selectionStart, end: element.selectionEnd, text: value.slice(element.selectionStart, element.selectionEnd) }
            : getTagRangeAtCaret(value, element.selectionStart);
        if (!range.text.trim()) return;

        const replaced = adjustWeight(range.text, event.key === 'ArrowUp' ? 0.1 : -0.1, isV4Model(getState().model));
        element.value = value.slice(0, range.start) + replaced + value.slice(range.end);
        element.selectionStart = range.start;
        element.selectionEnd = range.start + replaced.length;
        readUiToState($p);
        syncCharacterFromDom($p);
    });

    /* 태그 자동완성 */
    bindAutocomplete($p);

    /* 캐릭터 */
    $p.on('click', '#ss_char_add', () => {
        const s = getState();
        s.characters.push({ name: '', prompt: '', uc: '', center: defaultCenter(s.characters.length, s.characters.length + 1), enabled: true });
        renderCharacters($p);
    });

    $p.on('input change', '.ss-char textarea, .ss-char input', () => syncCharacterFromDom($p));

    // 위치 격자 (NAI와 동일한 5×5)
    $p.on('click', '.ss-grid-cell', function () {
        const $cell = $(this);
        const $card = $cell.closest('.ss-char');
        const character = getState().characters[Number($card.data('index'))];
        if (!character) return;

        character.center = { x: Number($cell.data('x')), y: Number($cell.data('y')) };
        $card.find('.ss-grid-cell').removeClass('active');
        $cell.addClass('active');
        $card.find('.ss-char-pos-value').text(`${character.center.x.toFixed(1)} , ${character.center.y.toFixed(1)}`);
        persistState();
    });

    /* 캐릭터별 레퍼런스 */
    $p.on('click', '.ss-char-ref-slot', function () {
        $(this).closest('.ss-char-ref').find('.ss-char-ref-input').trigger('click');
    });

    $p.on('change', '.ss-char-ref-input', async function () {
        const file = this.files?.[0];
        this.value = '';
        if (!file) return;

        const index = Number($(this).closest('.ss-char').data('index'));
        const character = getState().characters[index];
        if (!character) return;

        const info = await fileToImageInfo(file);
        character.ref = { ...info, strength: 1.0, fidelity: 1.0, mode: 'character', enabled: true };
        renderCharacters($p);
        persistState();
        toast('success', `캐릭터 ${index + 1} 레퍼런스를 등록했습니다.`);
    });

    $p.on('click', '.ss-char-ref-clear', function () {
        const index = Number($(this).closest('.ss-char').data('index'));
        const character = getState().characters[index];
        if (!character) return;
        character.ref = null;
        renderCharacters($p);
        persistState();
    });

    $p.on('input change', '.ss-char-ref-strength, .ss-char-ref-fidelity, .ss-char-ref-enabled', function () {
        const index = Number($(this).closest('.ss-char').data('index'));
        const ref = getState().characters[index]?.ref;
        if (!ref) return;
        const $card = $(this).closest('.ss-char');
        ref.strength = Number($card.find('.ss-char-ref-strength').val());
        ref.fidelity = Number($card.find('.ss-char-ref-fidelity').val());
        ref.enabled = $card.find('.ss-char-ref-enabled').is(':checked');
        updateReferenceSummary($p);
    });

    $p.on('click', '.ss-char-remove', function () {
        const index = Number($(this).closest('.ss-char').data('index'));
        getState().characters.splice(index, 1);
        renderCharacters($p);
    });

    $p.on('click', '.ss-char-up, .ss-char-down', function () {
        const index = Number($(this).closest('.ss-char').data('index'));
        const target = $(this).hasClass('ss-char-up') ? index - 1 : index + 1;
        const characters = getState().characters;
        if (target < 0 || target >= characters.length) return;
        [characters[index], characters[target]] = [characters[target], characters[index]];
        renderCharacters($p);
    });

    /* 시드 */
    $p.on('click', '#ss_seed_lock', () => {
        if (!lastSeed) return toast('info', '아직 고정할 시드가 없습니다.');
        $p.find('#ss_seed').val(lastSeed);
        readUiToState($p);
        toast('success', `시드 ${lastSeed} 고정`);
    });
    $p.on('click', '#ss_seed_random', () => {
        $p.find('#ss_seed').val('');
        readUiToState($p);
    });

    /* 생성 — 생성 바는 팝업 컨트롤 줄로 이동하므로 바 자체에 위임하고,
       패널에서 바를 되찾을 수 있도록 참조를 물려둔다 */
    const $barElement = $p.find('.ss-actionbar');
    $p.data('ssBar', $barElement);

    $barElement.on('click', '#ss_generate', () => runGenerate($p, 1));
    $barElement.on('click', '#ss_batch', () => runGenerate($p, Math.max(2, Number(bar($p, '#ss_batch_count').val()) || 4)));
    $barElement.on('click', '#ss_batch_count', event => event.stopPropagation());

    $p.on('click', '#ss_save_as_style', () => openStyleEditor($p, styleFromCurrentState()));

    /* 메타데이터 드롭 */
    bindDropzone($p);

    /* 그림체 목록 */
    $p.on('input change', '#ss_style_search, #ss_style_tag_filter, #ss_style_fav_only', () => renderStyleGrid($p));
    $p.on('click', '#ss_style_new', () => openStyleEditor($p, null));
    $p.on('click', '#ss_style_export', () => downloadText(exportStyles(), 'stylestudio-styles.json'));
    $p.on('click', '#ss_style_import', () => $p.find('#ss_style_import_input').trigger('click'));
    $p.on('change', '#ss_style_import_input', async function () {
        const file = this.files?.[0];
        if (!file) return;
        try {
            const count = importStyles(await file.text());
            toast('success', `${count}개 그림체를 가져왔습니다.`);
            renderStyleGrid($p);
            renderQuickStyles($p);
        } catch (error) {
            toast('error', `가져오기 실패: ${error.message}`);
        }
        this.value = '';
    });

    // 적용된 그림체 해제 — 그 그림체가 넣었던 태그만 프롬프트에서 뺀다
    $p.on('click', '.ss-applied-clear', () => {
        const s = getState();
        if (!s.appliedStyle) return;
        s.prompt = subtractPrompt(s.prompt, s.appliedStyle.positive ?? '');
        s.negative = subtractPrompt(s.negative, s.appliedStyle.negative ?? '');
        const name = s.appliedStyle.name;
        s.appliedStyle = null;
        syncUiFromState($p);
        persistState();
        toast('info', `"${name}" 그림체를 해제했습니다.`);
    });

    $p.on('click', '#ss_style_import_st', () => importSillyTavernStyles($p));

    $p.on('click', '.ss-quick-style', function () {
        applyStyle($p, getStyle($(this).data('id')), 'all');
    });
    $p.on('click', '.ss-style-apply', function () {
        applyStyle($p, getStyle($(this).closest('.ss-style-card').data('id')), 'all');
    });
    $p.on('click', '.ss-style-apply-prompt', function () {
        applyStyle($p, getStyle($(this).closest('.ss-style-card').data('id')), 'prompt');
    });
    $p.on('click', '.ss-style-edit', function () {
        openStyleEditor($p, getStyle($(this).closest('.ss-style-card').data('id')));
    });
    $p.on('click', '.ss-style-dup', function () {
        duplicateStyle($(this).closest('.ss-style-card').data('id'));
        renderStyleGrid($p);
        renderQuickStyles($p);
    });
    $p.on('click', '.ss-style-del', async function () {
        const id = $(this).closest('.ss-style-card').data('id');
        const style = getStyle(id);
        const confirmed = await callGenericPopup(`"${escapeHtml(style?.name ?? '')}" 그림체를 삭제할까요?`, POPUP_TYPE.CONFIRM);
        if (!confirmed) return;
        deleteStyle(id);
        renderStyleGrid($p);
        renderQuickStyles($p);
    });
    $p.on('click', '.ss-style-fav', function (event) {
        event.stopPropagation();
        const id = $(this).closest('.ss-style-card').data('id');
        const style = getStyle(id);
        if (!style) return;
        upsertStyle({ id, favorite: !style.favorite });
        renderStyleGrid($p);
        renderQuickStyles($p);
    });

    /* 바이브 / 레퍼런스 */
    $p.on('click', '#ss_vibe_add', () => $p.find('#ss_vibe_input').trigger('click'));
    $p.on('change', '#ss_vibe_input', async function () {
        for (const file of this.files ?? []) {
            const info = await fileToImageInfo(file);
            getState().vibes.push({ ...info, strength: 0.6, infoExtracted: 1.0, enabled: true });
        }
        this.value = '';
        getState().vibeEnabled = true;
        $p.find('#ss_vibe_enabled').prop('checked', true);
        renderVibes($p);
        persistState();
    });
    $p.on('input change', '.ss-vibe input', function () {
        const $vibe = $(this).closest('.ss-vibe');
        const index = Number($vibe.data('index'));
        const vibe = getState().vibes[index];
        if (!vibe) return;
        vibe.enabled = $vibe.find('.ss-vibe-enabled').is(':checked');
        vibe.strength = Number($vibe.find('.ss-vibe-strength').val());
        vibe.infoExtracted = Number($vibe.find('.ss-vibe-info').val());
        $vibe.find('.ss-vibe-strength').next('span').text(vibe.strength.toFixed(2));
        $vibe.find('.ss-vibe-info').next('span').text(vibe.infoExtracted.toFixed(2));
    });
    $p.on('click', '.ss-vibe-remove', function () {
        getState().vibes.splice(Number($(this).closest('.ss-vibe').data('index')), 1);
        renderVibes($p);
        persistState();
    });

    $p.on('click', '#ss_ref_add', () => $p.find('#ss_ref_input').trigger('click'));
    $p.on('change', '#ss_ref_input', async function () {
        const file = this.files?.[0];
        if (!file) return;
        const info = await fileToImageInfo(file);
        Object.assign(getState().ref, info, { enabled: true });
        $p.find('#ss_ref_enabled').prop('checked', true);
        this.value = '';
        renderRef($p);
        persistState();
    });
    $p.on('click', '#ss_ref_clear', () => {
        Object.assign(getState().ref, { base64: '', thumb: '', enabled: false });
        $p.find('#ss_ref_enabled').prop('checked', false);
        renderRef($p);
        persistState();
    });
    $p.on('input', '#ss_ref_strength, #ss_ref_fidelity', () => {
        readUiToState($p);
        $p.find('#ss_ref_strength_v').text(getState().ref.strength.toFixed(2));
        $p.find('#ss_ref_fidelity_v').text(getState().ref.fidelity.toFixed(2));
    });

    $p.on('change', '#ss_ref_enabled', () => {
        readUiToState($p);
        updateReferenceSummary($p);
    });

    /* 뷰어 + 갤러리 */
    bindStage($p);
    bindGallery($p);

    /* 설정 */
    $p.on('change', '#ss_backend_select', function () {
        getSettings().backend = String($(this).val());
        save();
        refreshBackendStatus($p);
    });
    $p.on('click', '#ss_backend_recheck', () => {
        resetBackendAvailability();
        refreshBackendStatus($p);
    });
    $p.on('change', '#ss_auto_normalize', function () {
        getSettings().autoNormalize = $(this).is(':checked');
        save();
    });
    $p.on('change', '#ss_keep_history', function () {
        getSettings().keepHistory = Number($(this).val()) || 40;
        save();
    });
    $p.on('change', '#ss_auto_save', function () {
        getSettings().autoSave = $(this).is(':checked');
        save();
        updateSaveHint($p);
    });
    $p.on('change', '#ss_save_folder', function () {
        const folder = String($(this).val() ?? '').trim().replace(/[\\/:*?"<>|]/g, '') || 'StyleStudio';
        getSettings().saveFolder = folder;
        $(this).val(folder);
        save();
        updateSaveHint($p);
    });
    $p.on('click', '#ss_save_defaults', () => {
        const s = readUiToState($p);
        const defaults = {};
        for (const key of Object.keys(DEFAULT_PARAMS)) defaults[key] = s[key];
        getSettings().defaults = defaults;
        save();
        toast('success', '현재 파라미터를 기본값으로 저장했습니다.');
    });
    $p.on('click', '#ss_wildcards_save', () => {
        setWildcards(textToWildcards($p.find('#ss_wildcards').val()));
        toast('success', '와일드카드를 저장했습니다.');
    });
    $p.on('click', '#ss_history_clear', () => {
        clearHistory();
        toast('success', '히스토리를 비웠습니다.');
    });
    $p.on('click', '#ss_reset_all', async () => {
        const confirmed = await callGenericPopup('StyleStudio의 모든 설정과 저장된 그림체가 삭제됩니다. 계속할까요?', POPUP_TYPE.CONFIRM);
        if (!confirmed) return;
        delete extension_settings[EXTENSION_NAME];
        state = null;
        save();
        getSettings();
        syncUiFromState($p);
        toast('success', '초기화했습니다.');
    });
    $p.on('click', '#ss_gallery_clear', () => {
        sessionGallery = [];
        renderGallery($p);
    });
}

function syncCharacterFromDom($p) {
    const characters = getState().characters;
    $p.find('.ss-char').each(function () {
        const index = Number($(this).data('index'));
        const character = characters[index];
        if (!character) return;
        character.name = $(this).find('.ss-char-name').val();
        character.prompt = $(this).find('.ss-char-prompt').val();
        character.uc = $(this).find('.ss-char-uc').val();
        character.enabled = $(this).find('.ss-char-enabled').is(':checked');
        // 위치는 격자 클릭에서만 바뀐다 (여기서 건드리면 클릭 값이 덮어써진다)
    });
}

/* ══════════════════════════ 자동완성 ══════════════════════════ */

function tagPool() {
    const pool = new Set(BASE_TAGS);
    for (const style of getSettings().styles) {
        for (const tag of splitTags(style.positive)) pool.add(tag);
    }
    for (const entry of getSettings().history) {
        for (const tag of splitTags(entry.prompt)) pool.add(tag);
    }
    for (const name of Object.keys(getWildcards())) pool.add(`__${name}__`);
    return [...pool];
}

function bindAutocomplete($p) {
    const $box = $p.find('#ss_autocomplete');
    let target = null;
    let items = [];
    let active = -1;

    const close = () => { $box.prop('hidden', true).empty(); items = []; active = -1; };

    const render = () => {
        $box.html(items.map((tag, index) =>
            `<div class="ss-ac-item ${index === active ? 'active' : ''}" data-tag="${escapeHtml(tag)}">${escapeHtml(tag)}</div>`,
        ).join(''));
    };

    const accept = (tag) => {
        if (!target) return;
        const range = getTagRangeAtCaret(target.value, target.selectionStart);
        const before = target.value.slice(0, range.start);
        const after = target.value.slice(range.end);
        const needsComma = after.trim() === '' || after.trimStart().startsWith(',') === false;
        target.value = `${before}${tag}${needsComma ? ', ' : ''}${after}`;
        const caret = before.length + tag.length + (needsComma ? 2 : 0);
        target.setSelectionRange(caret, caret);
        target.dispatchEvent(new Event('input', { bubbles: true }));
        close();
        target.focus();
    };

    $p.on('input', '#ss_prompt, #ss_negative, .ss-char-prompt', function () {
        target = this;
        const range = getTagRangeAtCaret(this.value, this.selectionStart);
        const query = range.text.trim().toLowerCase();
        if (query.length < 2) return close();

        items = tagPool()
            .filter(tag => tag.toLowerCase().includes(query) && tag.toLowerCase() !== query)
            .sort((a, b) => a.toLowerCase().indexOf(query) - b.toLowerCase().indexOf(query) || a.length - b.length)
            .slice(0, 8);

        if (items.length === 0) return close();

        const rect = this.getBoundingClientRect();
        $box.css({ left: `${rect.left}px`, top: `${rect.bottom + 2}px`, width: `${Math.min(360, rect.width)}px` })
            .prop('hidden', false);
        active = -1;
        render();
    });

    $p.on('keydown', '#ss_prompt, #ss_negative, .ss-char-prompt', function (event) {
        if ($box.prop('hidden')) return;
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault();
            active = (active + (event.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length;
            render();
        } else if (event.key === 'Enter' || event.key === 'Tab') {
            if (active < 0) return;
            event.preventDefault();
            accept(items[active]);
        } else if (event.key === 'Escape') {
            close();
        }
    });

    $p.on('mousedown', '.ss-ac-item', function (event) {
        event.preventDefault();
        accept($(this).data('tag'));
    });

    $p.on('blur', '#ss_prompt, #ss_negative, .ss-char-prompt', () => setTimeout(close, 150));
}

/* ══════════════════════════ 메타데이터 입력 ══════════════════════════ */

let lastMetadata = null;

function bindDropzone($p) {
    const $zone = $p.find('#ss_dropzone');

    $zone.on('dragover', (event) => {
        event.preventDefault();
        $zone.addClass('dragging');
    });
    $zone.on('dragleave drop', () => $zone.removeClass('dragging'));

    $zone.on('drop', async (event) => {
        event.preventDefault();
        const file = event.originalEvent.dataTransfer?.files?.[0];
        if (file) await handleMetadataFile($p, file);
    });

    $p.on('click', '#ss_dropzone_browse', () => $p.find('#ss_dropzone_input').trigger('click'));
    $p.on('change', '#ss_dropzone_input', async function () {
        const file = this.files?.[0];
        if (file) await handleMetadataFile($p, file);
        this.value = '';
    });

    $p.on('paste', async (event) => {
        const item = [...(event.originalEvent.clipboardData?.items ?? [])].find(i => i.type.startsWith('image/'));
        if (!item) return;
        await handleMetadataFile($p, item.getAsFile());
    });

    $p.on('click', '#ss_meta_close', () => $p.find('#ss_meta_result').prop('hidden', true));
    $p.on('click', '#ss_meta_apply_all', () => applyMetadata($p, 'all'));

    $p.on('click', '#ss_meta_as_charref', async () => {
        if (!lastMetadata) return;

        const characters = getState().characters;
        let index = characters.length === 0 ? -1 : 0;

        if (characters.length > 1) {
            const $picker = $(`<div class="ss-picker-list">${characters.map((c, i) =>
                `<div class="ss-picker-row" data-index="${i}">${i + 1}. ${escapeHtml(c.name || c.prompt.slice(0, 30) || `캐릭터 ${i + 1}`)}</div>`,
            ).join('')}<div class="ss-picker-row" data-index="-1">+ 새 캐릭터로 추가</div></div>`);

            let picked = null;
            $picker.on('click', '.ss-picker-row', function () {
                picked = Number($(this).data('index'));
                $picker.find('.ss-picker-row').removeClass('selected');
                $(this).addClass('selected');
            });

            const confirmed = await callGenericPopup($picker, POPUP_TYPE.CONFIRM, '', { okButton: '붙이기' });
            if (!confirmed || picked === null) return;
            index = picked;
        }

        const ref = {
            base64: lastMetadata.base64,
            thumb: lastMetadata.thumb,
            strength: 1.0,
            fidelity: 1.0,
            mode: 'character',
            enabled: true,
        };

        if (index < 0 || !characters[index]) {
            characters.push({
                name: '',
                prompt: lastMetadata.meta?.characters?.[0]?.prompt ?? '',
                uc: '',
                center: defaultCenter(characters.length, characters.length + 1),
                enabled: true,
                ref,
            });
        } else {
            characters[index].ref = ref;
        }

        renderCharacters($p);
        persistState();
        toast('success', '캐릭터 레퍼런스로 붙였습니다.');
    });
    $p.on('click', '#ss_meta_save_style', async () => {
        if (!lastMetadata) return;
        const meta = lastMetadata.meta;
        openStyleEditor($p, {
            name: '',
            positive: meta.prompt,
            negative: meta.negative,
            params: metaToParams(meta),
            characters: meta.characters ?? [],
            thumb: lastMetadata.thumb,
        });
    });
    $p.on('click', '#ss_meta_as_vibe', () => {
        if (!lastMetadata) return;
        getState().vibes.push({
            base64: lastMetadata.base64,
            thumb: lastMetadata.thumb,
            strength: 0.6,
            infoExtracted: 1.0,
            enabled: true,
        });
        getState().vibeEnabled = true;
        renderVibes($p);
        persistState();
        toast('success', '바이브 이미지로 등록했습니다.');
    });
}

function metaToParams(meta) {
    const params = {};
    for (const key of ['model', 'width', 'height', 'steps', 'scale', 'cfg_rescale', 'sampler', 'scheduler', 'sm', 'sm_dyn', 'variety_boost', 'decrisper']) {
        if (meta[key] !== undefined && meta[key] !== '') params[key] = meta[key];
    }
    return params;
}

async function handleMetadataFile($p, file) {
    if (!file) return;

    try {
        const meta = await extractImageMetadata(file);
        const base64 = await blobToBase64(file);
        const thumb = await makeThumbnail(base64, 256).catch(() => '');
        lastMetadata = { meta, base64, thumb, name: file.name };

        const summary = meta.found
            ? [
                `<b>${meta.kind === 'novelai' ? 'NovelAI' : meta.kind.toUpperCase()}</b> 메타데이터를 읽었습니다.`,
                meta.model ? `모델 <code>${escapeHtml(meta.model)}</code>` : '',
                meta.width ? `${meta.width}×${meta.height}` : '',
                meta.steps ? `steps ${meta.steps}` : '',
                meta.scale !== undefined ? `scale ${meta.scale}` : '',
                meta.seed ? `seed ${escapeHtml(meta.seed)}` : '',
                meta.characters?.length ? `캐릭터 ${meta.characters.length}명` : '',
              ].filter(Boolean).join(' · ')
            : '<span class="ss-warn">메타데이터를 찾지 못했습니다.</span> 이미지 자체는 바이브/레퍼런스로는 사용할 수 있습니다.';

        $p.find('#ss_meta_thumb').attr('src', thumb || dataUrl(base64));
        $p.find('#ss_meta_summary').html(summary);
        $p.find('#ss_meta_result').prop('hidden', false);
    } catch (error) {
        console.error('[StyleStudio] 메타데이터 읽기 실패:', error);
        toast('error', `메타데이터 읽기 실패: ${error.message}`);
    }
}

function applyMetadata($p, mode) {
    if (!lastMetadata?.meta) return;
    const meta = lastMetadata.meta;
    const s = getState();

    if (mode === 'all' || mode === 'prompt') {
        s.prompt = meta.prompt ?? '';
        s.negative = meta.negative ?? '';
        s.characters = (meta.characters ?? []).map(c => ({ ...c, name: '', enabled: true }));
    }

    if (mode === 'all' || mode === 'params') {
        Object.assign(s, metaToParams(meta));
        if (meta.seed) s.seed = meta.seed;
    }

    syncUiFromState($p);
    persistState();
    toast('success', mode === 'prompt' ? '프롬프트를 적용했습니다.' : '메타데이터를 적용했습니다.');
}

/* ══════════════════════════ 그림체 ══════════════════════════ */

function styleFromCurrentState() {
    const s = getState();
    const params = {};
    for (const key of Object.keys(DEFAULT_PARAMS)) params[key] = s[key];

    return {
        name: '',
        positive: s.prompt,
        negative: s.negative,
        params,
        characters: structuredClone(s.characters),
        vibes: structuredClone(s.vibes),
        ref: structuredClone(s.ref),
        thumb: sessionGallery[0]?.thumb ?? '',
    };
}

/**
 * SillyTavern 기본 이미지생성 확장(sd)에 저장된 스타일을 그림체로 가져온다.
 * ST 쪽 구조: extension_settings.sd.styles = [{ name, prefix, negative }]
 * prefix 에는 보통 {prompt} 자리표시자가 들어 있다.
 */
async function importSillyTavernStyles($p) {
    const stStyles = extension_settings?.sd?.styles;

    if (!Array.isArray(stStyles) || stStyles.length === 0) {
        toast('info', 'SillyTavern 이미지생성 확장에 저장된 스타일이 없습니다.');
        return;
    }

    const existing = new Set(getSettings().styles.map(s => s.name));
    const candidates = stStyles.filter(item => item?.name && !existing.has(`[ST] ${item.name}`));

    if (candidates.length === 0) {
        toast('info', `이미 전부 가져왔습니다. (ST 스타일 ${stStyles.length}개)`);
        return;
    }

    const confirmed = await callGenericPopup(
        `SillyTavern 이미지생성 확장의 스타일 <b>${candidates.length}개</b>를 그림체로 가져올까요?<br>
         <small>${candidates.slice(0, 12).map(s => escapeHtml(s.name)).join(', ')}${candidates.length > 12 ? ' …' : ''}</small>`,
        POPUP_TYPE.CONFIRM, '', { okButton: '가져오기' },
    );
    if (!confirmed) return;

    for (const item of candidates) {
        // prefix 는 "masterpiece, {prompt}, best quality" 형태일 수 있다
        const positive = String(item.prefix ?? '')
            .split('{prompt}')
            .join(', ')
            .replace(/\s*,\s*,+/g, ',');

        upsertStyle({
            name: `[ST] ${item.name}`,
            note: 'SillyTavern 이미지생성 확장에서 가져옴',
            tags: ['ST'],
            positive: normalizeTags(positive),
            negative: normalizeTags(item.negative ?? ''),
            params: {},
            characters: [],
            vibes: [],
            ref: null,
        });
    }

    renderStyleGrid($p);
    renderQuickStyles($p);
    toast('success', `${candidates.length}개를 가져왔습니다.`);
}

async function openStyleEditor($p, style) {
    const draft = style ?? { name: '', note: '', tags: [], positive: '', negative: '', params: {}, characters: [], vibes: [], ref: null, thumb: '' };

    const $form = $(`
        <div class="ss-editor">
            <h3>${draft.id ? '그림체 편집' : '새 그림체'}</h3>
            <label>이름<input type="text" class="text_pole ss-e-name" value="${escapeHtml(draft.name)}"></label>
            <label>분류 태그 (쉼표)<input type="text" class="text_pole ss-e-tags" value="${escapeHtml((draft.tags ?? []).join(', '))}"></label>
            <label>메모<input type="text" class="text_pole ss-e-note" value="${escapeHtml(draft.note ?? '')}"></label>
            <label>그림체 프롬프트<textarea class="text_pole textarea_compact ss-e-positive" rows="4">${escapeHtml(draft.positive ?? '')}</textarea></label>
            <label>전용 UC<textarea class="text_pole textarea_compact ss-e-negative" rows="3">${escapeHtml(draft.negative ?? '')}</textarea></label>
            <div class="ss-editor-row">
                <label class="ss-checkline"><input type="checkbox" class="ss-e-with-params" ${Object.keys(draft.params ?? {}).length ? 'checked' : ''}> 파라미터 포함</label>
                <label class="ss-checkline"><input type="checkbox" class="ss-e-with-chars" ${(draft.characters ?? []).length ? 'checked' : ''}> 캐릭터 프롬프트 포함</label>
                <label class="ss-checkline"><input type="checkbox" class="ss-e-with-sources" ${(draft.vibes ?? []).length || draft.ref?.base64 ? 'checked' : ''}> 바이브/레퍼런스 포함</label>
            </div>
            <div class="ss-editor-thumb">
                ${draft.thumb ? `<img src="${draft.thumb}" alt="">` : '<div class="ss-style-nothumb"><i class="fa-solid fa-palette"></i></div>'}
                <div class="menu_button ss-mini ss-e-thumb-pick">썸네일 지정</div>
                <input type="file" class="ss-e-thumb-input" accept="image/*" hidden>
            </div>
        </div>
    `);

    let thumb = draft.thumb ?? '';
    $form.on('click', '.ss-e-thumb-pick', () => $form.find('.ss-e-thumb-input').trigger('click'));
    $form.on('change', '.ss-e-thumb-input', async function () {
        const file = this.files?.[0];
        if (!file) return;
        thumb = await makeThumbnail(await blobToBase64(file), 192);
        $form.find('.ss-editor-thumb img, .ss-editor-thumb .ss-style-nothumb')
            .replaceWith(`<img src="${thumb}" alt="">`);
    });

    const confirmed = await callGenericPopup($form, POPUP_TYPE.CONFIRM, '', { okButton: '저장', cancelButton: '취소', wide: true });
    if (!confirmed) return;

    const current = getState();
    const saved = upsertStyle({
        id: draft.id,
        name: $form.find('.ss-e-name').val() || '이름 없는 그림체',
        note: $form.find('.ss-e-note').val(),
        tags: splitTags($form.find('.ss-e-tags').val()),
        positive: $form.find('.ss-e-positive').val(),
        negative: $form.find('.ss-e-negative').val(),
        params: $form.find('.ss-e-with-params').is(':checked')
            ? (Object.keys(draft.params ?? {}).length ? draft.params : styleFromCurrentState().params)
            : {},
        characters: $form.find('.ss-e-with-chars').is(':checked')
            ? ((draft.characters ?? []).length ? draft.characters : structuredClone(current.characters))
            : [],
        vibes: $form.find('.ss-e-with-sources').is(':checked')
            ? ((draft.vibes ?? []).length ? draft.vibes : structuredClone(current.vibes))
            : [],
        ref: $form.find('.ss-e-with-sources').is(':checked')
            ? (draft.ref?.base64 ? draft.ref : structuredClone(current.ref))
            : null,
        thumb,
        favorite: draft.favorite ?? false,
    });

    renderStyleGrid($p);
    renderQuickStyles($p);
    toast('success', `"${saved.name}" 저장 완료`);
}

async function pickStyle() {
    const styles = listStyles();
    if (styles.length === 0) {
        toast('info', '저장된 그림체가 없습니다.');
        return null;
    }

    const $list = $(`<div class="ss-picker">${styles.map(s => `
        <div class="ss-picker-item" data-id="${s.id}">
            ${s.thumb ? `<img src="${s.thumb}">` : '<div class="ss-style-nothumb"><i class="fa-solid fa-palette"></i></div>'}
            <span>${escapeHtml(s.name)}</span>
        </div>`).join('')}</div>`);

    let picked = null;
    $list.on('click', '.ss-picker-item', function () {
        picked = $(this).data('id');
        $list.find('.ss-picker-item').removeClass('selected');
        $(this).addClass('selected');
    });

    const confirmed = await callGenericPopup($list, POPUP_TYPE.CONFIRM, '', { okButton: '선택', wide: true });
    return confirmed && picked ? getStyle(picked) : null;
}

/**
 * @param {'all'|'prompt'|'params'} mode
 */
function applyStyle($p, style, mode = 'all') {
    if (!style) return;
    const s = getState();

    if (mode === 'all' || mode === 'prompt') {
        // 이전에 적용한 그림체 태그는 걷어내고 새 것으로 갈아끼운다
        if (s.appliedStyle?.positive) {
            s.prompt = subtractPrompt(s.prompt, s.appliedStyle.positive);
            s.negative = subtractPrompt(s.negative, s.appliedStyle.negative ?? '');
        }
        s.prompt = mergePrompts(style.positive, s.prompt);
        if (style.negative) s.negative = mergePrompts(style.negative, s.negative);
        s.appliedStyle = { id: style.id, name: style.name, positive: style.positive, negative: style.negative };
    }

    if (mode === 'all' || mode === 'params') {
        Object.assign(s, style.params ?? {});
    }

    if (mode === 'all') {
        if ((style.characters ?? []).length) s.characters = structuredClone(style.characters);
        if ((style.vibes ?? []).length) {
            s.vibes = structuredClone(style.vibes);
            s.vibeEnabled = true;
        }
        if (style.ref?.base64) s.ref = structuredClone(style.ref);
    }

    syncUiFromState($p);
    persistState();
    toast('success', `"${style.name}" 적용`);
}

/* ══════════════════════════ 생성 ══════════════════════════ */

function setBusy($p, busy, text = '') {
    isGenerating = busy;
    // 생성 버튼은 비활성화하지 않는다 — 생성 중 다시 누르면 중단이기 때문
    const $button = bar($p, '#ss_generate');
    if (!$button.length) {
        // 여기 걸리면 바 참조가 끊긴 것 — 상태 표시가 통째로 죽는다
        console.warn('[StyleStudio] 생성 바를 찾지 못해 상태 표시를 갱신하지 못했습니다.');
    }

    $button.toggleClass('ss-busy', busy);
    bar($p, '#ss_batch').toggleClass('disabled', busy);
    bar($p, '#ss_progress').prop('hidden', !busy).text(text);
}

async function runGenerate($p, count) {
    if (isGenerating) {
        cancelBatch = true;
        toast('info', '남은 배치를 취소합니다.');
        return;
    }

    const settings = getSettings();
    const s = readUiToState($p);
    syncCharacterFromDom($p);

    if (!String(s.prompt).trim() && s.characters.length === 0) {
        return toast('warning', '프롬프트가 비어 있습니다.');
    }

    cancelBatch = false;
    setBusy($p, true, `생성 준비 중… (0/${count})`);

    const wildcards = getWildcards();
    const normalize = settings.autoNormalize !== false;
    const baseSeed = Number.isInteger(Number(s.seed)) && String(s.seed).trim() !== '' ? Number(s.seed) : null;

    // 레퍼런스(전역 + 캐릭터별)는 NAI가 허용하는 캔버스로 미리 맞춰둔다 — 매 장 반복할 필요 없음
    const preparedRef = s.ref?.enabled && s.ref?.base64
        ? { ...s.ref, base64: await letterboxReference(s.ref.base64) }
        : null;

    const preparedCharacters = [];
    for (const character of s.characters) {
        const ref = character.ref;
        preparedCharacters.push(ref?.base64 && ref.enabled !== false
            ? { ...character, ref: { ...ref, base64: await letterboxReference(ref.base64) } }
            : character);
    }

    const refCount = (preparedRef ? 1 : 0)
        + preparedCharacters.filter(c => c.enabled !== false && c.ref?.base64 && c.ref.enabled !== false).length;
    if (refCount > MAX_DIRECTOR_REFERENCES) {
        toast('warning', `레퍼런스가 ${refCount}장입니다. 앞의 ${MAX_DIRECTOR_REFERENCES}장만 전송됩니다.`);
    }

    let done = 0;
    try {
        for (let i = 0; i < count; i++) {
            if (cancelBatch) break;
            setBusy($p, true, `생성 중… (${done}/${count})`);

            const resolved = {
                ...s,
                prompt: resolvePrompt(s.prompt, wildcards, { normalize }),
                negative: resolvePrompt(s.negative, wildcards, { normalize }),
                characters: preparedCharacters.map(c => ({ ...c, prompt: resolvePrompt(c.prompt, wildcards, { normalize }) })),
                vibes: s.vibeEnabled ? s.vibes : [],
                ref: preparedRef,
                seed: baseSeed === null ? '' : baseSeed + i,   // 시드 고정 + 배치면 순차 증가
            };

            const payload = buildPayload(resolved);
            const result = await generateImage(payload, { preferred: settings.backend ?? 'auto' });

            if (result.warning) toast('warning', result.warning);

            const item = {
                id: `g_${Date.now()}_${i}`,
                base64: result.image,
                seed: String(result.seed ?? resolved.seed ?? ''),
                backend: result.backend,
                snapshot: structuredClone({
                    ...resolved,
                    vibes: [],
                    ref: null,
                    characters: resolved.characters.map(c => ({ ...c, ref: null })),
                }),
                thumb: await makeThumbnail(result.image, 192).catch(() => ''),
                path: '',
            };

            // 채팅방 유무와 관계없이 항상 같은 폴더에 저장한다
            if (settings.autoSave !== false) {
                try {
                    item.path = await saveImageToServer(item.base64, `ss_${item.seed || 'img'}`, settings.saveFolder);
                } catch (error) {
                    console.warn('[StyleStudio] 자동 저장 실패:', error);
                    toast('warning', `파일 저장 실패: ${error.message}`);
                }
            }

            lastSeed = item.seed || lastSeed;
            sessionGallery.unshift(item);
            if (sessionGallery.length > 60) sessionGallery.length = 60;
            viewerIndex = 0;   // 새로 뽑은 그림을 바로 크게 보여준다

            addHistory({
                prompt: resolved.prompt,
                negative: resolved.negative,
                seed: item.seed,
                params: Object.fromEntries(Object.keys(DEFAULT_PARAMS).map(k => [k, resolved[k]])),
                characters: resolved.characters,
            });

            renderGallery($p);
            updateSeedChip($p);
            done++;
        }

        if (done > 0) {
            const saved = settings.autoSave !== false
                ? ` · user/images/${settings.saveFolder ?? 'StyleStudio'}/ 에 저장됨`
                : '';
            toast('success', `${done}장 생성 완료 (시드 ${lastSeed || '랜덤'})${saved}`);
        }
    } catch (error) {
        console.error('[StyleStudio] 생성 실패:', error);
        toast('error', error.message ?? String(error), '생성 실패');
    } finally {
        setBusy($p, false);
        persistState();
    }
}

/* ══════════════════════════ 갤러리 동작 ══════════════════════════ */

function galleryItem($el) {
    const id = $el.closest('[data-id]').data('id');
    return sessionGallery.find(item => item.id === id);
}

function downloadText(text, filename) {
    const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** 브라우저 다운로드 (기기에 파일로 저장) */
function downloadImage(item) {
    if (!item) return;
    const link = document.createElement('a');
    link.href = dataUrl(item.base64);
    link.download = `stylestudio_${item.seed || Date.now()}.png`;
    link.click();
    toast('success', '이미지를 저장했습니다.');
}

function bindStage($p) {
    // 이미지를 누르면 바로 저장
    $p.on('click', '#ss_stage_img', () => downloadImage(sessionGallery[viewerIndex]));

    $p.on('click', '#ss_stage_prev', (event) => {
        event.stopPropagation();
        viewerIndex = Math.max(0, viewerIndex - 1);
        renderStage($p);
    });

    $p.on('click', '#ss_stage_next', (event) => {
        event.stopPropagation();
        viewerIndex = Math.min(sessionGallery.length - 1, viewerIndex + 1);
        renderStage($p);
    });

    // 썸네일을 누르면 뷰어에 띄운다
    $p.on('click', '.ss-recent-item', function () {
        const id = $(this).data('id');
        const index = sessionGallery.findIndex(item => item.id === id);
        if (index < 0) return;
        viewerIndex = index;
        renderStage($p);
    });

    // 갤러리 탭에서 누르면 뷰어로 보내고 생성 탭으로 이동
    $p.on('click', '.ss-gitem img', function () {
        const id = $(this).closest('[data-id]').data('id');
        const index = sessionGallery.findIndex(item => item.id === id);
        if (index < 0) return;
        viewerIndex = index;
        $p.find('.ss-tab[data-tab="generate"]').trigger('click');
        renderStage($p);
    });
}

function bindGallery($p) {
    $p.on('click', '.ss-g-insert', async function () {
        const item = galleryItem($(this));
        if (!item) return;

        const settings = getSettings();
        try {
            // 이미 저장돼 있으면 그 파일을 그대로 쓴다 (사본을 만들지 않는다)
            if (!item.path) {
                item.path = await saveImageToServer(item.base64, `ss_${item.seed || 'img'}`, settings.saveFolder);
                renderGallery($p);
            }

            if (!isChatOpen()) {
                toast('warning', `열려 있는 채팅이 없어 삽입은 못 했습니다. 파일은 user/images/${settings.saveFolder ?? 'StyleStudio'}/ 에 저장돼 있습니다.`);
                return;
            }

            await sendImageToChat(item.path, item.snapshot?.prompt ?? '');
            toast('success', '채팅에 삽입했습니다.');
        } catch (error) {
            toast('error', `삽입 실패: ${error.message}`);
        }
    });

    $p.on('click', '.ss-g-download', function () {
        downloadImage(galleryItem($(this)));
    });

    $p.on('click', '.ss-g-restore', function () {
        const item = galleryItem($(this));
        if (!item?.snapshot) return;
        Object.assign(getState(), structuredClone(item.snapshot));
        syncUiFromState($p);
        toast('success', '해당 이미지의 설정을 복원했습니다.');
    });

    $p.on('click', '.ss-g-seed', function () {
        const item = galleryItem($(this));
        if (!item?.seed) return toast('info', '시드 정보가 없습니다.');
        getState().seed = item.seed;
        $p.find('#ss_seed').val(item.seed);
        toast('success', `시드 ${item.seed} 적용`);
    });

    $p.on('click', '.ss-g-style', async function () {
        const item = galleryItem($(this));
        if (!item) return;
        openStyleEditor($p, {
            name: '',
            positive: item.snapshot?.prompt ?? '',
            negative: item.snapshot?.negative ?? '',
            params: Object.fromEntries(Object.keys(DEFAULT_PARAMS).map(k => [k, item.snapshot?.[k]])),
            characters: item.snapshot?.characters ?? [],
            thumb: item.thumb,
        });
    });

    $p.on('click', '.ss-g-vibe', function () {
        const item = galleryItem($(this));
        if (!item) return;
        getState().vibes.push({ base64: item.base64, thumb: item.thumb, strength: 0.6, infoExtracted: 1.0, enabled: true });
        getState().vibeEnabled = true;
        renderVibes($p);
        persistState();
        toast('success', '바이브로 등록했습니다.');
    });

    $p.on('click', '.ss-g-remove', function () {
        const item = galleryItem($(this));
        sessionGallery = sessionGallery.filter(g => g.id !== item?.id);
        renderGallery($p);
    });

    // 뷰어 이미지를 길게(우클릭) 누르면 프롬프트까지 크게 보기
    $p.on('contextmenu', '#ss_stage_img', function (event) {
        event.preventDefault();
        const item = sessionGallery[viewerIndex];
        if (!item) return;
        callGenericPopup(
            `<div class="ss-lightbox"><img src="${dataUrl(item.base64)}"><div class="ss-lightbox-meta">
                <b>seed</b> ${escapeHtml(item.seed)} · <b>backend</b> ${escapeHtml(item.backend ?? '')}
                <pre>${escapeHtml(item.snapshot?.prompt ?? '')}</pre>
            </div></div>`,
            POPUP_TYPE.TEXT, '', { wide: true, large: true, allowVerticalScrolling: true },
        );
    });
}

/* ══════════════════════════ 와일드카드 텍스트 ══════════════════════════ */

function wildcardsToText(map) {
    return Object.entries(map ?? {})
        .map(([name, list]) => `${name}: ${(list ?? []).join(' | ')}`)
        .join('\n');
}

function textToWildcards(text) {
    const map = {};
    for (const line of String(text ?? '').split('\n')) {
        const index = line.indexOf(':');
        if (index <= 0) continue;
        const name = line.slice(0, index).trim();
        const values = line.slice(index + 1).split('|').map(v => v.trim()).filter(Boolean);
        if (name && values.length) map[name] = values;
    }
    return map;
}

/* ══════════════════════════ 설정 서랍 / 초기화 ══════════════════════════ */

function createSettingsDrawer() {
    if ($('#ss_settings_container').length) return;

    $('#extensions_settings2').append(`
        <div id="ss_settings_container" class="extension_container">
            <div class="inline-drawer">
                <div class="inline-drawer-toggle inline-drawer-header">
                    <b>StyleStudio</b>
                    <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
                </div>
                <div class="inline-drawer-content">
                    <div class="ss-drawer">
                        <div class="menu_button ss-primary" id="ss_open_panel">
                            <i class="fa-solid fa-wand-magic-sparkles"></i> 스튜디오 열기
                        </div>
                        <div class="ss-hint" id="ss_drawer_status">백엔드 확인 중…</div>
                        <div class="ss-hint">
                            저장된 그림체: <span id="ss_drawer_count">0</span>개 ·
                            <a href="#" id="ss_drawer_export">내보내기</a>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    `);

    $('#ss_open_panel').on('click', openPanel);
    $('#ss_drawer_export').on('click', (event) => {
        event.preventDefault();
        downloadText(exportStyles(), 'stylestudio-styles.json');
    });

    updateDrawer();
}

async function updateDrawer() {
    const own = await pingOwnPlugin();
    $('#ss_drawer_count').text(getSettings().styles.length);
    $('#ss_drawer_status').html(own
        ? '서버 플러그인 <b>연결됨</b> — 캐릭터 프롬프트/바이브 사용 가능'
        : '서버 플러그인 <b>없음</b> — AutoPic 플러그인 또는 ST 기본 경로로 폴백');
}

function addWandMenuItem() {
    if ($('#ss_wand_item').length) return;

    const $item = $(`
        <div id="ss_wand_item" class="list-group-item flex-container flexGap5" title="StyleStudio 열기">
            <div class="fa-solid fa-palette extensionsMenuExtensionButton"></div>
            <span>StyleStudio</span>
        </div>
    `);
    $item.on('click', openPanel);

    const $menu = $('#extensionsMenu');
    if ($menu.length) $menu.append($item);
    else setTimeout(addWandMenuItem, 1000);
}

async function registerSlashCommands() {
    try {
        const [{ SlashCommand }, { SlashCommandArgument, ARGUMENT_TYPE }] = await Promise.all([
            import('../../../slash-commands/SlashCommand.js'),
            import('../../../slash-commands/SlashCommandArgument.js'),
        ]);
        const { SlashCommandParser } = await import('../../../slash-commands/SlashCommandParser.js');

        SlashCommandParser.addCommandObject(SlashCommand.fromProps({
            name: 'ssopen',
            callback: () => { openPanel(); return ''; },
            helpString: 'StyleStudio 패널을 엽니다.',
        }));

        SlashCommandParser.addCommandObject(SlashCommand.fromProps({
            name: 'ssstyle',
            callback: (_args, value) => {
                const name = String(value ?? '').trim().toLowerCase();
                const style = getSettings().styles.find(s => s.name.toLowerCase() === name);
                if (!style) return '그림체를 찾을 수 없습니다.';
                const s = getState();
                s.prompt = mergePrompts(style.positive, s.prompt);
                Object.assign(s, style.params ?? {});
                persistState();
                return style.name;
            },
            unnamedArgumentList: [
                SlashCommandArgument.fromProps({ description: '그림체 이름', typeList: [ARGUMENT_TYPE.STRING], isRequired: true }),
            ],
            helpString: '저장된 그림체를 현재 StyleStudio 상태에 적용합니다.',
        }));
    } catch (error) {
        console.debug('[StyleStudio] 슬래시 커맨드 등록 생략:', error?.message ?? error);
    }
}

/** manifest의 css 로딩이 안 된 경우를 대비한 보험 */
function ensureStyles() {
    if ($('link[href*="StyleStudio/style.css"]').length) return;
    $('head').append(`<link rel="stylesheet" href="${extensionFolderPath}/style.css">`);
}

jQuery(async () => {
    ensureStyles();
    getSettings();
    createSettingsDrawer();
    addWandMenuItem();
    registerSlashCommands();

    eventSource.on(event_types.APP_READY, () => {
        addWandMenuItem();
        updateDrawer();
    });

    console.log('[StyleStudio] 로드 완료');
});

// 디버깅/외부 연동용
window.StyleStudio = {
    open: openPanel,
    getState,
    getSettings,
    get gallery() { return sessionGallery; },
    get busy() { return isGenerating; },
    getContext,
};
